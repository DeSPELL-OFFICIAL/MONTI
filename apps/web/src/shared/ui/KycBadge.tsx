import { useCopy } from '../i18n';

/** Level 1 is id + face confirmed; the events that ask for it ask for exactly that. */
const VERIFIED_LEVEL = 1;

/**
 * The two facts a person weighs before tapping, side by side: what this event asks of them, and
 * where they stand. One part, because they used to be two vocabularies for one idea — the event
 * said `KYC 필요` and the profile said `미인증`.
 *
 * An event that asks for nothing gets no badge at all: telling somebody they are unverified on
 * an event that never cared is noise. A signed-out visitor sees only what the event asks —
 * `/` and `/events/:id` are public routes and there is nobody yet to have a status.
 */
export function KycBadge({
  required,
  level,
  signedIn,
}: {
  required: boolean;
  level: number;
  signedIn: boolean;
}) {
  const copy = useCopy();
  if (!required) return null;
  return (
    <>
      <span className="badge">{copy.kyc.requiredBadge}</span>
      {signedIn ? (
        <span className="badge">
          {level >= VERIFIED_LEVEL ? copy.kyc.mineVerified : copy.kyc.mineUnverified}
        </span>
      ) : null}
    </>
  );
}
