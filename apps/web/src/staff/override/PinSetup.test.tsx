// The PIN step on the registration screen, and the one thing it must never do: store the PIN.
import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fmt } from '../../shared/i18n';
import { PIN_MIN_LENGTH } from '../constants';
import { staffEn } from '../copy';
import { staffDb } from '../snapshot/store';
import { hasPin } from './pin';
import { PinStep } from './PinSetup';

const copy = staffEn.setup;

beforeEach(async () => {
  await (await staffDb()).delete('settings', 'pin');
});

async function typePin(first: string, second = first): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(copy.pinLabel), first);
  await user.type(screen.getByLabelText(copy.pinConfirmLabel), second);
  await user.click(screen.getByRole('button', { name: copy.pinSave }));
}

describe('the PIN step at gate setup', () => {
  it('asks for one when the device has none, and says so upward', async () => {
    const onChange = vi.fn();
    render(<PinStep onChange={onChange} />);
    expect(await screen.findByLabelText(copy.pinLabel)).toBeInTheDocument();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(false));
  });

  it('stores a salted hash, never the PIN, and reports the terminal ready', async () => {
    const onChange = vi.fn();
    render(<PinStep onChange={onChange} />);
    await screen.findByLabelText(copy.pinLabel);
    await typePin('4821');

    expect(await screen.findByText(copy.pinSaved)).toBeInTheDocument();
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(true));
    const row = await (await staffDb()).get('settings', 'pin');
    expect(JSON.stringify(row)).not.toContain('4821');
    expect(await hasPin()).toBe(true);
  });

  it('refuses a PIN too short to survive the lockout, and stores nothing', async () => {
    render(<PinStep />);
    await screen.findByLabelText(copy.pinLabel);
    await typePin('12');
    expect(await screen.findByText(fmt(copy.pinTooShort, { digits: PIN_MIN_LENGTH }))).toBeInTheDocument();
    expect(await hasPin()).toBe(false);
  });

  /** Two boxes because a mistyped PIN is a terminal that cannot approve anything all evening. */
  it('refuses two entries that do not match', async () => {
    render(<PinStep />);
    await screen.findByLabelText(copy.pinLabel);
    await typePin('4821', '4822');
    expect(await screen.findByText(copy.pinMismatch)).toBeInTheDocument();
    expect(await hasPin()).toBe(false);
  });

  it('shows an existing PIN as set, and lets a shift replace it', async () => {
    const onChange = vi.fn();
    render(<PinStep onChange={onChange} />);
    await screen.findByLabelText(copy.pinLabel);
    await typePin('4821');
    await screen.findByText(copy.pinSaved);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: copy.pinChange }));
    await typePin('9999');
    await screen.findByText(copy.pinSaved);
    expect(await hasPin()).toBe(true);
    const row = (await (await staffDb()).get('settings', 'pin')) as { failures: number };
    expect(row.failures).toBe(0);
  });

  it('keeps the digits out of sight while a queue is watching', async () => {
    render(<PinStep />);
    expect(await screen.findByLabelText(copy.pinLabel)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(copy.pinConfirmLabel)).toHaveAttribute('type', 'password');
  });
});
