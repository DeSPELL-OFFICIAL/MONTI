import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { getAddress, type Hex } from 'viem';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_ID = `0x${'aa'.repeat(32)}` as Hex;
const X = `0x${'11'.repeat(32)}` as Hex;
const Y = `0x${'22'.repeat(32)}` as Hex;
const OWNER = `0x${'11'.repeat(32)}${'22'.repeat(32)}` as Hex;
const ACCOUNT = '0x9999999999999999999999999999999999999999' as Hex;
const OTHER = '0x1234567890123456789012345678901234567890' as Hex;
const FACTORY = '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842' as Hex;
const DEPLOY_TX = '0xdeploy' as Hex;
const COSE_B64 = Buffer.from('cose-bytes').toString('base64');

/** 되살린 소유자와 좌표는 여기서 고정한다 — 이 테스트의 관심사는 배포 결정이지 CBOR 파싱이 아니다. */
vi.mock('../src/lib/webauthn.js', () => ({
  coseToP256: () => ({ x: X, y: Y }),
  ownerBytes: () => OWNER,
}));

/** 패스키 한 장만 돌려주는 최소 Firestore. */
let passkeyDocs: Array<{ get: (name: string) => unknown }> = [];
vi.mock('../src/lib/db.js', () => ({
  PASSKEYS: 'passkeys',
  db: {
    collection: () => ({
      where: () => ({ limit: () => ({ get: async () => ({ docs: passkeyDocs }) }) }),
    }),
  },
}));

const getCode = vi.fn(async (_args: { address: Hex }) => undefined as Hex | undefined);
const readContract = vi.fn(async (_args: { functionName: string }) => ACCOUNT as string);
const sendAttesterTx = vi.fn(async (_tx: Record<string, unknown>) => DEPLOY_TX);
vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ getCode, readContract }),
  deployment: () => ({ coinbaseFactory: FACTORY }),
  sendAttesterTx: (...args: unknown[]) => sendAttesterTx(...(args as [Record<string, unknown>])),
}));

/** 리스는 실제 테스트 대상이 아니므로 그대로 통과시킨다. */
vi.mock('../src/lib/attesterLock.js', () => ({
  sendSerialized: (run: () => Promise<unknown>) => run(),
}));

const warn = vi.fn();
const error = vi.fn();
vi.mock('firebase-functions/logger', () => ({ warn, error, info: vi.fn() }));

const { predeployAccount } = await import('../src/lib/predeployAccount.js');

/** 사람 문서 한 개의 쓰기를 모으는 가짜 ref. */
function fakeRef(path = `persons/${PERSON_ID}`) {
  const writes: Array<{ data: Record<string, unknown>; merge?: boolean }> = [];
  return {
    path,
    id: path.slice(path.indexOf('/') + 1),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      writes.push({ data, merge: options?.merge });
    },
    writes,
  };
}

function lastChain(ref: ReturnType<typeof fakeRef>): Record<string, unknown> | undefined {
  const last = ref.writes.at(-1);
  return last?.data.chain as Record<string, unknown> | undefined;
}

function isDelete(value: unknown): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(FieldValue.delete());
}

beforeEach(() => {
  passkeyDocs = [{ get: (name) => (name === 'publicKeyCose' ? COSE_B64 : undefined) }];
  getCode.mockReset();
  getCode.mockResolvedValue(undefined);
  readContract.mockReset();
  readContract.mockResolvedValue(ACCOUNT);
  sendAttesterTx.mockReset();
  sendAttesterTx.mockResolvedValue(DEPLOY_TX);
  warn.mockClear();
  error.mockClear();
});

describe('predeployAccount', () => {
  it('deploys the account with the same owners and nonce the web derives it from', async () => {
    const ref = fakeRef();
    await predeployAccount({ personRef: ref as never, personId: PERSON_ID, account: ACCOUNT });

    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    const tx = sendAttesterTx.mock.calls[0]![0];
    expect(tx).toMatchObject({ address: FACTORY, functionName: 'createAccount' });
    expect(tx.args).toEqual([[OWNER], 0n]);
    // 예측을 먼저 확인한다: getAddress 로 물어본 인자가 배포와 똑같다.
    expect(readContract.mock.calls[0]![0]).toMatchObject({
      address: FACTORY,
      functionName: 'getAddress',
      args: [[OWNER], 0n],
    });
    // 딱지를 남겨 대사가 코드 여부를 확인하게 한다.
    expect(lastChain(ref)).toMatchObject({ accountDeployPending: true, accountDeployTx: DEPLOY_TX });
  });

  it('skips the deploy when the account already has code and clears the retry flag', async () => {
    getCode.mockResolvedValue('0x6080604052' as Hex);
    const ref = fakeRef();
    await predeployAccount({ personRef: ref as never, personId: PERSON_ID, account: ACCOUNT });

    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
    expect(isDelete(lastChain(ref)?.accountDeployPending)).toBe(true);
  });

  it('never throws and leaves the retry flag when the deploy send fails', async () => {
    sendAttesterTx.mockRejectedValue(new Error('insufficient funds'));
    const ref = fakeRef();
    await expect(
      predeployAccount({ personRef: ref as never, personId: PERSON_ID, account: ACCOUNT }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('account.predeploy.failed', expect.objectContaining({ personId: PERSON_ID }));
    expect(lastChain(ref)).toMatchObject({ accountDeployPending: true });
  });

  it('refuses to deploy and logs an error when the predicted address is not the recorded account', async () => {
    readContract.mockResolvedValue(OTHER);
    const ref = fakeRef();
    await predeployAccount({ personRef: ref as never, personId: PERSON_ID, account: ACCOUNT });

    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'account.predeploy.mismatch',
      expect.objectContaining({ personId: PERSON_ID, account: getAddress(ACCOUNT) }),
    );
  });

  it('does nothing but log when the person has no passkey to derive an owner from', async () => {
    passkeyDocs = [];
    const ref = fakeRef();
    await predeployAccount({ personRef: ref as never, personId: PERSON_ID, account: ACCOUNT });

    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('account.predeploy.nopasskey', { personId: PERSON_ID });
  });
});
