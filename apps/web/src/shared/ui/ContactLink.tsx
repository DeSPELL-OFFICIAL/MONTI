import { useCopy } from '../i18n';

/**
 * The one place the support address reaches a screen. It is a copy key rather than a literal
 * so that changing the address is a one-line edit in `copy/ko.ts` and `copy/en.ts` instead of
 * a grep across the app, and so that `pnpm lint:copy` reads it like every other sentence.
 *
 * `mailto:` is the whole interaction: the attendee app has no ticketing inbox of its own, and
 * a screen that says "contact us" without giving something to tap is a dead end.
 */
export function ContactLink() {
  const copy = useCopy();
  return (
    <p>
      {copy.common.contactHelp}
      <br />
      <a href={`mailto:${copy.common.contactEmail}`}>{copy.common.contactEmail}</a>
    </p>
  );
}
