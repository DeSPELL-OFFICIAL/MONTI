import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeErrorResult, encodeEventTopics, keccak256, numberToHex, toBytes } from 'viem';
import { ticketAbi } from '../../shared/chain/abis';

/**
 * The argument as the callable takes it (functions/src/functions/organizer.ts `requireMeta`),
 * typed here so the recorded call can be read field by field rather than only compared whole —
 * `category` is the one value whose *type* matters as much as its value. The picture is a
 * separate call now, and `meta.imageCid` is what carries its CID across.
 */
interface PinCall {
  orgId: string;
  meta: {
    name: string; description: string; imageCid: string;
    venue: string; category: number; region: string;
  };
}

const pinEventImage = vi.fn(async (_args: { bytesBase64: string; kind: string }) => ({
  cid: 'bafkImage',
}));
const pinEventMetadata = vi.fn(async (_args: PinCall) => ({ metadataCid: 'bafyMeta' }));
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { pinEventImage, pinEventMetadata },
}));

interface SentOp { functionName: string; orgId: bigint; args: readonly unknown[] }
const TICKET = `0x${'33'.repeat(20)}` as const;

// `createdEventId` filters the operation's logs by the Ticket address, so the config it reads
// is pinned here rather than taken from a developer's `.env.local`.
vi.mock('../../shared/config', async (orig) => ({
  ...(await orig<typeof import('../../shared/config')>()),
  getConfig: () => ({ addresses: { ticket: TICKET } }),
}));

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

// Only `useNavigate` is stubbed; `MemoryRouter` and the route table stay real, so where the
// confirmation sends the organiser is checked rather than guessed at.
const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { OpReverted } = await import('../../shared/chain/ops');
const { organizerCopy } = await import('../copy');
const { DRAFT_KEY } = await import('./useWizard');
const { OrganizerRoutes } = await import('../Layout');
const copy = organizerCopy.ko.wizard;

/** A `userOpHash` shape; the value itself is only ever carried, never read. */
const SUBMITTED = `0x${'11'.repeat(32)}` as const;

const READY = {
  orgId: '9',
  title: '재즈 나이트',
  description: '한남동 라이브',
  image: { base64: 'AQID', mime: 'image/png', fileName: 'cover.png' },
  venue: '서울 용산구 한남동',
  regionCode: 'KR-11',
  category: 0,
  startsAt: 1_790_000_000, endsAt: 1_790_010_000,
  saleStart: 1_789_000_000, saleEnd: 1_789_900_000,
  transferable: true, transferCutoffHours: 2, maxTransfers: 3, approvalRequired: false,
  requireKyc: false,
  tiers: [{ name: '일반', supply: 100, maxPerWallet: 2, seated: false }],
  gates: ['정문'],
  submittedOpHash: '',
};

function open(draft: unknown = READY) {
  if (draft !== null) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  render(
    // The six-step wizard moved aside when the creation scene took `/org/new` (T-EV-W3);
    // it still stands at `/org/new/old` until T-EV-W10 deletes it.
    <MemoryRouter initialEntries={['/new/old']}>
      <OrganizerRoutes />
    </MemoryRouter>,
  );
}

/** Next through steps 1–5 to land on the review. */
async function toReview(user: ReturnType<typeof userEvent.setup>) {
  for (let step = 1; step < 6; step += 1) {
    await user.click(screen.getByRole('button', { name: copy.next }));
  }
  expect(screen.getByRole('heading', { name: copy.step6 })).toBeInTheDocument();
}

beforeEach(() => {
  localStorage.clear();
  ticketOp.mockResolvedValue({ success: true, logs: [CREATED_LOG] });
  resolveSubmittedOp.mockResolvedValue({ state: 'pending', logs: [] });
});

describe('the six-step wizard', () => {
  it('shows one step at a time and walks to the review', async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByRole('heading', { name: copy.step1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: copy.step4 })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.next }));
    expect(screen.getByRole('heading', { name: copy.step2 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.back }));
    expect(screen.getByRole('heading', { name: copy.step1 })).toBeInTheDocument();
  });

  it('keeps what was typed on this device', async () => {
    const user = userEvent.setup();
    open(null);
    await user.type(screen.getByLabelText(copy.title), '재즈 나이트');
    await user.type(screen.getByLabelText(copy.orgId), '9');
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}')).toMatchObject({
      title: '재즈 나이트', orgId: '9',
    });
  });

  it('narrows a chosen picture to what the server takes, and never sends it from here', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    open(null);
    await user.upload(
      screen.getByLabelText(copy.image),
      new File([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' }),
    );
    await waitFor(() => expect(screen.getByText(/cover\.png/)).toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}').image).toEqual({
      base64: 'AQID', mime: 'image/png', fileName: 'cover.png',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The picker itself offers only the three types the server takes, so a file it would refuse
  // is not reachable from here; `pinata.test.ts` covers the refusal for one chosen any other way.
  it('offers only the picture types the server takes', () => {
    open(null);
    expect(screen.getByLabelText(copy.image)).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
  });
});

describe('the review step', () => {
  it('spells out what is recorded, hashes included', async () => {
    const user = userEvent.setup();
    open();
    await toReview(user);
    expect(screen.getByText(READY.title)).toBeInTheDocument();
    expect(screen.getByText(READY.description)).toBeInTheDocument();
    expect(screen.getByText(READY.venue)).toBeInTheDocument();
    expect(screen.getByText(copy.reviewHashed)).toBeInTheDocument();
    expect(screen.getByText(copy.feeNote)).toBeInTheDocument();
  });

  it('pins through the backend and sends createEvent as one sponsored operation', async () => {
    const user = userEvent.setup();
    open();
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));

    await waitFor(() => expect(ticketOp).toHaveBeenCalled());
    expect(pinEventImage).toHaveBeenCalledWith({ bytesBase64: 'AQID', kind: 'poster' });
    expect(pinEventMetadata).toHaveBeenCalledWith({
      orgId: '9',
      meta: {
        name: READY.title,
        description: READY.description,
        imageCid: 'bafkImage',
        venue: READY.venue,
        category: READY.category,
        region: READY.regionCode,
      },
    });
    // Two things `toHaveBeenCalledWith` alone would let through. The theme has to arrive as a
    // number: the server would coerce a numeric string, but the attendee reader takes the pinned
    // `category` only when `typeof === 'number'` (`shared/envio/ipfs.ts`), so a string would read
    // as the default `0` everywhere. And the region has to be the ISO code, the same value hashed
    // into `regionCode` just below, not its label.
    const pinned = pinEventMetadata.mock.calls[0]?.[0];
    expect(typeof pinned?.meta.category).toBe('number');
    expect(pinned?.meta.region).toBe('KR-11');

    const sent = ticketOp.mock.calls[0]?.[0] as SentOp;
    expect(sent.functionName).toBe('createEvent');
    expect(sent.orgId).toBe(9n);
    // The metadata document's CID, not the picture's: this is what the discover screens read.
    expect(sent.args[0]).toMatchObject({
      imageCid: 'bafyMeta',
      titleHash: keccak256(toBytes(READY.title)),
      regionCode: keccak256(toBytes('KR-11')),
      transferCutoffSeconds: 7200,
    });
    expect(sent.args[1]).toEqual([
      { name: '일반', priceUsdCents: 0n, supply: 100, minted: 0, maxPerWallet: 2, seated: false },
    ]);

    await waitFor(() => expect(screen.getByText(copy.published)).toBeInTheDocument());
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  /**
   * The id is in the operation's own `EventCreated` log (`Ticket.sol:177`). Without it the
   * organiser has to be asked to type the number of the event they just made.
   */
  it('opens the event it just created, from the id in its own log', async () => {
    const user = userEvent.setup();
    open();
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));

    await user.click(await screen.findByRole('button', { name: copy.openEvent }));
    expect(navigate).toHaveBeenCalledWith('/org/events/12');
  });

  /** A `wait` that gave up carries no log, so the number is typed in on the home screen. */
  it('falls back to the home screen when the receipt carries no log', async () => {
    const user = userEvent.setup();
    ticketOp.mockResolvedValueOnce({ success: true, logs: [] });
    open();
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));

    await user.click(await screen.findByRole('button', { name: copy.heading }));
    expect(navigate).toHaveBeenCalledWith('/org');
  });

  it('blocks a draft the chain would revert on, naming each rule', async () => {
    const user = userEvent.setup();
    open({
      ...READY,
      endsAt: READY.startsAt,
      tiers: [{ name: '', supply: 0, maxPerWallet: 2, seated: false }],
    });
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));

    expect(await screen.findByText(copy.problems.schedule)).toBeInTheDocument();
    expect(screen.getByText(copy.problems.tierName)).toBeInTheDocument();
    expect(screen.getByText(copy.problems.tierSupply)).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
    expect(pinEventMetadata).not.toHaveBeenCalled();
  });

  it('names the rule when the chain reverts anyway', async () => {
    const user = userEvent.setup();
    ticketOp.mockRejectedValueOnce(
      new OpReverted('createEvent', encodeErrorResult({ abi: ticketAbi, errorName: 'Unauthorized' })),
    );
    open();
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));
    expect(await screen.findByText(copy.problems.notYourOrg)).toBeInTheDocument();
  });

  /**
   * Until sub-plan 01b's `setAllowed`, the paymaster sponsors no organiser selector, so the
   * operation is refused before it is ever sent. That is the one place this app says it out
   * loud — and it says it to an organiser, never to an attendee.
   */
  it('says plainly when nothing will pay for the write yet', async () => {
    const user = userEvent.setup();
    ticketOp.mockRejectedValueOnce(
      new Error('UserOperation reverted during simulation with reason: SelectorNotAllowed()'),
    );
    open();
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));
    expect(await screen.findByText(new RegExp(copy.unsponsored))).toBeInTheDocument();
    expect(screen.queryByText(copy.failed)).not.toBeInTheDocument();
  });

  it('treats a wait that gave up as still confirming, not as a failure', async () => {
    const user = userEvent.setup();
    ticketOp.mockRejectedValueOnce(new OpReverted('createEvent', 'TIMEOUT'));
    open();
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));
    expect(await screen.findByText(copy.confirming)).toBeInTheDocument();
    expect(screen.queryByText(copy.failed)).not.toBeInTheDocument();
  });

  /**
   * A timeout is not a failure, and the draft outlives the page. Without the hash a reload and
   * a second Publish send a second `createEvent` — and two of those are two events, each with
   * its own id, its own tickets and its own room. The hash turns the next attempt into a
   * question for the bundler.
   */
  it('remembers the operation a wait gave up on, in the draft', async () => {
    const user = userEvent.setup();
    ticketOp.mockRejectedValueOnce(new OpReverted('createEvent', 'TIMEOUT', SUBMITTED));
    open();
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));

    await screen.findByText(copy.confirming);
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}')).toMatchObject({
        submittedOpHash: SUBMITTED,
      }),
    );
  });

  it('asks after that operation instead of sending a second one', async () => {
    const user = userEvent.setup();
    resolveSubmittedOp.mockResolvedValue({ state: 'pending', logs: [] });
    open({ ...READY, submittedOpHash: SUBMITTED });
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));

    await waitFor(() => expect(resolveSubmittedOp).toHaveBeenCalledWith(SUBMITTED));
    expect(await screen.findByText(copy.confirming)).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
    expect(pinEventMetadata).not.toHaveBeenCalled();
  });

  it('shows the confirmation when that operation turns out to have landed', async () => {
    const user = userEvent.setup();
    resolveSubmittedOp.mockResolvedValue({ state: 'landed', logs: [CREATED_LOG] });
    open({ ...READY, submittedOpHash: SUBMITTED });
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));

    expect(await screen.findByText(copy.published)).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    // It landed after all, so its log names the event the organiser is now sent to.
    await user.click(screen.getByRole('button', { name: copy.openEvent }));
    expect(navigate).toHaveBeenCalledWith('/org/events/12');
  });

  it('sends the draft again once that operation is known to have reverted', async () => {
    const user = userEvent.setup();
    resolveSubmittedOp.mockResolvedValue({ state: 'failed', logs: [] });
    open({ ...READY, submittedOpHash: SUBMITTED });
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));

    await waitFor(() =>
      expect(ticketOp).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'createEvent' })),
    );
  });

  /** A bundler that cannot be reached is not "it failed" — nothing new may be sent on that. */
  it('sends nothing when the bundler cannot say what became of it', async () => {
    const user = userEvent.setup();
    resolveSubmittedOp.mockRejectedValue(new Error('offline'));
    open({ ...READY, submittedOpHash: SUBMITTED });
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));

    expect(await screen.findByText(copy.confirming)).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('refuses the organisation the server refuses', async () => {
    const user = userEvent.setup();
    pinEventMetadata.mockRejectedValueOnce(
      Object.assign(new Error('NOT_YOUR_ORG'), { code: 'permission-denied' }),
    );
    open();
    await toReview(user);
    await user.click(screen.getByRole('button', { name: copy.publish }));
    expect(await screen.findByText(copy.problems.notYourOrg)).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('warns that an approval-only event is one nobody could get a ticket for', async () => {
    const user = userEvent.setup();
    open({ ...READY, approvalRequired: true });
    await toReview(user);
    expect(screen.getByText(copy.approvalWarning)).toBeInTheDocument();
  });
});
