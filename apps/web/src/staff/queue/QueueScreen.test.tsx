import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { staffEn } from '../copy';
import { QueueScreen, type QueueScreenProps } from './QueueScreen';
import type { ReconciledEntry } from './reconcile';

const TS = 1_700_000_000;

/** The time the screen prints, computed the way the screen computes it. */
const at = (ts: number) => new Date(ts * 1000).toLocaleTimeString('en-US');

function entry(over: Partial<ReconciledEntry> & { id: string; tokenId: string }): ReconciledEntry {
  return {
    gateCode: {} as ReconciledEntry['gateCode'],
    response: {} as ReconciledEntry['response'],
    createdAt: 0,
    attempts: 1,
    nextAttemptAt: 0,
    status: 'pending',
    seq: 1,
    ...over,
  };
}

function renderQueue(over: Partial<QueueScreenProps> = {}) {
  const onReconcile = vi.fn();
  const onRetry = vi.fn();
  render(<QueueScreen entries={[]} onReconcile={onReconcile} onRetry={onRetry} {...over} />);
  return { onReconcile, onRetry };
}

describe('queue screen', () => {
  it('counts what is still on its way apart from what has stopped', () => {
    renderQueue({
      entries: [
        entry({ id: '1', tokenId: '100', status: 'pending' }),
        entry({ id: '2', tokenId: '101', status: 'sent' }),
        entry({ id: '3', tokenId: '102', status: 'confirmed' }),
        entry({ id: '4', tokenId: '103', status: 'conflict', firstGateId: '9', firstTs: TS }),
        entry({ id: '5', tokenId: '104', status: 'failed', lastError: 'LATE_WINDOW_ELAPSED' }),
      ],
    });

    // `sent` counts as waiting: an op with no receipt is as unaccounted for as one not yet sent.
    expect(screen.getByText('Waiting 2 · Recorded 1 · Conflicts 1 · Stopped 1')).toBeInTheDocument();
    expect(screen.queryByText(staffEn.queue.empty)).not.toBeInTheDocument();
  });

  it('names the gate that won and the time it recorded the tap', () => {
    renderQueue({
      entries: [entry({ id: '4', tokenId: '103', status: 'conflict', firstGateId: '9', firstTs: TS })],
    });

    expect(screen.getByText(`Ticket 103 · gate 9 took it first at ${at(TS)}`)).toBeInTheDocument();
    expect(screen.getByText(staffEn.queue.conflictsHint)).toBeInTheDocument();
  });

  it("says an organizer's manual override was exactly that, naming no gate that tapped", () => {
    renderQueue({
      entries: [
        entry({ id: '4', tokenId: '103', status: 'conflict', firstGateId: '7', firstTs: TS, manual: true }),
      ],
    });

    expect(screen.getByText(`Ticket 103 · approved by hand at gate 7 at ${at(TS)}`)).toBeInTheDocument();
    expect(screen.queryByText(/took it first/)).not.toBeInTheDocument();
  });

  it('offers no retry on a conflict, because there is nothing left to send', async () => {
    const { onRetry } = renderQueue({
      entries: [entry({ id: '4', tokenId: '103', status: 'conflict', firstGateId: '9', firstTs: TS })],
    });

    expect(screen.queryByRole('button', { name: staffEn.queue.retry })).not.toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('lists a parked entry with why it stopped and a retry that names it', async () => {
    const { onRetry } = renderQueue({
      entries: [
        entry({ id: '5', tokenId: '104', status: 'failed', lastError: 'LATE_WINDOW_ELAPSED' }),
        entry({ id: '6', tokenId: '105', status: 'failed', lastError: 'CHECK_IN_LATE_UNAVAILABLE' }),
        entry({ id: '7', tokenId: '106', status: 'failed', lastError: 'RESEND_EXHAUSTED' }),
        entry({ id: '8', tokenId: '107', status: 'failed', lastError: 'fetch failed' }),
      ],
    });

    const parked = screen.getByRole('list', { name: staffEn.queue.parkedTitle });
    const rows = within(parked).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText(staffEn.queue.reasonLateWindow)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(staffEn.queue.reasonNotDeployed)).toBeInTheDocument();
    expect(within(rows[2]!).getByText(staffEn.queue.reasonResendExhausted)).toBeInTheDocument();
    expect(within(rows[3]!).getByText(staffEn.queue.reasonOther)).toBeInTheDocument();
    // An error nobody has a sentence for is still shown, so a field report can name it.
    expect(within(rows[3]!).getByText('fetch failed')).toBeInTheDocument();
    // …and a mark that does have one is not printed raw beside it.
    expect(within(rows[2]!).queryByText('RESEND_EXHAUSTED')).not.toBeInTheDocument();

    await userEvent.click(within(rows[0]!).getByRole('button', { name: staffEn.queue.retry }));
    expect(onRetry).toHaveBeenCalledExactlyOnceWith('5');
  });

  it('retries one entry at a time', () => {
    renderQueue({
      retrying: '5',
      entries: [
        entry({ id: '5', tokenId: '104', status: 'failed', lastError: 'x' }),
        entry({ id: '6', tokenId: '105', status: 'failed', lastError: 'x' }),
      ],
    });

    // The one in flight says so; the other is held rather than hidden, so the list does not move
    // under the thumb of someone tapping down a queue.
    expect(screen.getByRole('button', { name: staffEn.queue.retrying })).toBeDisabled();
    expect(screen.getByRole('button', { name: staffEn.queue.retry })).toBeDisabled();
  });

  it('asks for a reconciliation pass, and says so while one is running', async () => {
    const { onReconcile } = renderQueue();
    await userEvent.click(screen.getByRole('button', { name: staffEn.queue.reconcile }));
    expect(onReconcile).toHaveBeenCalledOnce();

    renderQueue({ busy: true });
    expect(screen.getByRole('button', { name: staffEn.queue.reconciling })).toBeDisabled();
  });

  it('says the queue is empty rather than showing three empty lists', () => {
    renderQueue();
    expect(screen.getByText(staffEn.queue.empty)).toBeInTheDocument();
    expect(screen.queryByText(staffEn.queue.conflictsTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(staffEn.queue.parkedTitle)).not.toBeInTheDocument();
  });
});
