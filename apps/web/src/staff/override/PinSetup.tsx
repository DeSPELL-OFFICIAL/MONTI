// The PIN step, on the registration screen.
//
// It lives here rather than in `staff/setup/` because it is the manual-approval feature's front
// door, not the registration's: the PIN exists only to unlock the override dialog, and the rule
// about what a PIN may be (`PIN_MIN_LENGTH`, and that only a hash is kept) belongs next to the
// code that enforces it.
//
// It is at setup for a scheduling reason that matters at a venue. The one moment a PIN can be
// chosen calmly is while a staff member is looking at a registration panel with nobody waiting;
// the moment it is *needed* is the worst one — an attendee whose phone will not open, a queue
// behind them, and a dialog asking for four digits nobody has agreed on yet. So the gate screen
// is not offered until this step is done.
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { fmt } from '../../shared/i18n';
import { Alert, Button, Field } from '../../shared/ui';
import { PIN_MIN_LENGTH } from '../constants';
import { useStaffSetupCopy } from '../copy';
import { warn } from '../log';
import { hasPin, setPin } from './pin';

const NON_DIGITS = /\D/g;

export interface PinStepProps {
  /**
   * Whether this terminal has a PIN, pushed out whenever the answer changes — on the first read
   * and after a save. The registration panel holds the door shut until it is `true`, and it
   * holds that fact rather than asking IndexedDB itself, so there is one reader of the row.
   */
  onChange?: (hasPin: boolean) => void;
}

export function PinStep({ onChange }: PinStepProps): ReactElement | null {
  const copy = useStaffSetupCopy();
  /** `undefined` until the first read. Nothing is drawn before it: the panel must not flash. */
  const [stored, setStored] = useState<boolean>();
  const [editing, setEditing] = useState(false);
  const [pin, setPinDraft] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();

  const report = useCallback(
    (next: boolean) => {
      setStored(next);
      onChange?.(next);
    },
    [onChange],
  );

  useEffect(() => {
    let alive = true;
    void hasPin()
      .then((found) => {
        if (alive) report(found);
      })
      .catch((cause) => {
        // A database that will not open is not a PIN: the panel keeps the door shut and the
        // step keeps asking, which is the safe way to be wrong.
        warn('staff', 'could not read the PIN row', cause);
        if (alive) report(false);
      });
    return () => {
      alive = false;
    };
  }, [report]);

  if (stored === undefined) return null;

  const save = async (): Promise<void> => {
    if (pin.length < PIN_MIN_LENGTH) {
      setError(fmt(copy.pinTooShort, { digits: PIN_MIN_LENGTH }));
      return;
    }
    if (pin !== confirm) {
      setError(copy.pinMismatch);
      return;
    }
    try {
      await setPin(pin);
    } catch (cause) {
      warn('staff', 'could not store the PIN', cause);
      setError(copy.pinFailed);
      return;
    }
    // The draft goes with the save. Leaving four digits in a React state that survives the
    // panel is the one place this feature could keep a plaintext PIN by accident.
    setPinDraft('');
    setConfirm('');
    setError(undefined);
    setEditing(false);
    report(true);
  };

  if (stored && !editing) {
    return (
      <section className="gate-setup__pin">
        <h2>{copy.pinTitle}</h2>
        <p>{copy.pinSaved}</p>
        <Button variant="ghost" onClick={() => setEditing(true)}>
          {copy.pinChange}
        </Button>
      </section>
    );
  }

  return (
    <section className="gate-setup__pin">
      <h2>{copy.pinTitle}</h2>
      <p>{fmt(copy.pinHint, { digits: PIN_MIN_LENGTH })}</p>
      <Field label={copy.pinLabel}>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(event) => setPinDraft(event.target.value.replace(NON_DIGITS, ''))}
        />
      </Field>
      <Field label={copy.pinConfirmLabel}>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value.replace(NON_DIGITS, ''))}
        />
      </Field>
      {error === undefined ? null : <Alert tone="error">{error}</Alert>}
      <Button onClick={() => void save()}>{copy.pinSave}</Button>
    </section>
  );
}
