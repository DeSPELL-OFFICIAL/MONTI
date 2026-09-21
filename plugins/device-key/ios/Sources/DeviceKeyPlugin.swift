import Capacitor
import Foundation
import LocalAuthentication
import Security

/// MONTI's hardware key on iOS. The private key is created inside the Secure Enclave and never
/// leaves it: `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave` returns a handle, not
/// key material, so there is nothing here that could be exported, backed up or synced.
///
/// Two properties are safety critical and neither is negotiable:
///   1. `sign` uses `.ecdsaSignatureDigestX962SHA256`, which signs the 32 bytes it is handed
///      AS-IS. The message variant (`...MessageX962SHA256`) would hash them again and produce a
///      signature over SHA-256(digest) — something `Ticket.checkIn` can never verify.
///   2. One `LAContext` is retained across calls with a 60-second reuse duration, so the first
///      Face ID inside the window arms the key and the signature that follows does not prompt.
///      A fresh `LAContext` per call would prompt every single time.
@objc(DeviceKeyPlugin)
public class DeviceKeyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceKeyPlugin"
    public let jsName = "DeviceKey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "generateKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sign", returnType: CAPPluginReturnPromise)
    ]

    /// Mirrors ARM_WINDOW_SECONDS in apps/web/src/shared/deviceKey/types.ts and the Android
    /// `setUserAuthenticationParameters` window. `LATouchIDAuthenticationMaximumAllowableReuseDuration`
    /// caps this at 300 s, so 60 is well inside what the platform accepts.
    private static let armWindowSeconds: TimeInterval = 60

    /// The 32 bytes `Ticket.checkIn` verifies over. Anything else is refused rather than signed.
    private static let digestByteCount = 32

    /// A P-256 SubjectPublicKeyInfo (RFC 5280) is fixed except for the point, so the header is a
    /// constant: SEQUENCE SEQUENCE OID(id-ecPublicKey) OID(prime256v1) BIT STRING. The Security
    /// framework hands back the bare X9.63 point instead, so this plugin wraps it — Task 13's
    /// `spkiToXy` validates the full 91-byte SPKI and refuses anything shorter.
    private static let p256SpkiHeader: [UInt8] = [
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
        0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
    ]
    private static let x963ByteCount = 65
    private static let uncompressedPointTag: UInt8 = 0x04

    /// Error codes. These are the wire contract with src/definitions.ts; the message is the code
    /// itself so no user-facing prose lives in this file.
    private enum Code {
        static let invalidArgument = "INVALID_ARGUMENT"
        static let keyNotFound = "KEY_NOT_FOUND"
        static let userCancelled = "USER_CANCELLED"
        static let unavailable = "UNAVAILABLE"
        static let keyGenerationFailed = "KEY_GENERATION_FAILED"
        static let signFailed = "SIGN_FAILED"
    }

    /// The Secure Enclave is the only place a key can land on iOS; `strongBox` is Android's word.
    private static let backing = "secureEnclave"

    private var armedContext: LAContext?
    private var armedAt: Date?
    private let contextLock = NSLock()

    // MARK: - Plugin methods

    @objc func generateKey(_ call: CAPPluginCall) {
        guard let tag = call.getString("tag"),
              let accessControl = call.getBool("accessControl"),
              !tag.isEmpty else {
            return call.reject(Code.invalidArgument, Code.invalidArgument)
        }
        // `accessControl` true  -> attendee key: Face ID gated, destroyed if biometrics change.
        // `accessControl` false -> gate terminal key: signs unattended, must never prompt.
        // `.biometryCurrentSet` (not `.biometryAny`) is what makes an enrolled-finger change
        // invalidate the key instead of silently widening who can sign as this device.
        let flags: SecAccessControlCreateFlags = accessControl
            ? [.privateKeyUsage, .biometryCurrentSet]
            : [.privateKeyUsage]
        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            flags,
            &accessError
        ) else {
            return reject(call, accessError, fallback: Code.keyGenerationFailed)
        }

        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: applicationTag(tag),
                kSecAttrAccessControl as String: access
            ]
        ]
        var createError: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &createError) else {
            // No software fallback: a key outside the enclave would be registered on chain in the
            // same field as a real one. A device without a usable enclave simply has no key.
            return reject(call, createError, fallback: Code.unavailable)
        }
        guard let publicKey = exportPublicKey(of: privateKey) else {
            return call.reject(Code.keyGenerationFailed, Code.keyGenerationFailed)
        }
        call.resolve(["publicKey": publicKey, "backing": DeviceKeyPlugin.backing])
    }

    @objc func loadKey(_ call: CAPPluginCall) {
        guard let tag = call.getString("tag"), !tag.isEmpty else {
            return call.reject(Code.invalidArgument, Code.invalidArgument)
        }
        // `kSecReturnRef` hands back a handle without exercising the access control, so reading a
        // biometric-gated key's public half raises no prompt. Only `sign` authenticates.
        let (key, status) = copyKey(tag: tag)
        guard let key else { return rejectKeychain(call, status, fallback: Code.unavailable) }
        // NOT keyNotFound: the key is there, only unreadable. `KEY_NOT_FOUND` is the code that
        // authorises minting a replacement, and replacing a key already registered on chain
        // cannot be undone.
        guard let publicKey = exportPublicKey(of: key) else {
            return call.reject(Code.unavailable, Code.unavailable)
        }
        call.resolve(["publicKey": publicKey, "backing": DeviceKeyPlugin.backing])
    }

    @objc func sign(_ call: CAPPluginCall) {
        guard let tag = call.getString("tag"),
              let data = call.getString("data"),
              !tag.isEmpty else {
            return call.reject(Code.invalidArgument, Code.invalidArgument)
        }
        // Refusing a wrong-length input is the cheap half of defect 3's fix: the digest variant
        // below would otherwise pad or truncate silently and sign the wrong message.
        guard let digest = decodeBase64Url(data), digest.count == DeviceKeyPlugin.digestByteCount else {
            return call.reject(Code.invalidArgument, Code.invalidArgument)
        }
        let (key, status) = copyKey(tag: tag)
        guard let key else { return rejectKeychain(call, status, fallback: Code.signFailed) }

        var signError: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(
            key,
            .ecdsaSignatureDigestX962SHA256,
            digest as CFData,
            &signError
        ) as Data? else {
            return reject(call, signError, fallback: Code.signFailed)
        }
        call.resolve(["signature": base64Url(signature)])
    }

    // MARK: - Secure Enclave access

    private func applicationTag(_ tag: String) -> Data {
        Data(tag.utf8)
    }

    /// The retained context is what turns one Face ID into a 60-second window. It is reused only
    /// while it is still inside that window; past it a fresh context forces a new prompt rather
    /// than leaving a stale authorisation alive.
    private func authenticationContext() -> LAContext {
        contextLock.lock()
        defer { contextLock.unlock() }
        if let context = armedContext, let createdAt = armedAt,
           Date().timeIntervalSince(createdAt) < DeviceKeyPlugin.armWindowSeconds {
            return context
        }
        let context = LAContext()
        context.touchIDAuthenticationAllowableReuseDuration = DeviceKeyPlugin.armWindowSeconds
        armedContext = context
        armedAt = Date()
        return context
    }

    private func copyKey(tag: String) -> (SecKey?, OSStatus) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: applicationTag(tag),
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
            kSecUseAuthenticationContext as String: authenticationContext()
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let item, CFGetTypeID(item) == SecKeyGetTypeID() else {
            return (nil, status)
        }
        // Safe: the type ID check above is what makes this cast total.
        return ((item as! SecKey), status)
    }

    /// `SecKeyCopyExternalRepresentation` returns the bare X9.63 point `04 || x || y`, not an
    /// SPKI, so the constant header goes back on before this crosses the bridge.
    private func exportPublicKey(of privateKey: SecKey) -> String? {
        guard let publicKey = SecKeyCopyPublicKey(privateKey),
              let point = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?,
              point.count == DeviceKeyPlugin.x963ByteCount,
              point.first == DeviceKeyPlugin.uncompressedPointTag else {
            return nil
        }
        return base64Url(Data(DeviceKeyPlugin.p256SpkiHeader) + point)
    }

    // MARK: - Encoding

    /// base64url, unpadded, no line breaks — the wire shape `base64UrlDecode` in @monti/shared
    /// expects on the other side.
    private func base64Url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func decodeBase64Url(_ text: String) -> Data? {
        var normalised = text
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        normalised += String(repeating: "=", count: (4 - normalised.count % 4) % 4)
        return Data(base64Encoded: normalised)
    }

    // MARK: - Error mapping

    /// `fallback` is the caller's own name for "the keychain refused for some other reason" —
    /// a locked device, a denied entitlement. It is never `keyNotFound`, because only a genuine
    /// `errSecItemNotFound` may tell the TS side it is safe to mint a key.
    private func rejectKeychain(_ call: CAPPluginCall, _ status: OSStatus, fallback: String) {
        switch status {
        case errSecItemNotFound:
            call.reject(Code.keyNotFound, Code.keyNotFound)
        case errSecUserCanceled:
            call.reject(Code.userCancelled, Code.userCancelled)
        default:
            call.reject(fallback, fallback)
        }
    }

    private func reject(_ call: CAPPluginCall, _ error: Unmanaged<CFError>?, fallback: String) {
        guard let cfError = error?.takeRetainedValue() else {
            return call.reject(fallback, fallback)
        }
        let code = mapped(cfError as Error as NSError) ?? fallback
        call.reject(code, code)
    }

    /// A dismissed prompt and a missing key are recoverable in completely different ways — one
    /// is retried, the other means this device must register a new key — so they never collapse
    /// into a generic failure. iOS has no separate "invalidated" status: changing the enrolled
    /// biometrics destroys a `.biometryCurrentSet` key outright, which surfaces here as
    /// `errSecItemNotFound` and is the honest answer.
    private func mapped(_ error: NSError) -> String? {
        if error.domain == LAError.errorDomain {
            switch error.code {
            case LAError.userCancel.rawValue, LAError.appCancel.rawValue, LAError.systemCancel.rawValue:
                return Code.userCancelled
            case LAError.biometryNotEnrolled.rawValue, LAError.biometryNotAvailable.rawValue:
                return Code.unavailable
            default:
                return nil
            }
        }
        if error.code == Int(errSecUserCanceled) { return Code.userCancelled }
        if error.code == Int(errSecItemNotFound) { return Code.keyNotFound }
        return nil
    }
}
