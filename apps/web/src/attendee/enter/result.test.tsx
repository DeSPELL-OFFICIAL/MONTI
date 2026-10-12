import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeEventTopics, numberToHex } from 'viem';
import { CLOCK_SKEW_SECONDS, CODE_WINDOW_SECONDS, type Hex } from '@monti/shared';
import { en } from '../../shared/copy/index';
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

const eventTopic = vi.fn<(contract: 'Ticket', name: string) => Hex | null>();
vi.mock('../../shared/chain/abis', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/abis')>()),
  eventTopic: (contract: 'Ticket', name: string) => eventTopic(contract, name),
}));

let account: Hex | undefined = ACCOUNT;
vi.mock('../../shared/session', () => ({
  useSession: () => ({ status: account ? 'signedIn' : 'anonymous', account }),
}));

const { Result, WAITING_DEADLINE_MS, checkedInTopics, resetEntryPush } = await import('./Result');
const abis = await vi.importActual<typeof import('../../shared/chain/abis')>('../../shared/chain/abis');
const { ticketAbi } = abis;

/** A log of the given commit stage. Only `stage` is read, so the rest is the minimum viem shape. */
function log(stage: LogStage, transactionHash = '0xa'): ChainLog {
  return { stage, transactionHash, logIndex: 0 } as unknown as ChainLog;
}

beforeEach(() => {
  account = ACCOUNT;
  eventTopic.mockReset().mockImplementation(abis.eventTopic);
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
  render(<MemoryRouter><Result tokenId={tokenId} /></MemoryRouter>);
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * `CheckedInLate(uint256,uint256,uint64,uint64)`, written out rather than derived, so this file
 * and `contracts/docs/abi-delta-01b.md` §2 cannot drift apart — `shared/chain/abis.test.ts`
 * pins the same literal against the generated ABI.
 */
const CHECKED_IN_LATE_TOPIC = '0xad3c23d74f79b6306db7acb45e49e960632c823ee84714ce5616a798913fb782';

describe('checkedInTopics', () => {
  it('filters the Ticket address by both check-in events and this tokenId', () => {
    // 01b's offline flush emits `CheckedInLate`, and an attendee admitted that way has to see
    // the same green, so both signatures share one topic0 slot.
    const [signature, tokenTopic] = checkedInTopics('42') ?? [];
    expect(signature).toEqual([
      encodeEventTopics({ abi: ticketAbi, eventName: 'CheckedIn' })[0],
      CHECKED_IN_LATE_TOPIC,
    ]);
    expect(tokenTopic).toBe(numberToHex(42n, { size: 32 }));
  });

  it('puts only real signatures in the topic0 slot, never a hole', () => {
    // The filter is built by asking the manifest for each name and dropping what it does not
    // carry. What may never come out the other end is a topic0 array with an `undefined` in it,
    // or an empty one: a node reads either as "match any topic0", and this screen would then go
    // green on the next Transfer this ticket emits.
    const [signature] = checkedInTopics('42') ?? [];
    expect(signature).toHaveLength(2);
    expect(signature).not.toContain(undefined);
  });

  /**
   * `USED_EVENTS.Ticket` also carries `EventCreated`, whose first indexed argument is an
   * `eventId` in the same topic position this filter matches `tokenId` in. Subscribing to it
   * here would turn the entry screen green on an unrelated event with a colliding number.
   */
  it('subscribes to the check-in events only, never to every Ticket event in the manifest', () => {
    const [signature] = checkedInTopics('42') ?? [];
    expect(signature).not.toContain(encodeEventTopics({ abi: ticketAbi, eventName: 'EventCreated' })[0]);
  });

  it('answers null rather than an empty topic0 when the ABI has no check-in event', () => {
    // An empty `topic0` array is read by a node as "match any topic0", which would turn this
    // screen green on the next Transfer this ticket emits.
    eventTopic.mockReturnValue(null);
    expect(checkedInTopics('42')).toBeNull();
  });
});

describe('<Result /> — the chain', () => {
  it('shows the green on the speculative log and hardens it on the finalized one', async () => {
    await show();
    expect(screen.getByText(en.enter.resultWaiting)).toBeInTheDocument();
    expect(subscribeLogs.mock.calls[0]?.[0].address).toBe(TICKET);

    act(() => emitLog?.(log('speculative')));
    expect(screen.getByText(en.enter.done)).toBeInTheDocument();
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'speculative');
    expect(screen.getByText(en.enter.resultSettling)).toBeInTheDocument();

    act(() => emitLog?.(log('finalized')));
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'finalized');
    expect(screen.queryByText(en.enter.resultSettling)).not.toBeInTheDocument();
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
    expect(screen.getByText(en.enter.done)).toBeInTheDocument();
    // A check-in already in storage is a recorded fact. Lighting it as still settling would
    // leave "기록하고 있어요" under an entry finalized an hour ago, forever.
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'finalized');
    expect(screen.queryByText(en.enter.resultSettling)).not.toBeInTheDocument();
  });

  it('opens no subscription at all rather than one that matches every log', async () => {
    eventTopic.mockReturnValue(null);
    await show();
    expect(subscribeLogs).not.toHaveBeenCalled();
    expect(screen.getByText(en.enter.resultWaiting)).toBeInTheDocument();
  });

  it('says nothing when the mount read cannot reach the chain', async () => {
    checkInOf.mockRejectedValue(new Error('offline'));
    await show();
    expect(screen.getByText(en.enter.resultWaiting)).toBeInTheDocument();
  });
});

describe('<Result /> — the push', () => {
  it('confirms on the push when it arrives before any log', async () => {
    await show();
    expect(registerPush).toHaveBeenCalledWith(ACCOUNT, expect.any(Function));
    act(() => emitPush?.({ tokenId: '42' }));
    expect(screen.getByText(en.enter.done)).toBeInTheDocument();
    // The webhook fires on a finalized event, so there is nothing left to harden.
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'finalized');
  });

  it('confirms on the payload the backend really sends, late flag and all', async () => {
    // `pushCheckedIn` sends `{ tokenId }` and nothing else; 01b adds `late`, which changes
    // nothing here because it emits `CheckedIn` alongside `CheckedInLate`.
    await show();
    act(() => emitPush?.({ tokenId: '42', late: '1' }));
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'finalized');
  });

  it('ignores a push about someone else\'s ticket', async () => {
    await show('42');
    act(() => emitPush?.({ tokenId: '43' }));
    expect(screen.getByText(en.enter.resultWaiting)).toBeInTheDocument();
  });

  it('registers once across mounts and stays silent when the person refused', async () => {
    registerPush.mockResolvedValue({ status: 'unavailable', reason: 'PUSH_PERMISSION_DENIED' });
    const first = render(<MemoryRouter><Result tokenId="42" /></MemoryRouter>);
    first.unmount();
    await show();
    expect(registerPush).toHaveBeenCalledTimes(1);
    // A refusal is not a sentence: the chain path is the one that decides.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(en.enter.resultWaiting)).toBeInTheDocument();
  });

  it('does not ask for the permission before there is an account to register', async () => {
    account = undefined;
    await show();
    expect(registerPush).not.toHaveBeenCalled();
    expect(subscribeLogs).toHaveBeenCalledTimes(1);
  });
});

describe('<Result /> — the deadline', () => {
  it('stops waiting one code window plus the clock skew after the hand-over', async () => {
    vi.useFakeTimers();
    render(<MemoryRouter><Result tokenId="42" /></MemoryRouter>);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WAITING_DEADLINE_MS - 1_000);
    });
    expect(screen.getByText(en.enter.resultWaiting)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(en.enter.notConfirmed);
    expect(WAITING_DEADLINE_MS).toBe((CODE_WINDOW_SECONDS + CLOCK_SKEW_SECONDS) * 1_000);
  });

  it('does not restart the deadline when the person signs in while waiting', async () => {
    vi.useFakeTimers();
    account = undefined;
    const view = render(<MemoryRouter><Result tokenId="42" /></MemoryRouter>);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WAITING_DEADLINE_MS - 1_000);
    });
    account = ACCOUNT;
    view.rerender(<MemoryRouter><Result tokenId="42" /></MemoryRouter>);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    // The 65 s is measured from the hand-over. An account arriving mid-wait re-opens the
    // subscription, and must not buy the screen another minute of spinner.
    expect(screen.getByRole('alert')).toHaveTextContent(en.enter.notConfirmed);
  });

  it('lets the chain overrule the deadline when the log finally lands', async () => {
    vi.useFakeTimers();
    render(<MemoryRouter><Result tokenId="42" /></MemoryRouter>);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WAITING_DEADLINE_MS);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(en.enter.notConfirmed);
    act(() => emitLog?.(log('finalized')));
    expect(screen.getByText(en.enter.done)).toBeInTheDocument();
  });
});

describe('<Result /> — cleanup', () => {
  it('drops the subscription, the push listener and the deadline on unmount', async () => {
    vi.useFakeTimers();
    const view = render(<MemoryRouter><Result tokenId="42" /></MemoryRouter>);
    view.unmount();
    expect(stopLogs).toHaveBeenCalledTimes(1);

    // Neither a late push nor the deadline may touch an unmounted screen.
    expect(() => emitPush?.({ tokenId: '42' })).not.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WAITING_DEADLINE_MS);
    });
    expect(screen.queryByTestId('entry-result')).not.toBeInTheDocument();
  });
});
