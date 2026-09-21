package app.monti.devicekey

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * MONTI's hardware key on Android. The private key is generated inside the AndroidKeyStore and
 * is never exportable; StrongBox is asked for first and the TEE is the only allowed fallback.
 *
 * Three properties are safety critical:
 *   1. `sign` uses `NONEwithECDSA`, which signs the 32 bytes it is handed AS-IS.
 *      `SHA256withECDSA` would hash them again and produce a signature over SHA-256(digest) —
 *      something `Ticket.checkIn` can never verify.
 *   2. `setUserAuthenticationParameters(60, AUTH_BIOMETRIC_STRONG)` is time-based, not
 *      per-operation, so one successful BiometricPrompt arms the key for the next 60 seconds.
 *      That is why the prompt here carries no CryptoObject: a CryptoObject would bind the
 *      authorisation to a single signature and the window would be meaningless.
 *   3. A StrongBox downgrade is REPORTED (`backing: "tee"`), never silent. The vendor plugin
 *      this replaces downgraded quietly, which let a TEE key be registered on chain as if it
 *      were StrongBox-backed.
 */
@CapacitorPlugin(name = "DeviceKey")
class DeviceKeyPlugin : Plugin() {

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"

        /** Mirrors ARM_WINDOW_SECONDS in apps/web/src/shared/deviceKey/types.ts and the iOS LAContext. */
        const val ARM_WINDOW_SECONDS = 60

        /** The 32 bytes `Ticket.checkIn` verifies over. Anything else is refused, not signed. */
        const val DIGEST_BYTES = 32

        /** base64url, unpadded, no line breaks — what `base64UrlDecode` in @monti/shared expects. */
        const val BASE64_FLAGS = Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING

        const val BACKING_STRONGBOX = "strongBox"
        const val BACKING_TEE = "tee"

        // Wire contract with src/definitions.ts. The message is the code itself, so no
        // user-facing prose lives in this file; the prompt copy comes from res/values.
        const val INVALID_ARGUMENT = "INVALID_ARGUMENT"
        const val KEY_NOT_FOUND = "KEY_NOT_FOUND"
        const val USER_CANCELLED = "USER_CANCELLED"
        const val KEY_INVALIDATED = "KEY_INVALIDATED"
        const val UNAVAILABLE = "UNAVAILABLE"
        const val KEY_GENERATION_FAILED = "KEY_GENERATION_FAILED"
        const val SIGN_FAILED = "SIGN_FAILED"
    }

    private val keyStore: KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    // MARK: - Plugin methods

    @PluginMethod
    fun generateKey(call: PluginCall) {
        val tag = call.getString("tag")?.takeIf { it.isNotEmpty() }
            ?: return call.reject(INVALID_ARGUMENT, INVALID_ARGUMENT)
        // Both flags are required rather than defaulted: a missing `accessControl` silently
        // defaulting either way would mint a key whose protection nobody asked for.
        val accessControl = call.getBoolean("accessControl")
            ?: return call.reject(INVALID_ARGUMENT, INVALID_ARGUMENT)
        val strongBox = call.getBoolean("strongBox")
            ?: return call.reject(INVALID_ARGUMENT, INVALID_ARGUMENT)

        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        val backing = try {
            if (strongBox) {
                generateWithStrongBoxFallback(generator, tag, accessControl)
            } else {
                generateIn(generator, tag, accessControl, strongBox = false)
                BACKING_TEE
            }
        } catch (_: Exception) {
            // No software fallback: a key outside secure hardware would be registered on chain
            // in the same field as a real one.
            return call.reject(KEY_GENERATION_FAILED, KEY_GENERATION_FAILED)
        }
        val publicKey = keyStore.getCertificate(tag)?.publicKey
            ?: return call.reject(KEY_GENERATION_FAILED, KEY_GENERATION_FAILED)
        call.resolve(
            JSObject()
                .put("publicKey", encode(publicKey.encoded))
                .put("backing", backing),
        )
    }

    @PluginMethod
    fun loadKey(call: PluginCall) {
        val tag = call.getString("tag")?.takeIf { it.isNotEmpty() }
            ?: return call.reject(INVALID_ARGUMENT, INVALID_ARGUMENT)
        // Reading the public half raises no biometric prompt; only `sign` authenticates.
        val privateKey = keyStore.getKey(tag, null) as? PrivateKey
            ?: return call.reject(KEY_NOT_FOUND, KEY_NOT_FOUND)
        // NOT KEY_NOT_FOUND: the key is there, only its public half is unreadable.
        // KEY_NOT_FOUND is the code that authorises minting a replacement, and replacing a key
        // already registered on chain cannot be undone.
        val publicKey = keyStore.getCertificate(tag)?.publicKey
            ?: return call.reject(UNAVAILABLE, UNAVAILABLE)
        call.resolve(
            JSObject()
                .put("publicKey", encode(publicKey.encoded))
                .put("backing", backingOf(privateKey)),
        )
    }

    @PluginMethod
    fun sign(call: PluginCall) {
        val tag = call.getString("tag")?.takeIf { it.isNotEmpty() }
            ?: return call.reject(INVALID_ARGUMENT, INVALID_ARGUMENT)
        val data = call.getString("data")
            ?: return call.reject(INVALID_ARGUMENT, INVALID_ARGUMENT)
        val digest = try {
            Base64.decode(data, BASE64_FLAGS)
        } catch (_: IllegalArgumentException) {
            return call.reject(INVALID_ARGUMENT, INVALID_ARGUMENT)
        }
        // `NONEwithECDSA` below signs whatever length it is given, so a wrong-sized input would
        // become a valid signature over the wrong message. Refuse it here instead.
        if (digest.size != DIGEST_BYTES) return call.reject(INVALID_ARGUMENT, INVALID_ARGUMENT)

        val privateKey = keyStore.getKey(tag, null) as? PrivateKey
            ?: return call.reject(KEY_NOT_FOUND, KEY_NOT_FOUND)
        val signature = try {
            signDigest(privateKey, digest)
        } catch (_: UserNotAuthenticatedException) {
            // The 60-second window has lapsed (or never opened). One prompt re-arms the key and
            // the retry inside then signs without prompting again.
            return promptThenRetry(call, privateKey, digest)
        } catch (_: KeyPermanentlyInvalidatedException) {
            return call.reject(KEY_INVALIDATED, KEY_INVALIDATED)
        } catch (_: Exception) {
            return call.reject(SIGN_FAILED, SIGN_FAILED)
        }
        call.resolve(JSObject().put("signature", encode(signature)))
    }

    // MARK: - Key generation

    /**
     * StrongBox first, TEE only when this device has no StrongBox. `StrongBoxUnavailableException`
     * is caught on its own — a broad catch here would turn a real failure (bad spec, missing
     * biometrics) into a silent security downgrade.
     */
    private fun generateWithStrongBoxFallback(
        generator: KeyPairGenerator,
        tag: String,
        accessControl: Boolean,
    ): String = try {
        generateIn(generator, tag, accessControl, strongBox = true)
        BACKING_STRONGBOX
    } catch (_: StrongBoxUnavailableException) {
        generateIn(generator, tag, accessControl, strongBox = false)
        BACKING_TEE
    }

    private fun generateIn(
        generator: KeyPairGenerator,
        tag: String,
        accessControl: Boolean,
        strongBox: Boolean,
    ) {
        generator.initialize(spec(tag, accessControl, strongBox))
        generator.generateKeyPair()
    }

    private fun spec(tag: String, accessControl: Boolean, strongBox: Boolean): KeyGenParameterSpec =
        KeyGenParameterSpec.Builder(tag, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            // SHA-256 is declared so the key accepts a 32-byte digest; the signing algorithm
            // stays NONEwithECDSA, which is what keeps the digest un-rehashed.
            .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
            .apply {
                if (accessControl) {
                    setUserAuthenticationRequired(true)
                    setUserAuthenticationParameters(ARM_WINDOW_SECONDS, KeyProperties.AUTH_BIOMETRIC_STRONG)
                    // A new fingerprint enrolment must not silently widen who can sign as this
                    // device, so the key is destroyed instead.
                    setInvalidatedByBiometricEnrollment(true)
                } else {
                    // Gate terminal key: signs unattended and must never raise a prompt.
                    setUserAuthenticationRequired(false)
                }
            }
            .setIsStrongBoxBacked(strongBox)
            .build()

    /** Read back from the key itself, never assumed from what was requested. */
    private fun backingOf(privateKey: PrivateKey): String {
        val factory = KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE)
        val info = factory.getKeySpec(privateKey, KeyInfo::class.java)
        return if (info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX) BACKING_STRONGBOX
        else BACKING_TEE
    }

    // MARK: - Signing

    private fun signDigest(privateKey: PrivateKey, digest: ByteArray): ByteArray =
        Signature.getInstance("NONEwithECDSA").run {
            initSign(privateKey)
            update(digest)
            sign()
        }

    /**
     * No CryptoObject is passed on purpose. With time-based `setUserAuthenticationParameters`
     * the Keystore grants the key for 60 s on ANY successful strong biometric, so a bare prompt
     * arms it; a CryptoObject would instead authorise exactly one operation and the arming
     * window that the attendee flow depends on would never exist.
     */
    private fun promptThenRetry(call: PluginCall, privateKey: PrivateKey, digest: ByteArray) {
        // Capacitor's activity is an AppCompatActivity, i.e. already a FragmentActivity; the
        // only case worth guarding is the bridge not being attached at all.
        val host: FragmentActivity = activity ?: return call.reject(UNAVAILABLE, UNAVAILABLE)
        host.runOnUiThread {
            val prompt = BiometricPrompt(
                host,
                ContextCompat.getMainExecutor(host),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        val signature = try {
                            signDigest(privateKey, digest)
                        } catch (_: KeyPermanentlyInvalidatedException) {
                            return call.reject(KEY_INVALIDATED, KEY_INVALIDATED)
                        } catch (_: Exception) {
                            return call.reject(SIGN_FAILED, SIGN_FAILED)
                        }
                        call.resolve(JSObject().put("signature", encode(signature)))
                    }

                    override fun onAuthenticationError(code: Int, message: CharSequence) {
                        val mapped = errorCodeFor(code)
                        call.reject(mapped, mapped)
                    }
                },
            )
            prompt.authenticate(promptInfo(host))
        }
    }

    /** Prompt copy lives in res/values so this file holds no user-facing strings. */
    private fun promptInfo(host: FragmentActivity): BiometricPrompt.PromptInfo =
        BiometricPrompt.PromptInfo.Builder()
            .setTitle(host.getString(R.string.device_key_prompt_title))
            .setSubtitle(host.getString(R.string.device_key_prompt_subtitle))
            .setNegativeButtonText(host.getString(R.string.device_key_prompt_cancel))
            // Strong biometrics only: this must match AUTH_BIOMETRIC_STRONG on the key, or the
            // authentication would succeed without unlocking it.
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .build()

    /** A dismissed prompt is retried; a device without usable biometrics never will be. */
    private fun errorCodeFor(code: Int): String = when (code) {
        BiometricPrompt.ERROR_USER_CANCELED,
        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
        BiometricPrompt.ERROR_CANCELED,
        -> USER_CANCELLED
        BiometricPrompt.ERROR_NO_BIOMETRICS,
        BiometricPrompt.ERROR_HW_NOT_PRESENT,
        BiometricPrompt.ERROR_HW_UNAVAILABLE,
        -> UNAVAILABLE
        else -> SIGN_FAILED
    }

    // MARK: - Encoding

    private fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, BASE64_FLAGS)
}
