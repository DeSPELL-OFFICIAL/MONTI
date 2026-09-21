import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeEventTopics, numberToHex } from 'viem';
import { CLOCK_SKEW_SECONDS, CODE_WINDOW_SECONDS, type Hex } from '@monti/shared';
import { ko } from '../../shared/copy/index';
import type { ChainLog, LogStage, SubscribeLogsArgs } from '../../shared/chain/subscribeLogs';

const TICKET = `0x${'33'.repeat(20)}` as Hex;
const ACCOUNT = `0x${'ab'.repeat(20)}` as Hex;

const stopLogs = vi.fn();
const subscribeLogs = vi.fn<(args: SubscribeLogsArgs) => () => void>();
let emitLog: ((log: ChainLog) => void) | undefined;
vi.mock('../../shared/chain/subscribeLogs', () => ({
  subscribeLogs: (args: SubscribeLogsArgs) => subscribeLogs(args),
}));

const checkInOf = vi.fn();
vi.mock('../../shared/chain/reads', () => ({ readTicket: () => ({ checkInOf }) }));

const registerPush = vi.fn();
let emitPush: ((data: Record<string, string>) => void) | undefined;
vi.mock('../../shared/push', () => ({ registerPush: (...args: unknown[]) => registerPush(...args) }));

vi.mock('../../shared/config', () => ({ getConfig: () => ({ addresses: { ticket: TICKET } }) }));

let account: Hex | undefined = ACCOUNT;
vi.mock('../../shared/session', () => ({
  useSession: () => ({ status: account ? 'signedIn' : 'anonymous', account }),
}));

const { Result, WAITING_DEADLINE_MS, checkedInTopics, resetEntryPush } = await import('./Result');
const { ticketAbi } = await import('../../shared/chain/abis');

/** A log of the given commit stage. Only `stage` is read, so the rest is the minimum viem shape. */
function log(stage: LogStage, transactionHash = '0xa'): ChainLog {
  return { stage, transactionHash, logIndex: 0 } as unknown as ChainLog;
}

beforeEach(() => {
  account = ACCOUNT;
  emitLog = undefined;
  emitPush = undefined;
  resetEntryPush();
  stopLogs.mockClear();
  subscribeLogs.mockReset().mockImplementation((args) => {
    emitLog = args.onLog;
    return stopLogs;
  });
  // The default is a ticket nobody has checked in yet, so the mount read says nothing.
  checkInOf.mockReset().mockResolvedValue({ gateId: 0n, ts: 0n, nonceHash: `0x${'00'.repeat(32)}`, manual: false });
  registerPush.mockReset().mockImplementation(async (_account: Hex, onPush: (data: Record<string, string>) => void) => {
    emitPush = onPush;
    return { status: 'registered', stop: () => undefined };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Renders and lets the mount read settle, so a test asserting "still waiting" means it. */
async function show(tokenId = '42') {
  render(<Result tokenId={tokenId} />);
  await act(async () => {
    await Promise.resolve();
  });
}

describe('checkedInTopics', () => {
  it('filters the Ticket address by CheckedIn and this tokenId', () => {
    const [signature, tokenTopic] = checkedInTopics('42');
    expect(signature).toEqual([encodeEventTopics({ abi: ticketAbi, eventName: 'CheckedIn' })[0]]);
    expect(tokenTopic).toBe(numberToHex(42n, { size: 32 }));
  });

  it('leaves out an event the deployed ABI does not carry yet', () => {
    // `CheckedInLate` arrives with the 01b redeploy. Until then one signature, not a topic0
    // array with an undefined in it — which would match every log the contract ever emitted.
    const [signature] = checkedInTopics('42');
    expect(signature).toHaveLength(1);
  });
});

describe('<Result /> — the chain', () => {
  it('shows the green on the speculative log and hardens it on the finalized one', async () => {
    await show();
    expect(screen.getByText(ko.enter.resultWaiting)).toBeInTheDocument();
    expect(subscribeLogs.mock.calls[0]?.[0].address).toBe(TICKET);

    act(() => emitLog?.(log('speculative')));
    expect(screen.getByText(ko.enter.done)).toBeInTheDocument();
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'speculative');
    expect(screen.getByText(ko.enter.resultSettling)).toBeInTheDocument();

    act(() => emitLog?.(log('finalized')));
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'finalized');
    expect(screen.queryByText(ko.enter.resultSettling)).not.toBeInTheDocument();
  });

  it('does not let a late speculative log undo a finalized one', async () => {
    await show();
    act(() => emitLog?.(log('finalized', '0xb')));
    act(() => emitLog?.(log('speculative', '0xb')));
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'finalized');
  });

  it('reads checkInOf once on mount, for the tap that landed before the subscription opened', async () => {
    checkInOf.mockResolvedValue({ gateId: 3n, ts: 1_790_000_000n, nonceHash: `0x${'11'.repeat(32)}`, manual: false });
    await show('7');
    expect(checkInOf).toHaveBeenCalledTimes(1);
    expect(checkInOf).toHaveBeenCalledWith(7n);
    expect(screen.getByText(ko.enter.done)).toBeInTheDocument();
  });

  it('says nothing when the mount read cannot reach the chain', async () => {
    checkInOf.mockRejectedValue(new Error('offline'));
    await show();
    expect(screen.getByText(ko.enter.resultWaiting)).toBeInTheDocument();
  });
});

describe('<Result /> — the push', () => {
  it('confirms on the push when it arrives before any log', async () => {
    await show();
    expect(registerPush).toHaveBeenCalledWith(ACCOUNT, expect.any(Function));
    act(() => emitPush?.({ kind: 'entry', tokenId: '42' }));
    expect(screen.getByText(ko.enter.done)).toBeInTheDocument();
    // The webhook fires on a finalized event, so there is nothing left to harden.
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'finalized');
  });

  it('ignores a push about someone else\'s ticket', async () => {
    await show('42');
    act(() => emitPush?.({ kind: 'entry', tokenId: '43' }));
    expect(screen.getByText(ko.enter.resultWaiting)).toBeInTheDocument();
  });

  it('registers once across mounts and stays silent when the person refused', async () => {
    registerPush.mockResolvedValue({ status: 'unavailable', reason: 'PUSH_PERMISSION_DENIED' });
    const first = render(<Result tokenId="42" />);
    first.unmount();
    await show();
    expect(registerPush).toHaveBeenCalledTimes(1);
    // A refusal is not a sentence: the chain path is the one that decides.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(ko.enter.resultWaiting)).toBeInTheDocument();
  });

  it('does not ask for the permission before there is an account to register', async () => {
    account = undefined;
    await show();
    expect(registerPush).not.toHaveBeenCalled();
    expect(subscribeLogs).toHaveBeenCalledTimes(1);
  });
});

describe('<Result /> — refusals and the deadline', () => {
  it('renders the DENY code the gate sent rather than a generic apology', async () => {
    await show();
    act(() => emitPush?.({ kind: 'entry', tokenId: '42', deny: 'GATE_MISMATCH' }));
    expect(screen.getByRole('alert')).toHaveTextContent(ko.enter.deny.GATE_MISMATCH);
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'failed');
  });

  it('keeps waiting on a TIMEOUT, which is confirming and not a refusal', async () => {
    await show();
    act(() => emitPush?.({ kind: 'entry', tokenId: '42', deny: 'TIMEOUT' }));
    expect(screen.getByText(ko.enter.resultWaiting)).toBeInTheDocument();
  });

  it('ignores a refusal that arrives after the entry was already confirmed', async () => {
    await show();
    act(() => emitLog?.(log('finalized')));
    act(() => emitPush?.({ kind: 'entry', tokenId: '42', deny: 'ALREADY_USED' }));
    expect(screen.getByText(ko.enter.done)).toBeInTheDocument();
  });

  it('stops waiting one code window plus the clock skew after the hand-over', async () => {
    vi.useFakeTimers();
    render(<Result tokenId="42" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WAITING_DEADLINE_MS - 1_000);
    });
    expect(screen.getByText(ko.enter.resultWaiting)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(ko.enter.notConfirmed);
    expect(WAITING_DEADLINE_MS).toBe((CODE_WINDOW_SECONDS + CLOCK_SKEW_SECONDS) * 1_000);
  });

  it('lets the chain overrule the deadline when the log finally lands', async () => {
    vi.useFakeTimers();
    render(<Result tokenId="42" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WAITING_DEADLINE_MS);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(ko.enter.notConfirmed);
    act(() => emitLog?.(log('finalized')));
    expect(screen.getByText(ko.enter.done)).toBeInTheDocument();
  });
});

describe('<Result /> — cleanup', () => {
  it('drops the subscription, the push listener and the deadline on unmount', async () => {
    vi.useFakeTimers();
    const view = render(<Result tokenId="42" />);
    view.unmount();
    expect(stopLogs).toHaveBeenCalledTimes(1);

    // Neither a late push nor the deadline may touch an unmounted screen.
    expect(() => emitPush?.({ kind: 'entry', tokenId: '42' })).not.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WAITING_DEADLINE_MS);
    });
    expect(screen.queryByTestId('entry-result')).not.toBeInTheDocument();
  });
});
