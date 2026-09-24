import { useRef, useState } from 'react';
import { rememberPoster } from '../../shared/ui';
import type { CroppedPoster } from '../../shared/ui';
import { posterTimings, reportPosterTimings } from './posterTimings';
import { usePinImage } from './usePinImage';

/** What the crop is doing right now, as far as the scene needs to know. */
export interface PosterUpload {
  /**
   * The object URL of the bytes on screen — `''` until something has been cropped in this
   * session. It is set the instant the crop lands and is never swapped for a gateway address.
   */
  localUrl: string;
  /** An upload is in flight. `만들기` waits on this rather than refusing (plan section D-3). */
  busy: boolean;
  /** The server's refusal, in the words `usePinImage` already owns; `''` when there is none. */
  problem: string;
  /** Shows the crop and starts sending it. Returns at once — nothing here is awaited. */
  start: (cropped: CroppedPoster) => void;
  /** Sends the very same bytes again. They never left memory, so nothing is re-cropped. */
  retry: () => void;
}

interface Held {
  cropped: CroppedPoster;
  url: string;
  /** Once the server has named these bytes, their URL belongs to the session and is not revoked. */
  pinned: boolean;
}

/**
 * The poster's life after the modal closes: on screen immediately, on IPFS eventually.
 *
 * It lives beside the scene rather than inside the card because two things need it and they
 * are not the same thing. The card draws the picture and the little spinner in its corner; the
 * `만들기` button needs to know that an upload is still going so that it waits for it instead
 * of telling the organiser to upload a poster they can plainly see (plan section D-3).
 *
 * The cropped blob is kept for as long as the scene is open. That is what makes a refusal
 * recoverable by one tap: the bytes never left, so `다시 올리기` is a second `pinEventImage`
 * and not a second trip through the file picker and the crop.
 */
export function usePosterUpload(onPinned: (cid: string) => void): PosterUpload {
  const { pin, problem } = usePinImage('poster');
  const [localUrl, setLocalUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const held = useRef<Held | null>(null);
  const flight = useRef<Promise<void> | null>(null);

  function send(entry: Held): void {
    setBusy(true);
    const run = (async () => {
      const at = performance.now();
      const cid = await pin(entry.cropped);
      // Refused. `problem` says which refusal it was, and the bytes stay exactly where they
      // are so that the chip below the picture can send them again.
      if (cid === '') return;
      entry.pinned = true;
      rememberPoster(cid, entry.url);
      onPinned(cid);
      // One line per poster that landed, and only in a development build. The upload figure
      // can only be taken here — this is the only place that holds both clocks (T-UX2-10).
      reportPosterTimings(posterTimings(
        entry.cropped.timings, performance.now() - at, entry.cropped.blob.size,
      ));
    })();
    flight.current = run;
    void run.finally(() => {
      // A retry that started while this one was still running owns the flag now.
      if (flight.current !== run) return;
      flight.current = null;
      setBusy(false);
    });
  }

  function start(cropped: CroppedPoster): void {
    const previous = held.current;
    // A crop the server never named is one nothing can ask for again; its URL goes with it.
    if (previous && !previous.pinned) URL.revokeObjectURL(previous.url);
    const entry: Held = { cropped, url: URL.createObjectURL(cropped.blob), pinned: false };
    held.current = entry;
    setLocalUrl(entry.url);
    send(entry);
  }

  function retry(): void {
    const entry = held.current;
    if (entry && !busy) send(entry);
  }

  return { localUrl, busy, problem, start, retry };
}
