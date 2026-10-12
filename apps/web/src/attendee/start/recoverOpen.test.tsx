import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en as copy } from './copy';

const resetDeviceKey = vi.fn(async () => undefined);
vi.mock('../../shared/deviceKey', () => ({ resetDeviceKey, ATTENDEE_KEY_ALIAS: 'monti-attendee' }));

const signOut = vi.fn(async () => undefined);
vi.mock('firebase/auth', () => ({ signOut }));
vi.mock('../../shared/api/firebase', () => ({ getFirebaseAuth: () => ({ name: 'auth' }) }));

const { RecoverOpen } = await import('./RecoverOpen');

function renderIt() {
  render(
    <MemoryRouter initialEntries={['/recover']}>
      <Routes>
        <Route path="/recover" element={<RecoverOpen />} />
        <Route path="/start" element={<h1>start page</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetDeviceKey.mockReset().mockResolvedValue(undefined);
  signOut.mockReset().mockResolvedValue(undefined);
});

describe('RecoverOpen (open-mode /recover)', () => {
  it('explains the pass on this browser is gone and offers no SMS', () => {
    renderIt();
    expect(screen.getByRole('heading', { name: copy.recoverTitle })).toBeInTheDocument();
    expect(screen.getByText(copy.recoverBody)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('drops the stale key, signs out, and goes to /start', async () => {
    renderIt();
    await userEvent.click(screen.getByRole('button', { name: copy.recoverCta }));
    expect(await screen.findByRole('heading', { name: 'start page' })).toBeInTheDocument();
    expect(resetDeviceKey).toHaveBeenCalledWith({ alias: 'monti-attendee' });
    expect(signOut).toHaveBeenCalledWith({ name: 'auth' });
  });

  it('says so and stays when the reset fails', async () => {
    signOut.mockRejectedValue(new Error('offline'));
    renderIt();
    await userEvent.click(screen.getByRole('button', { name: copy.recoverCta }));
    expect(await screen.findByText(copy.recoverFailed)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.recoverCta })).toBeEnabled();
  });
});
