/**
 * One choice out of a short, visible set — a theme, a currency, a picture. A chip row is used
 * where a `<select>` would hide the alternatives behind a tap: on a phone the whole point of
 * these sets is that all of them are on screen at once.
 *
 * It is a `button` with `aria-pressed` rather than a radio, because several of these rows are
 * not a single-choice group at all (the tag row removes, the art row previews), and one part
 * that behaves the same way everywhere is worth more than the radio's arrow-key walk.
 */
export interface ChipProps {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function Chip({ label, selected = false, disabled = false, onClick }: ChipProps) {
  return (
    <button
      type="button"
      className={`chip${selected ? ' chip--on' : ''}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
