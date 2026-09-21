// The ONLY file that touches @capgo/capacitor-passkey. Shapes come from the plugin's own
// types (node_modules/@capgo/capacitor-passkey/dist/esm/definitions.d.ts), so a plugin
// upgrade that moves a field is a tsc error here instead of a runtime surprise. No casts.
//
// signalAllAcceptedCredentials is deliberately absent: the plugin has no such method and
// the iOS 26 WebAuthn signal APIs must never be called (Global Constraints).
import {
  CapacitorPasskey,
  type PasskeyAuthenticationCredential,
  type PasskeyPublicKeyCredentialCreationOptionsJSON,
  type PasskeyPublicKeyCredentialRequestOptionsJSON,
  type PasskeyRegistrationCredential,
} from '@capgo/capacitor-passkey';

export type {
  PasskeyAuthenticationCredential,
  PasskeyPublicKeyCredentialCreationOptionsJSON,
  PasskeyPublicKeyCredentialRequestOptionsJSON,
  PasskeyRegistrationCredential,
};

/** `CapacitorPasskey.createCredential` takes the JSON request nested under `publicKey`. */
export function createCredentialNative(
  publicKey: PasskeyPublicKeyCredentialCreationOptionsJSON,
): Promise<PasskeyRegistrationCredential> {
  return CapacitorPasskey.createCredential({ publicKey });
}

export function getCredentialNative(
  publicKey: PasskeyPublicKeyCredentialRequestOptionsJSON,
): Promise<PasskeyAuthenticationCredential> {
  return CapacitorPasskey.getCredential({ publicKey });
}
