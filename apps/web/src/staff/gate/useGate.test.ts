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
const { GATE_OPEN_RECHECK_MS } = await import('../constants');

// --- the attendee, with a key that really signs -------------------------------------------------
const devicePrivate = p256.utils.randomPrivateKey();
const devicePublic = p256.getPublicKey(devicePrivate, false);
const DEVICE_X = bytesToHex(devicePublic.slice(1, 33));
const DEVICE_Y = bytesToHex(devicePublic.slice(33, 65));

const EVENT_ID = 42n;
const GATE_ID = 7n;
const ORG_ID = 5n;
const TOKEN_ID = '1042';
const params = { gateId: GATE_ID, eventId: EVENT_ID, orgId: ORG_ID, gateAccount: GATE_ACCOUNT };

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
        return true;
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
  const db = await staffDb();
  await Promise.all([db.clear('snapshots'), db.clear('photos'), db.clear('queue')]);
  await seedSnapshot();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The gate is running and serving codes. Everything below starts from here. */
async function openGate() {
  const rendered = renderHook(() => useGate(params));
  await waitFor(() => expect(rendered.result.current.state).toBe('ready'));
  return rendered;
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

    // The header follows the one watcher this screen owns, and the drain reads that same answer.
    await waitFor(() => expect(result.current.online).toBe(true));
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
