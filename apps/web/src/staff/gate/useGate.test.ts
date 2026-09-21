// Two taps, end to end, through the real wiring.
//
// What is mocked here is only what a test cannot have: the HCE bridge, the Keystore, the RPC
// endpoint, the bundler and the backend callables. Everything between them is the shipped code —
// the emitter's rotation and its ring, the NDEF codec, `matchIssuedCode`, the state machine, the
// preflight against a signed guest list, the ABI encoding of the check-in, the `CheckedIn` watch,
// the offline device-signature verify against WebCrypto, and the durable queue on a real (faked)
// IndexedDB. The attendee's signature is a genuine P-256 signature over the digest
// `Ticket.checkIn` recomputes, so the offline admit below is earned rather than stubbed.
//
// The two taps are the two halves of the door and they are deliberately not symmetric: online,
// nothing this device says turns the tap green — the chain does, through a log that names the
// nonce. Offline, the device decides, and it may only do so after the row it will one day send
// has been committed to disk.
import 'fake-indexeddb/auto';

import { p256 } from '@noble/curves/p256';
import { act, renderHook, waitFor } from '@testing-library/react';
import { bytesToHex, encodeAbiParameters, hexToBytes, numberToHex, toEventSelector, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SnapshotTicket, SnapshotWire } from '@monti/shared';

const TICKET_ADDRESS = `0x${'33'.repeat(20)}` as Hex;
const IDENTITY_ADDRESS = `0x${'44'.repeat(20)}` as Hex;
const ORGANIZERS_ADDRESS = `0x${'55'.repeat(20)}` as Hex;
const GATE_ACCOUNT = `0x${'aa'.repeat(20)}` as Hex;
const CHAIN_ID = 10143;
const ZERO32 = `0x${'00'.repeat(32)}` as Hex;

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({}),
}));

vi.mock('../../shared/config', () => ({
  getConfig: () => ({
    chainId: CHAIN_ID,
    addresses: {
      identity: IDENTITY_ADDRESS,
      organizers: ORGANIZERS_ADDRESS,
      ticket: TICKET_ADDRESS,
      paymaster: `0x${'66'.repeat(20)}`,
    },
  }),
}));

// --- the HCE bridge ---------------------------------------------------------------------------
type WriteListener = (event: { ndef: string }) => void;
let onWrite: WriteListener = () => {};
const hce = {
  start: vi.fn(async () => undefined),
  setPayload: vi.fn(async (_payload: { ndef: string }) => undefined),
  stop: vi.fn(async () => undefined),
  addListener: vi.fn(async (_name: string, listener: WriteListener) => {
    onWrite = listener;
    return { remove: async () => undefined };
  }),
};
vi.mock('@monti/hce-android', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@monti/hce-android')>()),
  Hce: hce,
}));

// --- the gate's own key, which lives in the Keystore -------------------------------------------
vi.mock('./gateKey', () => ({
  ensureGateKey: async () => ({ x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}`, backing: 'strongBox' }),
  gateKeyCoordinates: (key: { x: Hex; y: Hex }) => ({ kx: key.x, ky: key.y }),
  signGateCode: async () => ({ r: `0x${'aa'.repeat(32)}`, s: `0x${'01'.repeat(32)}` }),
}));

// --- the RPC endpoint --------------------------------------------------------------------------
const readContract = vi.fn();
const request = vi.fn(async () => '0x279f');
vi.mock('../../shared/chain/client', () => ({ getPublicClient: () => ({ readContract, request }) }));

const stopLogs = vi.fn();
const subscribeLogs = vi.fn((_watch: { onLog: (log: unknown) => void }) => stopLogs);
vi.mock('../../shared/chain/subscribeLogs', () => ({ subscribeLogs }));

// --- the bundler -------------------------------------------------------------------------------
/** `SponsoredOpReceipt` — typed here so a test can hand back a revert or the TIMEOUT sentinel. */
type Receipt = { success: boolean; txHash: Hex; blockNumber: bigint; revertReason?: Hex | 'TIMEOUT' };
const OK: Receipt = { success: true, txHash: `0x${'77'.repeat(32)}`, blockNumber: 99n };
const wait = vi.fn<() => Promise<Receipt>>(async () => OK);
const sendSponsoredOp = vi.fn(async (_args: { orgId: bigint }) => ({
  userOpHash: `0x${'88'.repeat(32)}` as Hex,
  wait,
}));
vi.mock('../../shared/chain/sendSponsoredOp', () => ({ sendSponsoredOp, MIN_VERIFICATION_GAS: 150_000n }));
vi.mock('../../shared/chain/gateAccount', () => ({
  getGateSmartAccount: async () => ({ address: GATE_ACCOUNT }),
  getGateAddress: async () => GATE_ACCOUNT,
}));

// --- the staff member's own passkey account, which is NOT the gate's --------------------------
// Check-ins go out as `0xaa…` (the terminal); manual approvals go out as `0xbb…` (the person).
// Every assertion about an override below reads that address back off the operation.
const STAFF_ACCOUNT = `0x${'bb'.repeat(20)}` as Hex;
vi.mock('../../shared/chain/accounts', () => ({
  getStaffAccount: async () => ({ address: STAFF_ACCOUNT }),
}));

// --- the backend callables ----------------------------------------------------------------------
const issueSnapshot = vi.fn(async () => {
  throw new Error('offline');
});
const getPhotoForGate = vi.fn(async () => ({ photoJpegB64: 'FETCHED', displayName: '김입장' }));
vi.mock('../../shared/api/functions', () => ({ issueSnapshot, getPhotoForGate }));

const { decodeGateCodeMessage, encodeGateResponseMessage } = await import('../../shared/nfc/ndef');
const { fromBase64, toBase64 } = await import('@monti/hce-android');
const { checkInDigest } = await import('../offline/offlineVerify');
const { staffDb } = await import('../snapshot/store');
const { allEntries } = await import('../queue/opQueue');
const { nonceHashOf } = await import('./verdict');
const { useGate } = await import('./useGate');
const { GATE_CODE_ROTATE_MS, GATE_OPEN_RECHECK_MS, GATE_OPEN_STALE_MS, GATE_STATUS_POLL_MS } =
  await import('../constants');
const { DRY_RUN_MARK } = await import('../types');
const { staffKo } = await import('../copy');

// --- the attendee, with a key that really signs -------------------------------------------------
const devicePrivate = p256.utils.randomPrivateKey();
const devicePublic = p256.getPublicKey(devicePrivate, false);
const DEVICE_X = bytesToHex(devicePublic.slice(1, 33));
const DEVICE_Y = bytesToHex(devicePublic.slice(33, 65));

const EVENT_ID = 42n;
const GATE_ID = 7n;
const ORG_ID = 5n;
const TOKEN_ID = '1042';
const params = {
  gateId: GATE_ID,
  eventId: EVENT_ID,
  orgId: ORG_ID,
  gateAccount: GATE_ACCOUNT,
  enabled: true,
};

function ticket(overrides: Partial<SnapshotTicket> = {}): SnapshotTicket {
  return {
    tokenId: TOKEN_ID,
    account: `0x${'99'.repeat(20)}`,
    deviceX: DEVICE_X,
    deviceY: DEVICE_Y,
    photoJpegB64: 'FROM-LIST',
    displayName: '김입장',
    tier: 0,
    tierName: 'VIP',
    seat: 'A-12',
    checkedIn: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<SnapshotWire> = {}): SnapshotWire {
  return {
    v: 1,
    eventId: EVENT_ID.toString(),
    eventTitle: '가을 밤 콘서트',
    requireKyc: true,
    epoch: 1,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    tickets: [ticket()],
    attesterSig: ZERO32,
    ...overrides,
  };
}

/**
 * The guest list is written straight into the store rather than fetched, so the attester's
 * signature stays a real check that this file simply does not exercise: `loadSnapshot` serves a
 * stored list unverified, which is exactly the path a gate takes when it reopens without signal.
 */
async function seedSnapshot(wire: SnapshotWire = snapshot()): Promise<void> {
  const db = await staffDb();
  await db.put('snapshots', { eventId: wire.eventId, snapshot: wire, fetchedAt: Date.now() });
}

const EVENT_META = {
  orgId: ORG_ID,
  titleHash: ZERO32,
  descHash: ZERO32,
  imageCid: '',
  startsAt: 1_700_000_000n,
  endsAt: 1_790_000_000n,
  venueHash: ZERO32,
  saleStart: 0n,
  saleEnd: 0n,
  transferable: true,
  transferCutoffSeconds: 0,
  maxTransfers: 0,
  approvalRequired: false,
  category: 0,
  regionCode: ZERO32,
  requireKyc: true,
};

const ZERO_CHECK_IN = { gateId: 0n, ts: 0n, nonceHash: ZERO32, manual: false };

/** What `Organizers` says about the staff member holding the phone. Set per test. */
let managerOf: [boolean, boolean] = [true, true];
let hasPermission = false;
/** What `isOpenGate` does. A test can make the read fail the way a venue's wifi does. */
let openGateAnswer: (() => boolean) = () => true;

/** The code the emitter actually put on the wire, read back off the plugin call. */
function servedCode() {
  const last = hce.setPayload.mock.calls.at(-1)?.[0] as { ndef: string } | undefined;
  if (!last) throw new Error('the gate never served a code');
  return decodeGateCodeMessage(fromBase64(last.ndef));
}

/** One tap: the attendee signs the digest `Ticket.checkIn` recomputes, and writes the answer. */
function tapWith(code: ReturnType<typeof servedCode>, tokenId = TOKEN_ID): void {
  const digest = checkInDigest({ tokenId, code, domain: { chainId: BigInt(CHAIN_ID), ticket: TICKET_ADDRESS } });
  // `lowS` is not noble's default, and Solady's `P256.verifySignature` — what `Ticket.checkIn`
  // calls — returns false on a high `s` before it verifies anything. Task 19 refuses one locally.
  const signature = p256.sign(hexToBytes(digest), devicePrivate, { lowS: true });
  const wire = {
    v: 2 as const,
    tokenId,
    nonce: code.nonce,
    deviceSig: `0x${signature.toCompactHex()}` as Hex,
  };
  onWrite({ ndef: toBase64(encodeGateResponseMessage(wire)) });
}

const CHECKED_IN = toEventSelector('CheckedIn(uint256,uint256,uint256,bytes32,uint64)');
const MANUAL_OVERRIDE = toEventSelector('ManualOverride(uint256,uint256,address,uint8,uint8)');

/** `ManualOverride` as the node reports it: approver in topic 3, role and reason in the body. */
function manualOverrideLog(approver: Hex, role: number, reason: number) {
  return {
    address: TICKET_ADDRESS,
    topics: [
      MANUAL_OVERRIDE,
      numberToHex(BigInt(TOKEN_ID), { size: 32 }),
      numberToHex(GATE_ID, { size: 32 }),
      `0x${'00'.repeat(12)}${approver.slice(2)}`,
    ],
    data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint8' }], [role, reason]),
    blockNumber: '0x64',
    stage: 'finalized',
  };
}

/** A `CheckedIn` exactly as `monadLogs` reports it — quantities as hex strings, not bigints. */
function checkedInLog(nonce: Hex, stage: 'speculative' | 'finalized') {
  return {
    address: TICKET_ADDRESS,
    topics: [
      CHECKED_IN,
      numberToHex(BigInt(TOKEN_ID), { size: 32 }),
      numberToHex(EVENT_ID, { size: 32 }),
      numberToHex(GATE_ID, { size: 32 }),
    ],
    data: encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint64' }],
      [nonceHashOf(nonce), 1_790_000_000n],
    ),
    blockNumber: '0x63',
    stage,
  };
}

/** Hands the log to the watch the machine opened when the operation went out. */
function feedVerdict(log: unknown): void {
  const opened = subscribeLogs.mock.calls.at(-1)?.[0] as { onLog: (l: unknown) => void } | undefined;
  if (!opened) throw new Error('no chain watch was opened for this tap');
  opened.onLog(log);
}

function setRadio(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
}

beforeEach(async () => {
  vi.clearAllMocks();
  wait.mockResolvedValue(OK);
  sendSponsoredOp.mockResolvedValue({ userOpHash: `0x${'88'.repeat(32)}`, wait });
  subscribeLogs.mockReturnValue(stopLogs);
  readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case 'isOpenGate':
        return openGateAnswer();
      case 'managerOf':
        return managerOf;
      case 'hasPermission':
        return hasPermission;
      case 'eventMeta':
        return EVENT_META;
      case 'checkInOf':
        return ZERO_CHECK_IN;
      case 'deviceUpdatedAt':
        return 0n;
      default:
        return 0n;
    }
  });
  setRadio(true);
  managerOf = [true, true];
  hasPermission = false;
  openGateAnswer = () => true;
  const db = await staffDb();
  await Promise.all([
    db.clear('snapshots'),
    db.clear('photos'),
    db.clear('queue'),
    // The PIN and the remembered door answer live here, and both survive a reload by design.
    db.clear('settings'),
  ]);
  await seedSnapshot();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The gate is running and serving codes. Everything below starts from here. */
async function openGate(over: Partial<typeof params> = {}) {
  const rendered = renderHook(() => useGate({ ...params, ...over }));
  await waitFor(() => expect(rendered.result.current.state).toBe('ready'));
  return rendered;
}

/**
 * A check-in already written down, as a restart finds it: taken during a signal drop, committed,
 * and still owed to the chain with no connectivity edge left to carry it out.
 */
async function seedQueueRow(): Promise<void> {
  const db = await staffDb();
  await db.put('queue', {
    id: `${TOKEN_ID}-0xfeed`,
    seq: 1,
    tokenId: TOKEN_ID,
    gateCode: { v: 1, gateId: GATE_ID.toString(), eventId: EVENT_ID.toString(), issuedAt: 1_700_000_000, nonce: `0x${'fe'.repeat(32)}`, kx: ZERO32, ky: ZERO32, sig: ZERO32 },
    response: { v: 2, tokenId: TOKEN_ID, nonce: `0x${'fe'.repeat(32)}`, deviceSig: `0x${'11'.repeat(64)}` },
    createdAt: Date.now(),
    attempts: 0,
    nextAttemptAt: 0,
    status: 'pending',
  });
}

describe('one tap, online', () => {
  it('goes received → confirming → admit, and only the chain turns it green', async () => {
    const { result } = await openGate();
    const code = servedCode();

    await act(async () => {
      tapWith(code);
    });

    // The guest list recognised the ticket and said nothing against it, so the tap was sent.
    await waitFor(() => expect(result.current.state).toBe('confirming'));
    expect(result.current.precheck?.ok).toBe(true);
    expect(sendSponsoredOp).toHaveBeenCalledTimes(1);
    // The operation is sent by the gate's own account against the organizer's budget — a
    // check-in signed by the staff member's passkey reverts `GateMismatch`.
    expect(sendSponsoredOp.mock.calls[0]?.[0]).toMatchObject({ orgId: ORG_ID });

    // A successful receipt is NOT the verdict: the screen is still confirming.
    expect(result.current.state).toBe('confirming');

    await act(async () => {
      feedVerdict(checkedInLog(code.nonce, 'speculative'));
    });
    await waitFor(() => expect(result.current.state).toBe('admit'));
    expect(result.current.finalized).toBe(false);
    expect(result.current.blockNumber).toBe(0x63n);

    // The same log, repeated at the finalized stage, hardens the card rather than re-admitting.
    await act(async () => {
      feedVerdict(checkedInLog(code.nonce, 'finalized'));
    });
    await waitFor(() => expect(result.current.finalized).toBe(true));

    expect(result.current.entriesCount).toBe(1);
    expect(result.current.admittedAt).toBeGreaterThan(0);
    expect(result.current.photo).toBe('FROM-LIST');
    // Online, nothing was written down: the chain is the record.
    expect(await allEntries()).toHaveLength(0);
  });

  it('drops a verdict that names another tap', async () => {
    const { result } = await openGate();
    const code = servedCode();
    await act(async () => {
      tapWith(code);
    });
    await waitFor(() => expect(result.current.state).toBe('confirming'));

    await act(async () => {
      feedVerdict(checkedInLog(`0x${'ee'.repeat(32)}`, 'finalized'));
    });
    expect(result.current.state).toBe('confirming');
  });

  it('turns a revert into the DENY the contract named, without asking the chain twice', async () => {
    wait.mockResolvedValue({
      success: false,
      txHash: `0x${'77'.repeat(32)}`,
      blockNumber: 99n,
      // `AlreadyCheckedIn()`, the selector `Ticket.json` actually declares.
      revertReason: '0xc98289f0',
    });
    const { result } = await openGate();
    await act(async () => {
      tapWith(servedCode());
    });
    await waitFor(() => expect(result.current.state).toBe('deny'));
    expect(result.current.deny).toBe('ALREADY_USED');
  });

  it('stays confirming when the bundler stops answering — a timeout is not a refusal', async () => {
    wait.mockResolvedValue({
      success: false,
      txHash: `0x${'77'.repeat(32)}`,
      blockNumber: 0n,
      revertReason: 'TIMEOUT',
    });
    const { result } = await openGate();
    const code = servedCode();
    await act(async () => {
      tapWith(code);
    });
    await waitFor(() => expect(result.current.waitHint).toBe(true));
    expect(result.current.state).toBe('confirming');

    // And the late log still admits, which is the whole reason the hint is not a state.
    await act(async () => {
      feedVerdict(checkedInLog(code.nonce, 'finalized'));
    });
    await waitFor(() => expect(result.current.state).toBe('admit'));
  });

  it('refuses a ticket the guest list already knows about, before spending anything', async () => {
    await seedSnapshot(snapshot({ tickets: [ticket({ checkedIn: true })] }));
    const { result } = await openGate();
    await act(async () => {
      tapWith(servedCode());
    });
    await waitFor(() => expect(result.current.state).toBe('deny'));
    expect(result.current.deny).toBe('ALREADY_USED');
    expect(sendSponsoredOp).not.toHaveBeenCalled();
  });

  it('asks the server for a face the guest list does not carry', async () => {
    await seedSnapshot(snapshot({ tickets: [ticket({ photoJpegB64: '' })] }));
    const { result } = await openGate();
    const code = servedCode();
    await act(async () => {
      tapWith(code);
    });
    await waitFor(() => expect(result.current.state).toBe('confirming'));
    await act(async () => {
      feedVerdict(checkedInLog(code.nonce, 'finalized'));
    });
    await waitFor(() => expect(result.current.photo).toBe('FETCHED'));
    expect(getPhotoForGate).toHaveBeenCalledWith({ tokenId: TOKEN_ID, gateAccount: GATE_ACCOUNT });
  });

  it('draws no face at all for an event that carries none', async () => {
    await seedSnapshot(
      snapshot({ requireKyc: false, tickets: [ticket({ photoJpegB64: '', tierName: '자유석', seat: '' })] }),
    );
    const { result } = await openGate();
    await waitFor(() => expect(result.current.requireKyc).toBe(false));
    expect(result.current.eventTitle).toBe('가을 밤 콘서트');
    const code = servedCode();
    await act(async () => {
      tapWith(code);
    });
    await waitFor(() => expect(result.current.state).toBe('confirming'));
    await act(async () => {
      feedVerdict(checkedInLog(code.nonce, 'finalized'));
    });
    await waitFor(() => expect(result.current.state).toBe('admit'));
    expect(result.current.photo).toBe('');
    expect(getPhotoForGate).not.toHaveBeenCalled();
  });

  it('refuses a second attendee while the first is still confirming', async () => {
    const { result } = await openGate();
    const code = servedCode();
    await act(async () => {
      tapWith(code);
    });
    await waitFor(() => expect(result.current.state).toBe('confirming'));

    await act(async () => {
      tapWith(code);
    });
    await waitFor(() => expect(result.current.refusal).toBe('CONFIRMING'));
    // One tap, one operation. The refused tap must not have been sent.
    expect(sendSponsoredOp).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('confirming');
  });
});

describe('one tap, offline', () => {
  beforeEach(() => setRadio(false));

  it('verifies the attendee’s own signature, writes the row, then admits', async () => {
    const { result } = await openGate();
    expect(result.current.online).toBe(false);
    const code = servedCode();

    await act(async () => {
      tapWith(code);
    });

    await waitFor(() => expect(result.current.state).toBe('offlineAdmit'));
    // Nothing was sent, and nothing pretended the chain had answered.
    expect(sendSponsoredOp).not.toHaveBeenCalled();
    expect(result.current.finalized).toBe(false);

    // The record of the person who walked in survived the card being drawn.
    const rows = await allEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokenId: TOKEN_ID, status: 'pending' });
    expect(rows[0]?.gateCode.nonce).toBe(code.nonce);
    await waitFor(() => expect(result.current.pendingCount).toBe(1));
    expect(result.current.entriesCount).toBe(1);
    expect(result.current.photo).toBe('FROM-LIST');
  });

  it('refuses a signature the guest list’s key cannot account for', async () => {
    const { result } = await openGate();
    const code = servedCode();

    // Another phone's key, signing the same digest perfectly well.
    const impostor = p256.utils.randomPrivateKey();
    const digest = checkInDigest({
      tokenId: TOKEN_ID,
      code,
      domain: { chainId: BigInt(CHAIN_ID), ticket: TICKET_ADDRESS },
    });
    const signature = p256.sign(hexToBytes(digest), impostor, { lowS: true });
    await act(async () => {
      onWrite({
        ndef: toBase64(
          encodeGateResponseMessage({
            v: 2,
            tokenId: TOKEN_ID,
            nonce: code.nonce,
            deviceSig: `0x${signature.toCompactHex()}` as Hex,
          }),
        ),
      });
    });

    await waitFor(() => expect(result.current.state).toBe('deny'));
    expect(result.current.deny).toBe('DEVICE_MISMATCH');
    expect(await allEntries()).toHaveLength(0);
  });

  it('refuses a ticket the guest list has never heard of, because nothing can check it', async () => {
    const { result } = await openGate();
    await act(async () => {
      tapWith(servedCode(), '9999');
    });
    await waitFor(() => expect(result.current.state).toBe('deny'));
    expect(result.current.deny).toBe('NO_TICKET');
    expect(await allEntries()).toHaveLength(0);
  });

  it('sends what it owes as soon as the connection comes back', async () => {
    const { result } = await openGate();
    await act(async () => {
      tapWith(servedCode());
    });
    await waitFor(() => expect(result.current.state).toBe('offlineAdmit'));
    expect(await allEntries()).toHaveLength(1);

    await act(async () => {
      setRadio(true);
      window.dispatchEvent(new Event('online'));
    });

    // The header follows the one watcher this screen owns, and the drain reads that same answer:
    // the dry-run mark on the row is a pass that actually ran, not a badge that turned green.
    await waitFor(() => expect(result.current.online).toBe(true));
    await waitFor(async () => expect((await allEntries())[0]?.lastError).toBe(DRY_RUN_MARK));
  });
});

describe('the door’s own permission', () => {
  it('reports a gate the organizer has closed, and keeps asking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = await openGate();
    await waitFor(() => expect(result.current.gateOpen).toBe(true));
    const asked = readContract.mock.calls.filter((call) => call[0].functionName === 'isOpenGate').length;

    readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === 'isOpenGate' ? false : functionName === 'eventMeta' ? EVENT_META : 0n,
    );
    await act(async () => {
      vi.advanceTimersByTime(GATE_OPEN_RECHECK_MS);
    });

    await waitFor(() => expect(result.current.gateOpen).toBe(false));
    expect(
      readContract.mock.calls.filter((call) => call[0].functionName === 'isOpenGate').length,
    ).toBeGreaterThan(asked);
  });

  /**
   * The half that was cosmetic. A blocking screen is not a guard: while the emitter runs, every
   * attendee who taps a closed gate costs one sponsored operation that can only revert — or, with
   * no signal, one durable queue row for a door that will never be allowed to send it. And the
   * staff member is looking at the warning the whole time, so nothing says it happened.
   */
  it('never claims the tag for a gate the registration already refuses', async () => {
    const { result } = renderHook(() => useGate({ ...params, enabled: false }));
    await waitFor(() => expect(result.current.gateOpen).toBe(false));
    // Nothing was asked of the chain on its behalf either: a revoked gate is not coming back.
    expect(readContract.mock.calls.filter((call) => call[0].functionName === 'isOpenGate')).toHaveLength(0);
    expect(hce.start).not.toHaveBeenCalled();
    expect(hce.setPayload).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });

  it('stops emitting the moment the chain says the door shut', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = await openGate();
    const code = servedCode();
    expect(hce.start).toHaveBeenCalledTimes(1);

    readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === 'isOpenGate' ? false : functionName === 'eventMeta' ? EVENT_META : 0n,
    );
    await act(async () => {
      vi.advanceTimersByTime(GATE_OPEN_RECHECK_MS);
    });
    await waitFor(() => expect(hce.stop).toHaveBeenCalled());

    // And a write that lands after the door shut buys nobody anything.
    const served = hce.setPayload.mock.calls.length;
    await act(async () => {
      tapWith(code);
    });
    expect(sendSponsoredOp).not.toHaveBeenCalled();
    expect(await allEntries()).toHaveLength(0);
    expect(result.current.state).not.toBe('confirming');
    await act(async () => {
      vi.advanceTimersByTime(GATE_CODE_ROTATE_MS * 3);
    });
    expect(hce.setPayload.mock.calls.length).toBe(served);
  });

  it('claims the tag once the organizer opens the door again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === 'isOpenGate' ? false : functionName === 'eventMeta' ? EVENT_META : 0n,
    );
    const { result } = renderHook(() => useGate(params));
    await waitFor(() => expect(result.current.gateOpen).toBe(false));
    expect(hce.start).not.toHaveBeenCalled();

    // The organizer opens the door. Nothing tells this phone — it finds out on the next minute.
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === 'isOpenGate' ? true : functionName === 'eventMeta' ? EVENT_META : 0n,
    );
    await act(async () => {
      vi.advanceTimersByTime(GATE_OPEN_RECHECK_MS);
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(hce.start).toHaveBeenCalledTimes(1);
  });
});

describe('what the gate still owes the chain', () => {
  /**
   * The case that had no path at all: a terminal restarted after a signal drop boots with rows
   * already on disk, already online, and no rising edge left to fire. Before this they sat there
   * for the rest of the shift.
   *
   * The observable proof is the dry-run mark: this build's ABI has no `checkInLate`, so the drain
   * marks the row instead of sending it — which only a pass that actually ran can do.
   */
  it('drains on mount when the connection is already up', async () => {
    await seedQueueRow();
    await openGate();
    await waitFor(async () => expect((await allEntries())[0]?.lastError).toBe(DRY_RUN_MARK));
  });

  it('drains again on every status tick, without waiting for a disconnection', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openGate();
    // Written *after* the mount drain, the way a tap taken during a brief drop would be.
    await seedQueueRow();
    await act(async () => {
      vi.advanceTimersByTime(GATE_STATUS_POLL_MS);
    });
    await waitFor(async () => expect((await allEntries())[0]?.lastError).toBe(DRY_RUN_MARK));
  });

  it('counts what is waiting so the screen can offer a way to it', async () => {
    await seedQueueRow();
    const { result } = await openGate();
    await waitFor(() => expect(result.current.pendingCount).toBe(1));
    expect(result.current.parkedCount).toBe(0);
  });
});

describe('unmount', () => {
  /**
   * Seven handles, and every one of them outlives the screen if it is dropped: the HCE claim (the
   * phone keeps answering taps for a gate nobody is watching), the chain watch, the probe loop,
   * the guest-list refresh — which is also what erases the faces — and three intervals. The
   * cleanup reads correct; this is what keeps it correct.
   */
  it('releases the tag, the watch, the probes, the faces and every timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, unmount } = await openGate();
    const code = servedCode();
    await act(async () => {
      tapWith(code);
    });
    await waitFor(() => expect(result.current.state).toBe('confirming'));
    expect(subscribeLogs).toHaveBeenCalled();

    const served = hce.setPayload.mock.calls.length;
    const asked = readContract.mock.calls.length;
    const probed = request.mock.calls.length;

    await act(async () => {
      unmount();
    });

    // The tag and the tap's chain watch.
    await waitFor(() => expect(hce.stop).toHaveBeenCalled());
    expect(stopLogs).toHaveBeenCalled();
    // The faces went with the guest list — `startSnapshotRefresh`'s disposer is what erases them.
    await waitFor(async () => expect(await (await staffDb()).get('snapshots', EVENT_ID.toString())).toBeUndefined());

    // Nothing ticks afterwards: not the rotation, not the status/drain poll, not the permission
    // re-check, not the connectivity probe.
    await act(async () => {
      vi.advanceTimersByTime(GATE_OPEN_RECHECK_MS * 2);
    });
    expect(hce.setPayload.mock.calls.length).toBe(served);
    expect(readContract.mock.calls.length).toBe(asked);
    expect(request.mock.calls.length).toBe(probed);

    // And a write dispatched after the teardown is a tap at a gate that is already closed.
    const sent = sendSponsoredOp.mock.calls.length;
    await act(async () => {
      tapWith(code);
    });
    expect(sendSponsoredOp.mock.calls.length).toBe(sent);
  });
});

describe('the QR fallback', () => {
  it('takes the same path a tap does, matched against the whole live ring', async () => {
    const { result } = await openGate();
    const code = servedCode();
    const digest = checkInDigest({
      tokenId: TOKEN_ID,
      code,
      domain: { chainId: BigInt(CHAIN_ID), ticket: TICKET_ADDRESS },
    });
    const signature = p256.sign(hexToBytes(digest), devicePrivate, { lowS: true });

    await act(async () => {
      await result.current.handleResponse({
        v: 2,
        tokenId: TOKEN_ID,
        nonce: code.nonce,
        deviceSig: `0x${signature.toCompactHex()}` as Hex,
      });
    });

    await waitFor(() => expect(result.current.state).toBe('confirming'));
    expect(sendSponsoredOp).toHaveBeenCalledTimes(1);
  });

  it('says nothing and stays ready when the code is not one this gate served', async () => {
    const { result } = await openGate();
    await act(async () => {
      await result.current.handleResponse({
        v: 2,
        tokenId: TOKEN_ID,
        nonce: `0x${'ee'.repeat(32)}` as Hex,
        deviceSig: `0x${'11'.repeat(64)}` as Hex,
      });
    });
    expect(result.current.state).toBe('ready');
    expect(sendSponsoredOp).not.toHaveBeenCalled();
  });
});

/**
 * Manual approval, through the real wiring (Task 32).
 *
 * The three things being pinned here are the three that can only be got wrong once:
 *
 *  * **the account** — a check-in is the terminal's operation and an override is a *person's*,
 *    because `Ticket.manualOverride` writes `msg.sender` into `ManualOverride` as the approver.
 *    Every test below reads the sender back off the operation and expects `0xbb…`, never `0xaa…`;
 *  * **the call** — `Organizers` picks it, at that moment, never a flag on this device;
 *  * **the PIN** — five tries and a minute, on disk, before anything is signed.
 */
describe('manual approval', () => {
  /**
   * A running gate and a PIN this terminal agreed on — and **no tap**, which is the case the
   * feature exists for: an attendee whose phone produces nothing at all. The ticket is named by
   * the dialog's search instead.
   */
  async function ready() {
    const { setPin } = await import('../override/pin');
    await setPin('4821');
    const rendered = await openGate();
    sendSponsoredOp.mockClear();
    return rendered;
  }

  /** The other way in: a tap that was answered, and a staff member who overrides the answer. */
  async function afterRefusal() {
    const rendered = await ready();
    // The check-in reverts, so the tap settles and the screen is free for an override.
    wait.mockResolvedValueOnce({ success: false, txHash: `0x${'00'.repeat(32)}`, blockNumber: 0n });
    await act(async () => {
      tapWith(servedCode());
    });
    await waitFor(() => expect(rendered.result.current.state).toBe('deny'));
    sendSponsoredOp.mockClear();
    return rendered;
  }

  /** The override operation, decoded. The check-in has already been cleared off the mock. */
  async function sentOverride() {
    const { decodeFunctionData } = await import('viem');
    const { ticketAbi } = await import('@monti/shared');
    const args = sendSponsoredOp.mock.calls.at(-1)?.[0] as unknown as {
      account: { address: Hex };
      calls: Array<{ data: Hex }>;
    };
    return {
      sender: args.account.address,
      ...decodeFunctionData({ abi: ticketAbi, data: args.calls[0]!.data }),
    };
  }

  it('sends manualOverride from the staff member own account, and records who and why', async () => {
    const { result } = await ready();

    await act(async () => {
      result.current.openOverride();
    });
    await waitFor(() => expect(result.current.state).toBe('override'));
    await waitFor(() => expect(result.current.canApprove).toBe(true));

    await act(async () => {
      await result.current.submitOverride('4821', 2, TOKEN_ID);
    });

    const sent = await sentOverride();
    expect(sent.sender).toBe(STAFF_ACCOUNT);
    expect(sent.sender).not.toBe(GATE_ACCOUNT);
    expect(sent.functionName).toBe('manualOverride');
    expect(sent.args).toEqual([BigInt(TOKEN_ID), GATE_ID, 2]);

    // The three facts the `ManualOverride` event will carry, on the screen that filed it.
    expect(result.current.override).toMatchObject({
      status: 'approved',
      route: 'manualOverride',
      role: 'manager',
      approver: STAFF_ACCOUNT,
      reason: 2,
    });
    // A person went through the door, so the header counts them.
    expect(result.current.entriesCount).toBe(1);
  });

  it('tags a permitted admin ROLE_APPROVER, the way the contract does', async () => {
    managerOf = [false, false];
    hasPermission = true;
    const { result } = await ready();
    await act(async () => {
      result.current.openOverride();
    });
    await waitFor(() => expect(result.current.canApprove).toBe(true));
    await act(async () => {
      await result.current.submitOverride('4821', 1, TOKEN_ID);
    });
    expect(result.current.override).toMatchObject({ role: 'approver', route: 'manualOverride' });
  });

  /**
   * The half that admits nobody. `requestOverride` emits `OverrideRequested` and no check-in, so
   * this sentence is the only thing that tells a staff member the request left the phone.
   */
  it('files a request for a manager who may not approve, and says 요청됨 — 승인 대기', async () => {
    managerOf = [true, false];
    const { result } = await ready();

    await act(async () => {
      result.current.openOverride();
    });
    await waitFor(() => expect(result.current.canApprove).toBe(false));

    await act(async () => {
      await result.current.submitOverride('4821', 3, TOKEN_ID);
    });

    const sent = await sentOverride();
    expect(sent.functionName).toBe('requestOverride');
    expect(sent.args).toEqual([BigInt(TOKEN_ID), GATE_ID, 3]);
    expect(result.current.override).toMatchObject({ status: 'requested', role: 'none' });
    // Nobody went in on a request.
    expect(result.current.entriesCount).toBe(0);
  });

  it('spends nothing on a wrong PIN, and says how many tries are left', async () => {
    const { result } = await ready();
    await act(async () => {
      result.current.openOverride();
    });
    await act(async () => {
      await result.current.submitOverride('0000', 1, TOKEN_ID);
    });
    expect(sendSponsoredOp).not.toHaveBeenCalled();
    expect(result.current.override?.status).toBe('failed');
    expect(result.current.override?.detail).toContain('4');
  });

  /** The lockout refuses the right PIN too, because an attacker's last guess is a right one. */
  it('locks after five wrong tries, and the right PIN does not get past it', async () => {
    const { result } = await ready();
    await act(async () => {
      result.current.openOverride();
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await act(async () => {
        await result.current.submitOverride('0000', 1, TOKEN_ID);
      });
    }
    await act(async () => {
      await result.current.submitOverride('4821', 1, TOKEN_ID);
    });
    expect(sendSponsoredOp).not.toHaveBeenCalled();
    expect(result.current.override?.detail).toBe(staffKo.override.pinLocked.replace('{{seconds}}', '60'));
  });

  it('tells an account the chain refuses, without signing anything', async () => {
    managerOf = [false, false];
    const { result } = await ready();
    await act(async () => {
      result.current.openOverride();
    });
    await waitFor(() => expect(result.current.canApprove).toBe(false));
    await act(async () => {
      await result.current.submitOverride('4821', 1, TOKEN_ID);
    });
    expect(sendSponsoredOp).not.toHaveBeenCalled();
    expect(result.current.override).toMatchObject({ status: 'failed', detail: staffKo.override.denied });
  });

  /**
   * The critical one. `ticket` is set at `onPreflight`, before anything is sent, so the button
   * used to be live all through `confirming` — and taking the screen there closed the
   * `CheckedIn` watch for an operation that is running and already paid for.
   */
  it('refuses to open while a check-in is confirming, and that check-in still lands', async () => {
    const { result } = await ready();
    const code = servedCode();
    await act(async () => {
      tapWith(code);
    });
    await waitFor(() => expect(result.current.state).toBe('confirming'));

    await act(async () => {
      expect(result.current.openOverride()).toBe(false);
    });
    expect(result.current.state).toBe('confirming');
    expect(result.current.refusal).toBe('CONFIRMING');

    // The watch was never closed, so the verdict still arrives and still admits.
    await act(async () => {
      feedVerdict(checkedInLog(code.nonce, 'finalized'));
    });
    await waitFor(() => expect(result.current.state).toBe('admit'));
  });

  it('falls back to the tap on screen when the dialog named nobody', async () => {
    const { result } = await afterRefusal();
    await act(async () => {
      result.current.openOverride();
    });
    await act(async () => {
      await result.current.submitOverride('4821', 1);
    });
    const sent = await sentOverride();
    expect(sent.args).toEqual([BigInt(TOKEN_ID), GATE_ID, 1]);
  });

  it('finds somebody in the held guest list by name and by ticket number', async () => {
    const { result } = await ready();
    expect(result.current.searchGuests('김입장').map((row) => row.tokenId)).toEqual([TOKEN_ID]);
    expect(result.current.searchGuests(TOKEN_ID.slice(-2)).map((row) => row.tokenId)).toEqual([TOKEN_ID]);
    expect(result.current.searchGuests('없는사람')).toEqual([]);
    expect(result.current.searchGuests('')).toEqual([]);
  });

  /**
   * Ruling 2. `requestOverride` writes no check-in, so without this the staff member who filed
   * one has no way to learn it was granted except by asking the attendee to tap again — and the
   * attendee is standing there precisely because they cannot.
   */
  it('follows a filed request until somebody approves it, then says 승인됨', async () => {
    managerOf = [true, false];
    const { result } = await ready();
    await act(async () => {
      result.current.openOverride();
    });
    await act(async () => {
      await result.current.submitOverride('4821', 1, TOKEN_ID);
    });
    await waitFor(() => expect(result.current.override?.status).toBe('requested'));

    // The machine opened a second subscription, for `ManualOverride` on this ticket.
    const watch = subscribeLogs.mock.calls.at(-1)?.[0] as {
      topics: unknown[];
      onLog: (log: unknown) => void;
    };
    expect(watch.topics[0]).toBe(MANUAL_OVERRIDE);
    expect(watch.topics[1]).toBe(numberToHex(BigInt(TOKEN_ID), { size: 32 }));

    await act(async () => {
      watch.onLog(manualOverrideLog(`0x${'cc'.repeat(20)}`, 1, 1));
    });
    await waitFor(() => expect(result.current.override?.status).toBe('approved'));
    expect(result.current.override).toMatchObject({
      role: 'approver',
      approver: `0x${'cc'.repeat(20)}`,
      route: 'requestOverride',
    });
  });

  it('says a dismissed identity check is not a failure', async () => {
    const { result } = await ready();
    const cancelled = Object.assign(new Error('nope'), { name: 'NotAllowedError' });
    sendSponsoredOp.mockRejectedValueOnce(cancelled);
    await act(async () => {
      result.current.openOverride();
    });
    await act(async () => {
      await result.current.submitOverride('4821', 1, TOKEN_ID);
    });
    expect(result.current.override).toMatchObject({
      status: 'failed',
      detail: staffKo.override.cancelled,
    });
  });

  /** A rejected `wait()` is not a timeout. Swallowing it left the dialog with no ending at all. */
  it('gives a receipt it could not read its own sentence', async () => {
    const { result } = await ready();
    wait.mockRejectedValueOnce(new Error('bundler said no'));
    await act(async () => {
      result.current.openOverride();
    });
    await act(async () => {
      await result.current.submitOverride('4821', 1, TOKEN_ID);
    });
    expect(result.current.override).toMatchObject({
      status: 'failed',
      detail: staffKo.override.unreachable,
      route: 'manualOverride',
    });
  });

  it('has a way out: the result lands in 직전 탭 and the gate waits for the next attendee', async () => {
    const { result } = await ready();
    await act(async () => {
      result.current.openOverride();
    });
    await act(async () => {
      await result.current.submitOverride('4821', 1, TOKEN_ID);
    });
    await waitFor(() => expect(result.current.override?.status).toBe('approved'));

    await act(async () => {
      result.current.retry();
    });
    expect(result.current.state).toBe('ready');
    expect(result.current.override).toBeUndefined();
    expect(result.current.canApprove).toBe(false);
    expect(result.current.lastTap).toMatchObject({
      state: 'override',
      override: { status: 'approved', role: 'manager' },
    });
  });
});

/**
 * A staff APK that cold-starts at a venue with no signal. `isOpenGate` cannot be read, so before
 * Task 30's re-review `gateOpen` stayed `undefined` for ever and the door simply never opened —
 * the one failure a door cannot recover from by waiting. It now runs on the last answer this
 * device had, and says that is what it is doing.
 */
describe('a door open on a remembered answer', () => {
  it('remembers what the chain said, and opens on it when the read fails', async () => {
    const first = await openGate();
    await waitFor(() => expect(first.result.current.gateOpen).toBe(true));
    expect(first.result.current.gateOpenStale).toBe(false);
    first.unmount();

    openGateAnswer = () => {
      throw new Error('offline');
    };
    const { result } = await openGate();
    await waitFor(() => expect(result.current.gateOpen).toBe(true));
    expect(result.current.gateOpenStale).toBe(true);
  });

  it('never inherits another gate permission', async () => {
    const first = await openGate();
    await waitFor(() => expect(first.result.current.gateOpen).toBe(true));
    first.unmount();

    openGateAnswer = () => {
      throw new Error('offline');
    };
    const { result } = renderHook(() => useGate({ ...params, gateId: 9n }));
    await waitFor(() => expect(readContract).toHaveBeenCalled());
    expect(result.current.gateOpen).toBeUndefined();
    expect(result.current.gateOpenStale).toBe(false);
  });

  /**
   * Ruling 3. A remembered permission is one nobody has re-granted, so it expires: past an hour
   * the screen goes back to blocking rather than opening a door this device cannot vouch for.
   */
  it('throws away an answer older than the window, and blocks instead', async () => {
    await (await staffDb()).put('settings', {
      key: 'gateOpen',
      gateId: GATE_ID.toString(),
      open: true,
      checkedAt: Date.now() - GATE_OPEN_STALE_MS - 1,
    });
    openGateAnswer = () => {
      throw new Error('offline');
    };
    const { result } = renderHook(() => useGate(params));
    await waitFor(() => expect(readContract).toHaveBeenCalled());
    expect(result.current.gateOpen).toBeUndefined();
    expect(result.current.gateOpenStale).toBe(false);
  });

  it('still opens on one inside the window', async () => {
    await (await staffDb()).put('settings', {
      key: 'gateOpen',
      gateId: GATE_ID.toString(),
      open: true,
      checkedAt: Date.now() - GATE_OPEN_STALE_MS + 60_000,
    });
    openGateAnswer = () => {
      throw new Error('offline');
    };
    const { result } = renderHook(() => useGate(params));
    await waitFor(() => expect(result.current.gateOpen).toBe(true));
    expect(result.current.gateOpenStale).toBe(true);
  });

  /** A fresh answer beats a remembered one, in both directions and immediately. */
  it('drops the mark the moment the chain answers for itself', async () => {
    await (await staffDb()).put('settings', {
      key: 'gateOpen',
      gateId: GATE_ID.toString(),
      open: true,
      checkedAt: Date.now() - 3_600_000,
    });
    const { result } = await openGate();
    await waitFor(() => expect(result.current.gateOpen).toBe(true));
    expect(result.current.gateOpenStale).toBe(false);
  });
});
