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
///   2. One `LAContext` per tag is retained with a 60-second reuse duration, and the window is
///      clocked from the last SUCCESSFUL authentication rather than from when the context was
///      built. Clocking it from creation makes the window routinely shorter than 60 s — a
///      `loadKey` at app start would start the clock without ever showing a prompt.
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

    /// The per-operation reason iOS shows in the authentication sheet. `NSFaceIDUsageDescription`
    /// does NOT fill this in — that is the one-time Face ID permission string, a different thing.
    /// Leaving it empty gives the holder an unexplained prompt, and Touch ID devices may refuse
    /// the operation outright. The attendee-facing wording lives in the app's copy layer; this
    /// is the neutral product name, deliberately not a sentence to translate here.
    private static let localizedReason = "MONTI"

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
        static let keyInvalidated = "KEY_INVALIDATED"
        static let unavailable = "UNAVAILABLE"
        static let keyGenerationFailed = "KEY_GENERATION_FAILED"
        static let signFailed = "SIGN_FAILED"
    }

    /// The Secure Enclave is the only place a key can land on iOS; `strongBox` is Android's word.
    private static let backing = "secureEnclave"

    /// One context per tag, plus when its biometric last actually succeeded. `armedAt == nil`
    /// means "built but never authenticated", which has no clock to expire.
    private struct ArmedContext {
        let context: LAContext
        var armedAt: Date?
    }

    private var contexts: [String: ArmedContext] = [:]
    private let contextLock = NSLock()

    // MARK: - Plugin methods

    @objc func generateKey(_ call: CAPPluginCall) {
        guard let tag = call.getString("tag"),
              let accessControl = call.getBool("accessControl"),
              !tag.isEmpty else {
            return call.reject(Code.invalidArgument, Code.invalidArgument)
        }
        // `accessControl` true  -> attendee key: Face ID gated, unusable if biometrics change.
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
            return reject(call, accessError, tag: tag, fallback: Code.keyGenerationFailed)
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
            return reject(call, createError, tag: tag, fallback: Code.unavailable)
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
        // biometric-gated key's public half raises no prompt — and because this call never
        // authenticates, it must not touch the arming context at all (see `copyKey`).
        let (key, status) = copyKey(tag: tag, authenticating: false)
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
        let (key, status) = copyKey(tag: tag, authenticating: true)
        guard let key else { return rejectKeychain(call, status, fallback: Code.signFailed) }

        var signError: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(
            key,
            .ecdsaSignatureDigestX962SHA256,
            digest as CFData,
            &signError
        ) as Data? else {
            return reject(call, signError, tag: tag, fallback: Code.signFailed)
        }
        // The enclave authorised this signature, so a biometric succeeded at or within the reuse
        // duration of THIS moment. That is the instant the 60-second window starts from.
        markArmed(tag)
        call.resolve(["signature": base64Url(signature)])
    }

    // MARK: - Secure Enclave access

    private func applicationTag(_ tag: String) -> Data {
        Data(tag.utf8)
    }

    /// The retained context is what turns one Face ID into a 60-second window. It is kept while
    /// it has never authenticated (nothing to expire yet) or while its last success is still
    /// inside the window; past that a fresh context forces a new prompt rather than leaving a
    /// stale authorisation alive.
    private func authenticationContext(for tag: String) -> LAContext {
        contextLock.lock()
        defer { contextLock.unlock() }
        if let existing = contexts[tag] {
            let stillArmed = existing.armedAt.map {
                Date().timeIntervalSince($0) <= DeviceKeyPlugin.armWindowSeconds
            } ?? true
            if stillArmed { return existing.context }
        }
        let context = LAContext()
        context.touchIDAuthenticationAllowableReuseDuration = DeviceKeyPlugin.armWindowSeconds
        context.localizedReason = DeviceKeyPlugin.localizedReason
        contexts[tag] = ArmedContext(context: context, armedAt: nil)
        return context
    }

    /// Stamped only after the Secure Enclave actually authorised an operation.
    private func markArmed(_ tag: String) {
        contextLock.lock()
        defer { contextLock.unlock() }
        contexts[tag]?.armedAt = Date()
    }

    /// Whether this tag has ever authenticated successfully in this process. Used only to tell
    /// "this device never had usable biometrics" apart from "it had them and lost them", which
    /// are `UNAVAILABLE` and `KEY_INVALIDATED` respectively.
    private func hasArmed(_ tag: String) -> Bool {
        contextLock.lock()
        defer { contextLock.unlock() }
        return contexts[tag]?.armedAt != nil
    }

    private func copyKey(tag: String, authenticating: Bool) -> (SecKey?, OSStatus) {
        var query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: applicationTag(tag),
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true
        ]
        // Only an operation that can actually authenticate may build or reuse the context.
        // Attaching it to a lookup that never prompts would rebuild it for free and, worse,
        // restart the arming clock from a call the holder never saw.
        if authenticating {
            query[kSecUseAuthenticationContext as String] = authenticationContext(for: tag)
        }
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
        case errSecAuthFailed:
            call.reject(Code.keyInvalidated, Code.keyInvalidated)
        default:
            call.reject(fallback, fallback)
        }
    }

    private func reject(_ call: CAPPluginCall, _ error: Unmanaged<CFError>?, tag: String, fallback: String) {
        guard let cfError = error?.takeRetainedValue() else {
            return call.reject(fallback, fallback)
        }
        let code = mapped(cfError as Error as NSError, tag: tag) ?? fallback
        call.reject(code, code)
    }

    /// A dismissed prompt, a missing key and an invalidated key are recovered in completely
    /// different ways — retry, register a new key, register a new key — so they never collapse
    /// into a generic failure.
    ///
    /// Note what iOS does NOT do: changing the enrolled biometrics does not delete a
    /// `.biometryCurrentSet` keychain item. The item survives and `SecItemCopyMatching` with
    /// `kSecReturnRef` still returns the ref, because the ACL is evaluated on USE. So the
    /// invalidation surfaces here, on `SecKeyCreateSignature`, as `errSecAuthFailed` — and
    /// without this mapping `loadKey` would keep reporting a healthy key while every `sign`
    /// failed forever, with no typed signal to re-register.
    private func mapped(_ error: NSError, tag: String) -> String? {
        if error.domain == LAError.errorDomain {
            switch error.code {
            case LAError.Code.userCancel.rawValue, LAError.Code.appCancel.rawValue, LAError.Code.systemCancel.rawValue:
                return Code.userCancelled
            case LAError.Code.biometryLockout.rawValue:
                return Code.keyInvalidated
            case LAError.Code.biometryNotAvailable.rawValue:
                // Once this tag has authenticated, the hardware was there. Losing it means the
                // `.biometryCurrentSet` key can never be used again — a re-registration, not a
                // "this device has no enclave".
                return hasArmed(tag) ? Code.keyInvalidated : Code.unavailable
            case LAError.Code.biometryNotEnrolled.rawValue:
                return Code.unavailable
            default:
                return nil
            }
        }
        if error.code == Int(errSecUserCanceled) { return Code.userCancelled }
        if error.code == Int(errSecItemNotFound) { return Code.keyNotFound }
        if error.code == Int(errSecAuthFailed) { return Code.keyInvalidated }
        return nil
    }
}
