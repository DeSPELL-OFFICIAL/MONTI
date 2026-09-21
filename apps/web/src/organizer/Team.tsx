import { useCallback, useEffect, useState } from 'react';
import { isAddress, type Hex } from 'viem';
import { Alert, Button, Field, Screen } from '../shared/ui';
import { api, callableFailure } from '../shared/api/functions';
import { organizersAbi } from '../shared/chain/abis';
import { getStaffAccount } from '../shared/chain/accounts';
import { OpReverted, organizersOp } from '../shared/chain/ops';
import { PERMISSION_BITS, PERM_CREATE_EVENT, PERM_MANAGE_GATES } from '../shared/chain/permissions';
import { readOrganizers } from '../shared/chain/reads';
import { revertMatch } from '../shared/chain/revert';
import { isUnsponsored } from '../shared/chain/unsponsored';
import { useOrganizerCopy, type OrganizerCopy } from './copy';
import { UnsponsoredNotice } from './Unsponsored';

type Role = 'admin' | 'manager';
type TeamProblem = keyof OrganizerCopy['team']['problems'];

const PHONE_RE = /^\+[0-9]{7,15}$/;
const ORG_ID_RE = /^[0-9]{1,78}$/;

/**
 * What `Organizers` reverts these two writes with, against the rule each one names.
 * `setAdmin` raises `NotOwner` (`Organizers.sol:96`) and `setManager` raises `Unauthorized`
 * (`:104`) — different rules, and worth different sentences: one says "you are not the owner",
 * the other "you do not hold PERM_MANAGE_MANAGERS". `UnknownOrganizer` is a number that is not
 * an organisation at all, which no amount of pressing again will fix.
 */
const GRANT_REVERTS: ReadonlyArray<readonly [string, TeamProblem]> = [
  ['NotOwner', 'notOwner'],
  ['Unauthorized', 'notAllowed'],
  ['UnknownOrganizer', 'unknownOrg'],
  ['ZeroAddress', 'account'],
];

/** What this screen made in this session. There is no callable that lists invites, and the
 *  invite document's own `done` flag is written by the Tenderly webhook — so nothing here
 *  waits on it, and completion is read off the chain instead. */
interface SessionInvite {
  inviteId: string;
  link: string;
  role: Role;
  revoked: boolean;
}

/**
 * Who may act for one organisation, and the two halves of putting somebody there.
 *
 * Inviting is a server call, and it never stores the number: `createInvite` keeps the same
 * HMAC index `startSignup` uses and hands back a link carrying the invite id and nothing else.
 *
 * Granting the role is **not** a server call. `Organizers.setAdmin` reverts unless `msg.sender`
 * is the organisation's owner and `setManager` unless the sender holds `PERM_MANAGE_MANAGERS`,
 * and the attester is neither — which is why `acceptInvite` answers with calldata and a
 * `requiredSender` rather than writing anything. The owner sends it from here, by name and
 * arguments, as a sponsored operation.
 */
export function Team({ orgId: fixedOrgId }: { orgId?: string } = {}) {
  const organizer = useOrganizerCopy();
  const copy = organizer.team;
  // The one sentence for "it is still on its way", shared with the lifecycle screens.
  const lifecycle = organizer.lifecycle;
  const [orgId, setOrgId] = useState(fixedOrgId ?? '');

  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<Role>('manager');
  const [canApprove, setCanApprove] = useState(false);
  const [bits, setBits] = useState(PERM_CREATE_EVENT | PERM_MANAGE_GATES);
  const [invites, setInvites] = useState<SessionInvite[]>([]);

  const [account, setAccount] = useState('');
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [granted, setGranted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<TeamProblem | ''>('');
  const [confirming, setConfirming] = useState(false);
  const [unsponsored, setUnsponsored] = useState(false);

  // Owner or not is a chain question and the answer decides what this screen offers. An
  // organisation number that is not one yet (`ownerOf` is the zero address) is simply not mine.
  //
  // The account asked about is `getStaffAccount()`, which is the signed-in passkey account —
  // the same one the session carries. That equality is the invariant this screen depends on;
  // reading it here rather than from the session store keeps the screen testable on its own.
  useEffect(() => {
    if (!ORG_ID_RE.test(orgId)) {
      setIsOwner(null);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      const [owner, staff] = await Promise.all([
        readOrganizers()
          .ownerOf(BigInt(orgId))
          .catch(() => null),
        getStaffAccount()
          .then((it) => it.address as Hex)
          .catch(() => null),
      ]);
      if (cancelled) return;
      setIsOwner(owner !== null && staff !== null && owner.toLowerCase() === staff.toLowerCase());
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  /** The chain's own answer to "did it land?", which is the only one this screen trusts. */
  const check = useCallback(async (): Promise<void> => {
    // Strict: a mixed-case address whose EIP-55 checksum does not add up is one character of
    // somebody else's, and admin bits on an account nobody holds cannot be taken back.
    if (!ORG_ID_RE.test(orgId) || !isAddress(account, { strict: true })) return;
    const target = account as Hex;
    const organizers = readOrganizers();
    const held =
      role === 'admin'
        ? await organizers
            .adminBitsOf(BigInt(orgId), target)
            .then((value) => value !== 0)
            .catch(() => false)
        : await organizers
            .managerOf(BigInt(orgId), target)
            .then((manager) => manager.exists)
            .catch(() => false);
    setGranted(held);
  }, [account, orgId, role]);

  async function invite(): Promise<void> {
    setProblem('');
    setUnsponsored(false);
    if (!ORG_ID_RE.test(orgId)) return setProblem('orgId');
    if (!PHONE_RE.test(phone.trim())) return setProblem('phone');
    if (role === 'admin' && bits === 0) return setProblem('bits');

    setBusy(true);
    try {
      const created = await api.createInvite({
        orgId,
        role,
        phoneE164: phone.trim(),
        ...(role === 'admin' ? { permissionBits: bits } : { canApprove }),
      });
      setInvites((current) => [{ ...created, role, revoked: false }, ...current]);
      setPhone('');
    } catch (cause) {
      const { code } = callableFailure(cause);
      setProblem(code === 'permission-denied' ? 'notAllowed' : 'failed');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(inviteId: string): Promise<void> {
    setProblem('');
    try {
      await api.revokeInvite({ inviteId });
      setInvites((current) =>
        current.map((entry) => (entry.inviteId === inviteId ? { ...entry, revoked: true } : entry)),
      );
    } catch (cause) {
      const { code } = callableFailure(cause);
      setProblem(code === 'not-found' ? 'notFound' : code === 'permission-denied' ? 'notAllowed' : 'failed');
    }
  }

  async function grant(): Promise<void> {
    setProblem('');
    setConfirming(false);
    setUnsponsored(false);
    setGranted(false);
    if (!ORG_ID_RE.test(orgId)) return setProblem('orgId');
    if (!isAddress(account, { strict: true })) return setProblem('account');
    if (role === 'admin' && bits === 0) return setProblem('bits');

    setBusy(true);
    try {
      await organizersOp({
        account: await getStaffAccount(),
        orgId: BigInt(orgId),
        ...(role === 'admin'
          ? { functionName: 'setAdmin' as const, args: [BigInt(orgId), account as Hex, bits] }
          : { functionName: 'setManager' as const, args: [BigInt(orgId), account as Hex, true, canApprove] }),
      });
      await check();
    } catch (cause) {
      if (cause instanceof OpReverted) {
        // A `wait` that gave up is not a refusal: the grant may well be landing, and telling
        // the owner it failed invites a second send. Same rule as every other screen here.
        if (cause.revertReason === 'TIMEOUT') setConfirming(true);
        else {
          const named = cause.revertReason
            ? revertMatch(organizersAbi, cause.revertReason as Hex, GRANT_REVERTS)
            : undefined;
          setProblem(named ?? 'failed');
        }
      } else if (isUnsponsored(cause)) setUnsponsored(true);
      else setProblem('failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.title}>
      {problem === '' ? null : <Alert tone="error">{copy.problems[problem]}</Alert>}
      {confirming ? <Alert tone="info">{lifecycle.confirming}</Alert> : null}
      {unsponsored ? <UnsponsoredNotice /> : null}
      {busy ? <Alert tone="info">{copy.working}</Alert> : null}

      {fixedOrgId === undefined ? (
        <Field label={copy.problems.orgId}>
          <input value={orgId} inputMode="numeric" onChange={(event) => setOrgId(event.target.value)} />
        </Field>
      ) : null}

      <Field label={copy.role}>
        <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
          <option value="manager">{copy.manager}</option>
          <option value="admin">{copy.admin}</option>
        </select>
      </Field>

      {role === 'manager' ? (
        <label>
          <input type="checkbox" checked={canApprove} onChange={(event) => setCanApprove(event.target.checked)} />
          {canApprove ? copy.canApprove : copy.requestOnly}
        </label>
      ) : (
        PERMISSION_BITS.map((permission) => (
          <label key={permission.name} style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={(bits & permission.bit) !== 0}
              onChange={(event) =>
                setBits((current) => (event.target.checked ? current | permission.bit : current & ~permission.bit))
              }
            />
            {copy.perms[permission.name]}
          </label>
        ))
      )}

      <section>
        <h2>{copy.invite}</h2>
        <Field label={copy.phone}>
          <input value={phone} inputMode="tel" placeholder="+8210…" onChange={(event) => setPhone(event.target.value)} />
        </Field>
        <Button disabled={busy} onClick={() => void invite()}>
          {copy.invite}
        </Button>

        {invites.length > 0 ? (
          <>
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>{copy.sessionOnly}</p>
            <p>{copy.invited}</p>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {invites.map((entry) => (
                <li key={entry.inviteId} style={{ marginBottom: 8 }}>
                  <p style={{ wordBreak: 'break-all' }}>
                    {copy.link} {entry.link}
                  </p>
                  {entry.revoked ? (
                    <p>{copy.revoked}</p>
                  ) : (
                    <Button variant="ghost" onClick={() => void revoke(entry.inviteId)}>
                      {copy.revoke}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section>
        <h2>{copy.grant}</h2>
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>{copy.grantHelp}</p>
        {isOwner === false ? <Alert tone="warn">{copy.notOwner}</Alert> : null}
        <Field label={copy.account}>
          <input value={account} autoComplete="off" onChange={(event) => setAccount(event.target.value)} />
        </Field>
        {granted ? <Alert tone="info">{copy.granted}</Alert> : null}
        {isOwner ? (
          <Button disabled={busy} onClick={() => void grant()}>
            {copy.grant}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => void check()}>
          {copy.check}
        </Button>
      </section>
    </Screen>
  );
}
