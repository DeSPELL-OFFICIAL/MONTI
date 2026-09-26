import type { ReactNode } from 'react';

/**
 * A yes/no the organiser can read without tapping it. It stays a real `<input type="checkbox">`
 * inside a `<label>` — the switch look is CSS only — so the accessible name, the keyboard and
 * `getByRole('checkbox', { name })` all work without a line of ARIA.
 */
export interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /**
   * A small glyph shown between the switch and the label. It is decoration — `aria-hidden`, so
   * the accessible name stays exactly the label and `getByRole('checkbox', { name })` is
   * unaffected — and it is what lets a row of these read as a compact icon row.
   */
  icon?: ReactNode;
  /** Shown under the row, always — a switch whose consequence appears only once it is on is a trap. */
  help?: ReactNode;
  disabled?: boolean;
}

export function Toggle({ label, checked, onChange, icon, help, disabled = false }: ToggleProps) {
  return (
    <div className="toggle">
      <label className="toggle__row">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {icon !== undefined ? <span className="toggle__icon" aria-hidden="true">{icon}</span> : null}
        <span>{label}</span>
      </label>
      {help !== undefined ? <p className="muted toggle__help">{help}</p> : null}
    </div>
  );
}
