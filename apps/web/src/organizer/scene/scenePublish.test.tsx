import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeErrorResult, encodeEventTopics, keccak256, numberToHex, toBytes } from 'viem';
import { ticketAbi } from '../../shared/chain/abis';
import type { EventDraft, StoredEventDraft } from '../../shared/api/firestore';
import { ko as sharedKo } from '../../shared/copy/index';

let store: StoredEventDraft[] = [];
const listEventDrafts = vi.fn(async () => [...store].sort((a, b) => b.updatedAt - a.updatedAt));
const saveEventDraft = vi.fn(async (_id: string, _draft: EventDraft) => undefined);
const deleteEventDraft = vi.fn(async (id: string) => {
  store = store.filter((row) => row.id !== id);
});
const loadMyProfile = vi.fn(async () => ({ displayName: '김태완' }));
vi.mock('../../shared/api/firestore', () => ({
  listEventDrafts, saveEventDraft, deleteEventDraft, loadMyProfile,
}));
/** The indexer's answer about this person as an organiser, which the scene now reads too. */
const orgRefetch = vi.fn(async () => [] as { orgId: string; canCreateEvent: boolean }[]);
const orgsListed = vi.fn(() => [] as { orgId: string; canCreateEvent: boolean }[]);
vi.mock('../useMyOrgs', () => ({
  useMyOrgs: () => ({
    orgs: orgsListed(), canCreateEvent: false, isLoading: false, isError: false,
    error: null, refetch: orgRefetch,
  }),
}));


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

const OP_HASH = `0x${'22'.repeat(32)}` as const;
const ticketOp = vi.fn(async (_options: SentOp) => ({
  success: true, userOpHash: OP_HASH, logs: [CREATED_LOG],
}));
const resolveSubmittedOp = vi.fn(async (_hash: string, _submittedAt?: number) => ({
  state: 'pending' as 'pending' | 'landed' | 'failed' | 'stale',
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

// The default-poster rasteriser needs a canvas jsdom does not have, so it is stubbed to raw
// base64; that the create path renders and pins it is what is under test (T-SIMP-9).
vi.mock('./autoPoster', () => ({
  renderAutoPoster: vi.fn(async () => 'AUTO64'),
  buildPosterSvg: () => '<svg/>',
}));

const { OpReverted } = await import('../../shared/chain/ops');
const { CreateEvent } = await import('./CreateEvent');
const { emptyEventDraft, emptyEventDraftTier } = await import('../useEventDraft');
const { organizerCopy } = await import('../copy');
const copy = organizerCopy.ko.scene;

/** Where a navigation landed, and what it carried — the handover is what the retry runs on. */
let handed: unknown = null;
function handover(): unknown {
  return handed;
}
function Probe() {
  const location = useLocation();
  handed = location.state;
  return <p>{`landed:${location.pathname}`}</p>;
}

const SUBMITTED = `0x${'11'.repeat(32)}` as const;

const READY: EventDraft = {
  ...emptyEventDraft,
  orgId: '9',
  title: '  재즈 나이트  ',
  description: '한남동 재즈 라이브 공연',
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
    <MemoryRouter initialEntries={[`/org/new/${id}`]}>
      <Routes>
        <Route path="/org/new/:draftId" element={<CreateEvent />} />
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
  handed = null;
  ticketOp.mockResolvedValue({ success: true, userOpHash: OP_HASH, logs: [CREATED_LOG] });
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
        description: '한남동 재즈 라이브 공연',
        imageCid: 'bafkposter',
        category: 2,
        region: 'KR-11',
        venue: '서울 용산구 한남동',
        tags: ['재즈', '라이브'],
        venueHidden: false,
        timeHidden: false,
      },
    });

    // 2. one sponsored `createEvent`, built by the one helper that owns the hashing.
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

  /**
   * The end time is behind `더 설정하기` and most organisers never open it (plan section B-3),
   * so the number that reaches `Ticket.EventMeta` is almost always the derived one. `EventMeta`
   * is written once and `updateEventMeta` closes at publish: an `endsAt` of 0 here would be an
   * event that ended in 1970, with sign-ups closed before they opened, and nothing could repair
   * it. Every reader goes through `endsAtOf`, and this is the one that proves the chain does.
   */
  it('sends the derived end, and closes sign-ups on it, when nobody opened the fold', async () => {
    open({ ...READY, endsAt: 0 });
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());

    const derived = BigInt(READY.startsAt + 7_200);
    const meta = ticketOp.mock.calls[0]?.[0].args[0] as {
      startsAt: bigint; endsAt: bigint; saleStart: bigint; saleEnd: bigint;
    };
    expect(meta.endsAt).toBe(derived);
    // `Ticket.createEvent` only asks that `saleStart < saleEnd`; the derived end is what makes
    // that true without a second date field ever being shown.
    expect(meta.saleEnd).toBe(derived);
    expect(meta.saleStart).toBeLessThan(meta.saleEnd);
    expect(meta.startsAt).toBeLessThan(meta.endsAt);
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

  /**
   * The event is on chain and the hidden venue exists nowhere else — the public document has
   * no `venue` key and `updateEventMeta` refuses anything past Draft. So the draft is held
   * open until both writes land, and the done screen is handed everything needed to finish.
   */
  it('keeps the draft when a follow-up did not land, and carries the retry across', async () => {
    saveEventArt.mockRejectedValue(new Error('offline'));
    open({ ...READY, venueHidden: true });
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    expect(deleteEventDraft).not.toHaveBeenCalled();

    const state = handover() as {
      followUpFailed: boolean; draftId: string;
      plan: { eventId: string; venue: string | null; tiers: unknown[] };
      done: { artSaved: boolean; venueSaved: boolean };
    };
    expect(state.followUpFailed).toBe(true);
    expect(state.draftId).toBe('d-42');
    expect(state.plan).toMatchObject({ eventId: '12', venue: '서울 용산구 한남동' });
    // The venue went through even though the pictures did not: one refusal must not take the
    // other write down with it.
    expect(state.done).toEqual({ artSaved: false, venueSaved: true });
  });

  it('records the id on the draft before anything that could still fail', async () => {
    saveEventArt.mockRejectedValue(new Error('offline'));
    open();
    await create();
    await waitFor(() => expect(saveEventDraft).toHaveBeenCalled());
    const written = saveEventDraft.mock.calls.at(-1)?.[1] as { createdEventId?: string } | undefined;
    expect(written?.createdEventId).toBe('12');
  });

  it('never sends a second createEvent for a draft that already made one', async () => {
    open({ ...READY, createdEventId: '12' });
    await create();
    await waitFor(() => expect(saveEventArt).toHaveBeenCalled());
    expect(ticketOp).not.toHaveBeenCalled();
    expect(pinEventMetadata).not.toHaveBeenCalled();
  });

  /**
   * The poster is optional (plan B-2): a draft with an empty `posterCid` gets a default A4 poster
   * synthesised from its title and theme backdrop, pinned through the same `pinEventImage` path an
   * uploaded one takes — so the readable metadata still carries an `imageCid`.
   */
  it('auto-generates and pins a default poster when the draft has none (T-SIMP-9)', async () => {
    open({ ...READY, posterCid: '' });
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    expect(pinEventImage).toHaveBeenCalledWith({ bytesBase64: 'AUTO64', kind: 'poster' });
    const pinned = pinEventMetadata.mock.calls.at(-1)?.[0];
    expect(pinned?.meta.imageCid).toBe('bafkposter');
  });
});

describe('when it does not land', () => {
  it('remembers the operation on a timeout and asks after it rather than sending a second', async () => {
    const user = userEvent.setup();
    ticketOp.mockRejectedValue(new OpReverted('createEvent', 'TIMEOUT', SUBMITTED));
    open();
    await create();
    // The scene shows the determinate wait's 확인 중 step, not an info-alert stacked on it (계획 §2a).
    await waitFor(() => expect(
      document.querySelector('.op-progress .steps__step--current .steps__label')?.textContent,
    ).toBe(sharedKo.op.confirming));
    expect(ticketOp).toHaveBeenCalledTimes(1);

    // Pressing again asks the bundler what became of the first one. It is still pending.
    await user.click(screen.getByRole('button', { name: copy.tiers.create }));
    await waitFor(() => expect(resolveSubmittedOp).toHaveBeenCalledWith(SUBMITTED, expect.any(Number)));
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

  /**
   * A recorded op that will never land — dropped, reverted, or stuck in the mempool underpriced
   * or too old (task-create-failure-4). The guard clears it and sends one fresh createEvent with
   * the corrected fees; the undeployed account's deployment nonce keeps the two mutually
   * exclusive, so exactly one event is ever made.
   */
  it('clears a stale op and sends one fresh createEvent, naming the resend', async () => {
    resolveSubmittedOp.mockResolvedValue({ state: 'stale', logs: [] });
    let releasePin = (): void => undefined;
    pinEventMetadata.mockReturnValueOnce(
      new Promise((resolve) => { releasePin = () => resolve({ metadataCid: 'bafyMeta' }); }),
    );
    open({ ...READY, submittedOpHash: SUBMITTED });
    await create();
    // The organiser is told the earlier request expired while the resend is on its way.
    expect(await screen.findByText(copy.publishProblems.opExpired)).toBeInTheDocument();
    releasePin();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    expect(resolveSubmittedOp).toHaveBeenCalledWith(SUBMITTED, expect.any(Number));
    expect(ticketOp).toHaveBeenCalledTimes(1);
  });

  it('clears a failed op and sends one fresh createEvent, with no resend notice', async () => {
    resolveSubmittedOp.mockResolvedValue({ state: 'failed', logs: [] });
    open({ ...READY, submittedOpHash: SUBMITTED });
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    expect(ticketOp).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(copy.publishProblems.opExpired)).toBeNull();
  });

  it('shows the organiser notice when nothing agreed to pay for the operation', async () => {
    ticketOp.mockRejectedValue(new Error('AA33 reverted: SelectorNotAllowed'));
    open();
    await create();
    expect(await screen.findByText(new RegExp(organizerCopy.ko.unsponsored.notice))).toBeInTheDocument();
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

  /**
   * The receipt landed but no `EventCreated` came out of its logs. The event exists and
   * nothing can address it, so the draft — the only place its venue and pictures still are —
   * stays, and the organiser is told rather than dropped on the home screen without a word.
   */
  it('says so when the event was made but its number could not be read', async () => {
    ticketOp.mockResolvedValue({ success: true, userOpHash: OP_HASH, logs: [] });
    open();
    await create();
    expect(await screen.findByText(copy.publishProblems.noEventId)).toBeInTheDocument();
    expect(screen.queryByText(/^landed:/)).toBeNull();
    expect(deleteEventDraft).not.toHaveBeenCalled();
    expect(saveEventArt).not.toHaveBeenCalled();
  });

  /**
   * The operation landed — the event is on chain — but its logs named nothing this side could
   * read. The only safe way on is to ask the bundler again **by hash**, so the hash is the
   * first thing written, and the button that invites another press can only resolve.
   */
  it('records the operation hash before anything else and never sends a second createEvent', async () => {
    const user = userEvent.setup();
    ticketOp.mockResolvedValue({ success: true, userOpHash: OP_HASH, logs: [] });
    open();
    await create();
    await screen.findByText(copy.publishProblems.noEventId);

    await waitFor(() => expect(saveEventDraft).toHaveBeenCalled());
    const written = saveEventDraft.mock.calls.at(-1)?.[1] as { submittedOpHash?: string };
    expect(written.submittedOpHash).toBe(OP_HASH);

    // The press the copy asks for. It resolves; it does not create.
    expect(screen.getByRole('button', { name: copy.tiers.create })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: copy.tiers.create }));
    await waitFor(() => expect(resolveSubmittedOp).toHaveBeenCalledWith(OP_HASH, expect.any(Number)));
    expect(ticketOp).toHaveBeenCalledTimes(1);
    expect(pinEventMetadata).toHaveBeenCalledTimes(1);
  });

  it('finds the id on that second press and finishes the event', async () => {
    const user = userEvent.setup();
    ticketOp.mockResolvedValue({ success: true, userOpHash: OP_HASH, logs: [] });
    resolveSubmittedOp.mockResolvedValue({ state: 'landed', logs: [CREATED_LOG] });
    open();
    await create();
    await screen.findByText(copy.publishProblems.noEventId);

    await user.click(screen.getByRole('button', { name: copy.tiers.create }));
    await waitFor(() => expect(saveEventArt).toHaveBeenCalledWith({
      eventId: '12', tiers: [{ preset: 'c' }, { imageCid: 'bafkart' }],
    }));
    expect(await screen.findByText('landed:/org/new/done/12')).toBeInTheDocument();
    expect(ticketOp).toHaveBeenCalledTimes(1);
  });

  it('stays on the resolve route when the bundler still cannot name it', async () => {
    const user = userEvent.setup();
    ticketOp.mockResolvedValue({ success: true, userOpHash: OP_HASH, logs: [] });
    resolveSubmittedOp.mockResolvedValue({ state: 'landed', logs: [] });
    open();
    await create();
    await screen.findByText(copy.publishProblems.noEventId);

    await user.click(screen.getByRole('button', { name: copy.tiers.create }));
    await waitFor(() => expect(resolveSubmittedOp).toHaveBeenCalled());
    // Still no id, still no second operation, and the hash is still on the draft.
    expect(ticketOp).toHaveBeenCalledTimes(1);
    expect(screen.getByText(copy.publishProblems.noEventId)).toBeInTheDocument();
    const written = saveEventDraft.mock.calls.at(-1)?.[1] as { submittedOpHash?: string };
    expect(written.submittedOpHash).toBe(OP_HASH);
  });

  it('names a refused tag rather than blaming the connection', async () => {
    pinEventMetadata.mockRejectedValue({ code: 'invalid-argument', message: 'BAD_TAGS' });
    open();
    await create();
    expect(await screen.findByText(copy.publishProblems.badTags)).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
  });
});

/**
 * expert-3 "minimum event": the founder's "동아리 공연, 내일 저녁, 무료 30명". With the batch-2/P1
 * defaults in force (auto poster on publish, next-Saturday start, optional 소개, optional 장소,
 * 수량 100, 서울, 종류 '일반') the only field still needing input on a fresh /org/new is the title;
 * everything else is defaulted, so the minimum is title + one tap on 행사 만들기 — two actions.
 */
function openFresh(): void {
  render(
    <MemoryRouter initialEntries={['/org/new']}>
      <Routes>
        <Route path="/org/new" element={<CreateEvent />} />
        <Route path="/org/new/:draftId" element={<CreateEvent />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the minimum event', () => {
  it('reaches a published event in two actions (title + 행사 만들기)', async () => {
    // One team already exists, so no organiser-name tap is needed either.
    orgsListed.mockReturnValue([{ orgId: '9', canCreateEvent: true }]);
    const user = userEvent.setup();
    openFresh();
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toBeInTheDocument());

    // Count each field entry and the button press as one user action.
    let actions = 0;
    await user.type(screen.getByLabelText(copy.titleLabel), '동아리 공연'); actions += 1;
    await user.click(screen.getByRole('button', { name: copy.tiers.create })); actions += 1;

    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    // The default poster was synthesised and pinned — no poster upload tap was ever needed.
    expect(pinEventImage).toHaveBeenCalledWith({ bytesBase64: 'AUTO64', kind: 'poster' });
    // Measured minimum for the P1 form: 2 actions (title, 행사 만들기). 장소는 이제 선택이다.
    expect(actions).toBe(2);
  });

  /**
   * 장소는 이제 선택이다(P1): 제목만으로도 발행된다. 빈 장소는 빈 문자열로 핀되고 탐색 상세는
   * 기본 라벨 "장소 미정"으로 읽으므로, 장소는 더 이상 세는 동작이 아니다.
   */
  it('publishes with the venue left blank (optional now)', async () => {
    orgsListed.mockReturnValue([{ orgId: '9', canCreateEvent: true }]);
    const user = userEvent.setup();
    openFresh();
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toBeInTheDocument());

    await user.type(screen.getByLabelText(copy.titleLabel), '동아리 공연');
    await user.click(screen.getByRole('button', { name: copy.tiers.create }));

    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    const pinned = pinEventMetadata.mock.calls.at(-1)?.[0];
    expect(pinned?.meta).toMatchObject({ venue: '', venueHidden: false });
  });
});
