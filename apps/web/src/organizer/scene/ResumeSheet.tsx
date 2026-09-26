import { Button, Sheet } from '../../shared/ui';
import { fmt } from '../../shared/i18n';
import { useOrganizerCopy } from '../copy';
import { timeAgo } from './relativeTime';

export interface ResumeSheetProps {
  /** The stored draft's title, or `''` — which is why {@link ResumeSheet} names it instead. */
  title: string;
  /** Epoch ms that draft was last written. */
  at: number;
  onResume: () => void;
  onFresh: () => void;
}

/**
 * The question a draft that was left behind asks on the way back in (plan section F-3).
 *
 * Until the founder's phone test this was a grey line above the poster reading `이어서 쓰는 중`
 * with a `처음부터` link beside it, and the complaint it drew was that nothing on the screen
 * ever said the draft had been kept. So the draft says it itself, in front of the scene, and
 * names which draft it is and when it was last written — a person with two abandoned drafts
 * cannot answer this question without those two facts.
 *
 * The panel itself is the shared {@link Sheet} — a `<dialog open>` rather than a route, like
 * the poster modal and the deletion confirmation: one decision with both answers on it, and a
 * route would put it in the back button's history.
 */
export function ResumeSheet({ title, at, onResume, onFresh }: ResumeSheetProps) {
  const copy = useOrganizerCopy().scene;
  const named = title.trim() === '' ? copy.resume.untitled : title;

  return (
    <Sheet label={copy.resume.title} onDismiss={onFresh}>
      <h2>{copy.resume.title}</h2>
      <p className="muted">
        {fmt(copy.resume.body, { title: named, when: timeAgo(Date.now() - at, copy) })}
      </p>
      <Button onClick={onResume}>{copy.resume.keep}</Button>
      {/* The old draft is not deleted by this — `startNew`, not `discard` (plan section F-4). */}
      <Button variant="ghost" onClick={onFresh}>{copy.resume.fresh}</Button>
    </Sheet>
  );
}
