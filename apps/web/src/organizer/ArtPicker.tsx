import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { A4Cropper, TicketArt } from '../shared/ui';
import type { CroppedPoster, TicketArtPreset, TicketArtSource } from '../shared/ui';
import { useOrganizerCopy, type OrganizerCopy } from './copy';
import { TICKET_ART_PRESETS } from './scene/draftRules';
import { usePinImage } from './scene/usePinImage';

/**
 * One name per letter, out of a record typed `Record<TicketArtPreset, string>` — so a locale
 * that gains a preset and forgets to name it fails the build rather than the screen. The
 * if-chain this replaced could only ever have covered four.
 */
export function presetLabel(copy: OrganizerCopy['scene']['tiers'], preset: TicketArtPreset): string {
  return copy.artNames[preset];
}

export interface ArtPickerProps {
  /** What the kind carries now — one of the twelve letters, or a picture of the organiser's own. */
  art: TicketArtSource;
  /**
   * The event title and the kind's own name, drawn on every tile: each slide is the real ticket
   * an attendee will be handed, not a swatch of the backdrop (plan section C-1). A blank holder
   * or date simply draws no such line, the same as the big preview above the carousel.
   */
  title: string;
  tierName: string;
  holder?: string;
  dateText?: string;
  onPreset: (preset: TicketArtPreset) => void;
  /** The CID `pinEventImage` gave back for the picture that was just cropped. */
  onUploaded: (imageCid: string) => void;
}

/**
 * The twelve bundled backdrops and the way to upload a thirteenth, as a horizontal scroll-snap
 * carousel of live ticket previews (plan section C). Two screens offer exactly this choice:
 * SCENE 2's kind card, before the event exists, and the event's own screen afterwards (T-EV-W13).
 * The art is the one thing about a ticket that stays editable after publishing — it lives in
 * `eventArt/{eventId}` and not on the chain — so the picker had to be reachable from both, and a
 * second copy of it would be a second set of names.
 *
 * The row is a `radiogroup` and each tile a `radio`: one choice among the twelve backdrops and the
 * organiser's own picture. The roving tabindex keeps one tab stop into the row and the arrow keys
 * move within it; the twelve previews are `aria-hidden` so a screen reader hears one name per tile
 * — the preset — and never the fifteen `<text>` nodes of the drawing behind it. A scroll only
 * lights the dot; selecting is a tap or an arrow key (expert-4 D5), never a browse. The callback
 * contract (`onPreset`/`onUploaded`) is unchanged.
 */
export function ArtPicker({
  art, title, tierName, holder = '', dateText = '', onPreset, onUploaded,
}: ArtPickerProps) {
  const copy = useOrganizerCopy().scene.tiers;
  const [uploading, setUploading] = useState(false);
  const { pin, busy, problem } = usePinImage('ticket');
  // `null` while a picture of their own is in place: the tiles then show nothing chosen, which is
  // the truth — the upload is what the ticket will carry.
  const chosen = 'preset' in art ? art.preset : null;
  const chosenIndex = chosen === null ? -1 : TICKET_ART_PRESETS.indexOf(chosen);

  // The dot the carousel is scrolled to. It starts on the chosen tile, or the first when a
  // picture of their own is in place, and follows the centre tile once the observer is live.
  const [centre, setCentre] = useState(chosenIndex === -1 ? 0 : chosenIndex);

  const scroller = useRef<HTMLDivElement>(null);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);

  async function upload(cropped: CroppedPoster): Promise<void> {
    const cid = await pin(cropped);
    if (cid === '') return;
    onUploaded(cid);
    setUploading(false);
  }

  function toCentre(index: number): void {
    try {
      tiles.current[index]?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    } catch {
      /* jsdom has no layout; the choice was still made. */
    }
  }

  function select(preset: TicketArtPreset): void {
    onPreset(preset);
    toCentre(TICKET_ART_PRESETS.indexOf(preset));
  }

  function move(to: number): void {
    const at = Math.max(0, Math.min(TICKET_ART_PRESETS.length - 1, to));
    const preset = TICKET_ART_PRESETS[at];
    if (!preset) return;
    select(preset);
    tiles.current[at]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        move(0);
        break;
      case 'End':
        event.preventDefault();
        move(TICKET_ART_PRESETS.length - 1);
        break;
      default:
        break;
    }
  }

  // The centre tile drives the dot only. A scroll shows the person where they are in the row; it
  // never selects — the choice is a tap or an arrow key (expert-4 D5), so a browse never changes
  // the art or marks the draft dirty. Guarded for the server and for jsdom, which have no
  // `IntersectionObserver`; the row is then a plain scroller whose dots do not move.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const root = scroller.current;
    if (!root) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        let best = -1;
        let bestRatio = 0;
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.tileIndex);
          if (Number.isNaN(index)) continue;
          if (entry.isIntersecting && entry.intersectionRatio >= bestRatio) {
            bestRatio = entry.intersectionRatio;
            best = index;
          }
        }
        if (best < 0) return;
        setCentre(best);
      },
      { root, threshold: [0.5, 0.75, 1] },
    );
    for (const tile of tiles.current) {
      if (tile && tile.dataset.tileIndex !== undefined) io.observe(tile);
    }
    return () => io.disconnect();
  }, []);

  return (
    <>
      {/* Twelve live previews and an upload in one sideways-snapping row: the neighbours peek, the
          centre one is the choice, and nothing here is wider than the phone (plan section C-1). */}
      <div className="art-carousel" role="radiogroup" aria-label={copy.artCarousel} ref={scroller}>
        {TICKET_ART_PRESETS.map((preset, index) => {
          const on = chosen === preset;
          return (
            <button
              key={preset}
              type="button"
              className={on ? 'art-tile art-tile--on' : 'art-tile'}
              data-tile-index={index}
              role="radio"
              aria-checked={on}
              // The tile's name is the preset, not the fifteen words of the drawing inside it.
              aria-label={presetLabel(copy, preset)}
              // Roving tabindex: one tab stop (the chosen tile, or the first), arrows do the rest.
              tabIndex={index === (chosenIndex === -1 ? 0 : chosenIndex) ? 0 : -1}
              onClick={() => select(preset)}
              onKeyDown={(event) => onKeyDown(event, index)}
              ref={(node) => {
                tiles.current[index] = node;
              }}
            >
              <span className="art-tile__preview" aria-hidden="true">
                <TicketArt art={{ preset }} title={title} tierName={tierName} holder={holder} dateText={dateText} />
              </span>
              <span className="art-tile__caption" aria-hidden="true">{presetLabel(copy, preset)}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={chosen === null ? 'art-tile art-tile--upload art-tile--on' : 'art-tile art-tile--upload'}
          role="radio"
          aria-checked={chosen === null}
          onClick={() => setUploading((open) => !open)}
        >
          {uploading ? copy.artUploadClose : copy.artUpload}
        </button>
      </div>
      <div className="art-dots" aria-hidden="true">
        {TICKET_ART_PRESETS.map((preset, index) => (
          <span key={preset} className={index === centre ? 'art-dot art-dot--on' : 'art-dot'} />
        ))}
      </div>
      {uploading ? (
        <>
          <A4Cropper onCropped={upload} busy={busy} />
          {busy ? <p className="muted">{copy.artWorking}</p> : null}
        </>
      ) : null}
      {problem !== '' ? <p className="problem">{problem}</p> : null}
    </>
  );
}
