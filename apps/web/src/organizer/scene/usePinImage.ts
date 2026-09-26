import { useState } from 'react';
import type { CroppedPoster } from '../../shared/ui';
import { api, callableFailure } from '../../shared/api/functions';
import { useOrganizerCopy, type OrganizerCopy } from '../copy';

type ImageProblem = keyof OrganizerCopy['scene']['imageProblems'];

/**
 * The server's reason codes against the sentence each one deserves (task-ev-b report §3.1).
 * Anything not listed — `PIN_FAILED`, a dropped connection, `BAD_IMAGE` — is the retryable
 * one, because that is what every unlisted case actually is.
 */
const IMAGE_PROBLEMS: Readonly<Record<string, ImageProblem>> = {
  IMAGE_TOO_LARGE: 'tooLarge',
  BAD_IMAGE_FORMAT: 'format',
  BAD_IMAGE_DIMENSIONS: 'dimensions',
  PIN_QUOTA: 'quota',
  NOT_ACTIVE: 'notActive',
  NO_SIGNUP: 'notActive',
};

export interface PinImageState {
  /** The CID, or `''` when the server refused — in which case {@link problem} says why. */
  pin: (cropped: CroppedPoster) => Promise<string>;
  busy: boolean;
  problem: string;
}

/**
 * One cropped picture on its way to `pinEventImage`, shared by the poster card and the ticket
 * art picker so that both know the same refusals by the same names. The caps differ by `kind`
 * (600 KB for a poster, 400 KB for a ticket) but the reasons do not.
 *
 * It never throws: a refusal is a sentence under the frame, not an exception for the cropper's
 * own catch to swallow into "that did not work".
 */
export function usePinImage(kind: 'poster' | 'ticket'): PinImageState {
  const copy = useOrganizerCopy().scene;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  async function pin(cropped: CroppedPoster): Promise<string> {
    setBusy(true);
    setProblem('');
    try {
      const { cid } = await api.pinEventImage({ bytesBase64: cropped.base64, kind });
      return cid;
    } catch (cause) {
      const { reason } = callableFailure(cause);
      setProblem(copy.imageProblems[IMAGE_PROBLEMS[reason] ?? 'failed']);
      return '';
    } finally {
      setBusy(false);
    }
  }

  return { pin, busy, problem };
}
