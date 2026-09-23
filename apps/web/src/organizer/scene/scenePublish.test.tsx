import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeErrorResult, encodeEventTopics, keccak256, numberToHex, toBytes } from 'viem';
import { ticketAbi } from '../../shared/chain/abis';
import type { EventDraft, StoredEventDraft } from '../../shared/api/firestore';

let store: StoredEventDraft[] = [];
const listEventDrafts = vi.fn(async () => [...store].sort((a, b) => b.updatedAt - a.updatedAt));
const saveEventDraft = vi.fn(async () => undefined);
const deleteEventDraft = vi.fn(async (id: string) => {
  store = store.filter((row) => row.id !== id);
});
vi.mock('../../shared/api/firestore', () => ({ listEventDrafts, saveEventDraft, deleteEventDraft }));

interface PinCall {
  orgId: string;
  meta: {
    name: string; description: string; imageCid: string;
    venue?: string; category?: number; region?: string;
    tags?: string[]; venueHidden?: boolean; timeHidden?: boolean;
  };
}
const pinEventImage = vi.fn(async () => ({ cid: 'bafkposter' }));
const pinEventMetadata = vi.fn(async (_args: PinCall) => ({ metadataCid: 'bafyMeta' }));
const saveEventArt = vi.fn(async (_args: unknown) => ({ ok: true as const }));
const setEventPrivate = vi.fn(async (_args: unknown) => ({ ok: true as const }));
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { pinEventImage, pinEventMetadata, saveEventArt, setEventPrivate },
}));

interface SentOp { functionName: string; orgId: bigint; args: readonly unknown[] }
const TICKET = `0x${'33'.repeat(20)}` as const;

/** `EventCreated(eventId, orgId, creator)` for event 12, all three arguments indexed. */
const CREATED_LOG = {
  address: TICKET,
  topics: [
    encodeEventTopics({ abi: ticketAbi, eventName: 'EventCreated', args: { eventId: 12n } })[0],
    numberToHex(12n, { size: 32 }),
    numberToHex(9n, { size: 32 }),
    `0x${'00'.repeat(12)}${'ab'.repeat(20)}`,
  ],
  data: '0x',
};

const ticketOp = vi.fn(async (_options: SentOp) => ({ success: true, logs: [CREATED_LOG] }));
const resolveSubmittedOp = vi.fn(async (_hash: string) => ({
  state: 'pending' as 'pending' | 'landed' | 'failed',
  logs: [] as unknown[],
}));
vi.mock('../../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/ops')>()),
  ticketOp,
  resolveSubmittedOp,
}));

const ACCOUNT = `0x${'ab'.repeat(20)}` as const;
vi.mock('../../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: ACCOUNT }) }));

vi.mock('../../shared/config', async (orig) => ({
  ...(await orig<typeof import('../../shared/config')>()),
  getConfig: () => ({ addresses: { ticket: TICKET }, ipfsGateway: 'https://gw.test/' }),
}));

const { OpReverted } = await import('../../shared/chain/ops');
const { TicketSettings } = await import('./TicketSettings');
const { emptyEventDraft, emptyEventDraftTier } = await import('../useEventDraft');
const { organizerCopy } = await import('../copy');
const copy = organizerCopy.ko.scene;

function Probe() {
  return <p>{`landed:${useLocation().pathname}`}</p>;
}

const SUBMITTED = `0x${'11'.repeat(32)}` as const;

const READY: EventDraft = {
  ...emptyEventDraft,
  orgId: '9',
  title: '  재즈 나이트  ',
  description: '한남동 라이브',
  posterCid: 'bafkposter',
  category: 2,
  tags: [' #재즈 ', '라이브', '재즈'],
  regionCode: 'KR-11',
  venue: '서울 용산구 한남동',
  // Well in the future, so the derived sign-up window (now -> endsAt) is a real one.
  startsAt: 1_900_000_000,
  endsAt: 1_900_010_000,
  transferable: true,
  transferCutoffHours: 2,
  tiers: [
    { ...emptyEventDraftTier, name: '일반', supply: 100, maxPerWallet: 2, design: 'c' },
    { ...emptyEventDraftTier, name: '학생', supply: 20, maxPerWallet: 1, imageCid: 'bafkart' },
  ],
};

function open(draft: EventDraft = READY, id = 'd-42'): void {
  store = [{ id, updatedAt: 1_000, data: draft }];
  render(
    <MemoryRouter initialEntries={[`/org/new/${id}/tickets`]}>
      <Routes>
        <Route path="/org/new/:draftId/tickets" element={<TicketSettings />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function create(): Promise<void> {
  await waitFor(() => expect(screen.getAllByLabelText(copy.tiers.name)[0]).toHaveValue('일반'));
  await userEvent.setup().click(screen.getByRole('button', { name: copy.tiers.create }));
}

beforeAll(() => {
  URL.createObjectURL = () => 'blob:art';
  URL.revokeObjectURL = () => undefined;
});

beforeEach(() => {
  localStorage.clear();
  store = [];
  ticketOp.mockResolvedValue({ success: true, logs: [CREATED_LOG] });
  resolveSubmittedOp.mockResolvedValue({ state: 'pending', logs: [] });
  pinEventMetadata.mockResolvedValue({ metadataCid: 'bafyMeta' });
  saveEventArt.mockResolvedValue({ ok: true });
  setEventPrivate.mockResolvedValue({ ok: true });
});

describe('the publish path', () => {
  it('pins, creates, saves the pictures and throws the draft away, in that order', async () => {
    open();
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());

    // 1. the readable half, with the tags normalised exactly as the server would.
    expect(pinEventMetadata).toHaveBeenCalledWith({
      orgId: '9',
      meta: {
        name: '재즈 나이트',
        description: '한남동 라이브',
        imageCid: 'bafkposter',
        category: 2,
        region: 'KR-11',
        venue: '서울 용산구 한남동',
        tags: ['재즈', '라이브'],
        venueHidden: false,
        timeHidden: false,
      },
    });

    // 2. one sponsored `createEvent`, built by the same helper the wizard uses.
    const sent = ticketOp.mock.calls[0]?.[0] as SentOp;
    expect(sent.functionName).toBe('createEvent');
    expect(sent.orgId).toBe(9n);
    expect(sent.args[0]).toMatchObject({
      imageCid: 'bafyMeta',
      // The trimmed title is what is hashed, because the trimmed title is what is pinned.
      titleHash: keccak256(toBytes('재즈 나이트')),
      venueHash: keccak256(toBytes('서울 용산구 한남동')),
      regionCode: keccak256(toBytes('KR-11')),
      transferCutoffSeconds: 7_200,
      // Never asked for on screen, and there is one right answer for each.
      approvalRequired: false,
      maxTransfers: 3,
      // Sign-ups close when the event ends; they opened when it was created.
      saleEnd: BigInt(READY.endsAt),
    });
    // Derived rather than asked for: open now, close when the event ends. `createEvent` only
    // asks that the two are the right way round, and this pair always is.
    const meta = sent.args[0] as { saleStart: bigint; saleEnd: bigint };
    expect(meta.saleStart).toBeLessThan(meta.saleEnd);
    expect(Number(meta.saleStart)).toBeCloseTo(Math.floor(Date.now() / 1_000), -1);
    expect(sent.args[1]).toEqual([
      { name: '일반', priceUsdCents: 0n, supply: 100, minted: 0, maxPerWallet: 2, seated: false },
      { name: '학생', priceUsdCents: 0n, supply: 20, minted: 0, maxPerWallet: 1, seated: false },
    ]);

    // 3. the pictures, in tier order, as letters and CIDs and nothing else.
    expect(saveEventArt).toHaveBeenCalledWith({
      eventId: '12',
      tiers: [{ preset: 'c' }, { imageCid: 'bafkart' }],
    });

    // 4. nothing is hidden, so there is no private record to write.
    expect(setEventPrivate).not.toHaveBeenCalled();

    // 5. the draft is gone — one that outlived its event is a second event waiting to happen.
    expect(deleteEventDraft).toHaveBeenCalledWith('d-42');
  });

  it('keeps a hidden venue out of the pin and puts it behind the callable instead', async () => {
    open({ ...READY, venueHidden: true, timeHidden: true });
    await create();
    await waitFor(() => expect(setEventPrivate).toHaveBeenCalledWith({
      eventId: '12', venue: '서울 용산구 한남동',
    }));

    const pinned = pinEventMetadata.mock.calls[0]?.[0];
    expect(Object.hasOwn(pinned?.meta ?? {}, 'venue')).toBe(false);
    expect(pinned?.meta).toMatchObject({ venueHidden: true, timeHidden: true });
    // The chain still carries the hash of the *real* venue, so the claim stays provable.
    const sent = ticketOp.mock.calls[0]?.[0] as SentOp;
    expect(sent.args[0]).toMatchObject({ venueHash: keccak256(toBytes('서울 용산구 한남동')) });
  });

  it('carries on to the event when the pictures did not save: the event exists', async () => {
    saveEventArt.mockRejectedValue(new Error('offline'));
    open();
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    expect(deleteEventDraft).toHaveBeenCalledWith('d-42');
  });
});

describe('when it does not land', () => {
  it('remembers the operation on a timeout and asks after it rather than sending a second', async () => {
    const user = userEvent.setup();
    ticketOp.mockRejectedValue(new OpReverted('createEvent', 'TIMEOUT', SUBMITTED));
    open();
    await create();
    expect(await screen.findByText(copy.publish.confirming)).toBeInTheDocument();
    expect(ticketOp).toHaveBeenCalledTimes(1);

    // Pressing again asks the bundler what became of the first one. It is still pending.
    await user.click(screen.getByRole('button', { name: copy.tiers.create }));
    await waitFor(() => expect(resolveSubmittedOp).toHaveBeenCalledWith(SUBMITTED));
    expect(ticketOp).toHaveBeenCalledTimes(1);
  });

  it('finishes the event a timed-out operation actually created', async () => {
    resolveSubmittedOp.mockResolvedValue({ state: 'landed', logs: [CREATED_LOG] });
    open({ ...READY, submittedOpHash: SUBMITTED });
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    expect(ticketOp).not.toHaveBeenCalled();
    expect(saveEventArt).toHaveBeenCalled();
  });

  it('shows the organiser notice when nothing agreed to pay for the operation', async () => {
    ticketOp.mockRejectedValue(new Error('AA33 reverted: SelectorNotAllowed'));
    open();
    await create();
    expect(await screen.findByText(new RegExp(organizerCopy.ko.wizard.unsponsored))).toBeInTheDocument();
    expect(deleteEventDraft).not.toHaveBeenCalled();
  });

  it('names the rule when the chain refuses the organisation', async () => {
    ticketOp.mockRejectedValue(
      new OpReverted('createEvent', encodeErrorResult({ abi: ticketAbi, errorName: 'Unauthorized' })),
    );
    open();
    await create();
    expect(await screen.findByText(copy.publishProblems.notYourOrg)).toBeInTheDocument();
  });

  it('names a refused tag rather than blaming the connection', async () => {
    pinEventMetadata.mockRejectedValue({ code: 'invalid-argument', message: 'BAD_TAGS' });
    open();
    await create();
    expect(await screen.findByText(copy.publishProblems.badTags)).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
  });
});
