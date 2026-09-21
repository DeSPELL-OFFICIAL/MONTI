import { useCallback, useEffect, useState } from 'react';
import { isAddress, type Hex } from 'viem';
import { Alert, Button, Field, Screen } from '../shared/ui';
import { api, callableFailure, type InviteRow } from '../shared/api/functions';
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
/** The four words a row can be in, which is not the same set as the three the server stores. */
type InviteState = keyof OrganizerCopy['team']['status'];

const PHONE_RE = /^\+[0-9]{7,15}$/;
const ORG_ID_RE = /^[0-9]{1,78}$/;

/** `INVITE_TTL_MS` (functions/src/functions/invites.ts), in the seconds a row speaks. The
 *  optimistic row stands in for one the server has already written, so it carries the same
 *  deadline rather than leaving the reader without one until the next load. */
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

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

/**
 * Which of the four sentences one row gets. `sent` is the only state the clock can move:
 * `acceptInvite` refuses an invitation past its `expiresAt`, so a row still waiting after its
 * deadline is spent even though the stored word never changed. An `expiresAt` of `0` or absent
 * is a `serverTimestamp()` that had not settled when the row was read — a deadline nobody
 * knows yet, not one that has gone by, so the row stays `sent`. A stored word this screen has
 * no sentence for gets none rather than the wrong one.
 */
function inviteState(row: InviteRow, nowSeconds: number): InviteState | null {
  if (row.status === 'accepted') return 'accepted';
  if (row.status === 'revoked') return 'revoked';
  if (row.status !== 'sent') return null;
  const expiresAt = row.expiresAt ?? 0;
  return expiresAt !== 0 && expiresAt <= nowSeconds ? 'expired' : 'sent';
}

/** Epoch seconds as the reader's own clock reads them. A `0` is a server write that had not
 *  settled, so it prints nothing at all rather than a midnight in 1970. */
function when(seconds: number | undefined): string | null {
  return seconds === undefined || seconds === 0 ? null : new Date(seconds * 1000).toLocaleString();
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

  const [invites, setInvites] = useState<InviteRow[]>([]);
  // `createInvite` is the only thing that ever hands back a link, and it hands it back once:
  // `listInvites` carries the invite id and nothing else. So the links this session was given
  // are kept here, and a row shows one only when its id is in this record.
  const [links, setLinks] = useState<Record<string, string>>({});
  const [listing, setListing] = useState(ORG_ID_RE.test(fixedOrgId ?? ''));
  const [mayList, setMayList] = useState(true);

  const [granting, setGranting] = useState<InviteRow | null>(null);
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

  // Every invitation of this organisation, not only the ones this browser made — `listInvites`
  // is the only way an organiser sees one a colleague created. A refusal here is not a failure:
  // `permission-denied` is the ordinary answer for a manager without `PERM_MANAGE_MANAGERS`,
  // and that person still has an invite form to use, so it costs a line rather than an alert.
  useEffect(() => {
    if (!ORG_ID_RE.test(orgId)) {
      setInvites([]);
      setListing(false);
      return undefined;
    }
    let cancelled = false;
    setListing(true);
    void (async () => {
      try {
        const rows = await api.listInvites({ orgId });
        if (cancelled) return;
        setInvites(rows);
        setMayList(true);
      } catch (cause) {
        if (cancelled) return;
        const { code } = callableFailure(cause);
        if (code === 'permission-denied') setMayList(false);
        else setProblem('failed');
      } finally {
        if (!cancelled) setListing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  /** The chain's own answer to "did it land?", which is the only one this screen trusts. */
  const check = useCallback(async (): Promise<void> => {
    // The role asked about is the one on the invitation being granted, never the invite form's:
    // the two are separate choices, and an admin row read as a manager would answer about the
    // wrong mapping entirely.
    if (granting === null) return;
    // Strict: a mixed-case address whose EIP-55 checksum does not add up is one character of
    // somebody else's, and admin bits on an account nobody holds cannot be taken back.
    if (!ORG_ID_RE.test(orgId) || !isAddress(account, { strict: true })) return;
    const target = account as Hex;
    const organizers = readOrganizers();
    const held =
      granting.role === 'admin'
        ? await organizers
            .adminBitsOf(BigInt(orgId), target)
            .then((value) => value !== 0)
            .catch(() => false)
        : await organizers
            .managerOf(BigInt(orgId), target)
            .then((manager) => manager.exists)
            .catch(() => false);
    setGranted(held);
  }, [account, granting, orgId]);

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
      // The row is put in front of the list rather than refetched: the server answers newest
      // first, this is the newest, and a refetch would make the organiser wait to see the
      // invitation they just made — with its link, which nothing else will ever hand back.
      const now = Math.floor(Date.now() / 1000);
      setLinks((current) => ({ ...current, [created.inviteId]: created.link }));
      setInvites((current) => [
        {
          inviteId: created.inviteId,
          role,
          status: 'sent',
          createdAt: now,
          expiresAt: now + INVITE_TTL_SECONDS,
        },
        ...current,
      ]);
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
        current.map((entry) => (entry.inviteId === inviteId ? { ...entry, status: 'revoked' } : entry)),
      );
    } catch (cause) {
      const { code } = callableFailure(cause);
      setProblem(code === 'not-found' ? 'notFound' : code === 'permission-denied' ? 'notAllowed' : 'failed');
    }
  }

  async function grant(): Promise<void> {
    // The grant belongs to one accepted invitation, so there is nothing to send without one.
    if (granting === null) return;
    setProblem('');
    setConfirming(false);
    setUnsponsored(false);
    setGranted(false);
    if (!ORG_ID_RE.test(orgId)) return setProblem('orgId');
    if (!isAddress(account, { strict: true })) return setProblem('account');
    if (granting.role === 'admin' && bits === 0) return setProblem('bits');

    setBusy(true);
    try {
      await organizersOp({
        account: await getStaffAccount(),
        orgId: BigInt(orgId),
        ...(granting.role === 'admin'
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

  // Read once per render so every row on screen is judged against the same instant.
  const nowSeconds = Math.floor(Date.now() / 1000);

  return (
    <Screen title={copy.title}>
      {problem === '' ? null : <Alert tone="error">{copy.problems[problem]}</Alert>}
      {confirming ? <Alert tone="info">{lifecycle.confirming}</Alert> : null}
      {unsponsored ? <UnsponsoredNotice /> : null}
      {busy ? <Alert tone="info">{copy.working}</Alert> : null}
      {/* Narrower than the chain, on purpose: `setManager` accepts any holder of
          `PERM_MANAGE_MANAGERS`, not only the owner. `setAdmin` is owner-only, and one rule for
          the last step is easier to explain than two — that is the ruling here, not an
          oversight. Anybody else who tries is refused by the contract anyway. */}
      {isOwner === false ? <Alert tone="warn">{copy.notOwner}</Alert> : null}

      {fixedOrgId === undefined ? (
        <Field label={copy.problems.orgId}>
          <input value={orgId} inputMode="numeric" onChange={(event) => setOrgId(event.target.value)} />
        </Field>
      ) : null}

      <section>
        <h2>{copy.invite}</h2>

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

        <Field label={copy.phone}>
          <input value={phone} inputMode="tel" placeholder="+8210…" onChange={(event) => setPhone(event.target.value)} />
        </Field>
        <Button disabled={busy} onClick={() => void invite()}>
          {copy.invite}
        </Button>
        {Object.keys(links).length > 0 ? <p>{copy.invited}</p> : null}
      </section>

      <section>
        <h2>{copy.invites}</h2>
        {listing ? <p>{copy.invitesLoading}</p> : null}
        {!listing && !mayList ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>{copy.invitesNotAllowed}</p> : null}
        {!listing && mayList && invites.length === 0 ? <p>{copy.invitesEmpty}</p> : null}

        <ul style={{ listStyle: 'none', padding: 0 }}>
          {invites.map((row) => {
            const state = inviteState(row, nowSeconds);
            const createdAt = when(row.createdAt);
            const expiresAt = when(row.expiresAt);
            const link = links[row.inviteId];
            return (
              <li key={row.inviteId} style={{ marginBottom: 12 }}>
                <p>
                  <strong>{row.role === 'admin' ? copy.admin : copy.manager}</strong>{' '}
                  {state === null ? null : <span>{copy.status[state]}</span>}
                </p>
                {createdAt === null ? null : (
                  <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                    {copy.createdAt} {createdAt}
                  </p>
                )}
                {expiresAt === null ? null : (
                  <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                    {copy.expiresAt} {expiresAt}
                  </p>
                )}

                {link === undefined ? null : (
                  <>
                    <p style={{ wordBreak: 'break-all' }}>
                      {copy.link} {link}
                    </p>
                    <p style={{ color: 'var(--muted)', fontSize: 13 }}>{copy.linkOnce}</p>
                  </>
                )}

                {/* `requiredSender` is `ownerOf` as it is *now*, which is why it is read off the
                    row rather than remembered from whoever made the invitation. It sits here,
                    directly above the panel, so the owner can compare it with their own account
                    before sending. */}
                {row.status === 'accepted' && row.requiredSender !== undefined ? (
                  <p style={{ wordBreak: 'break-all' }}>
                    {copy.requiredSender} {row.requiredSender}
                  </p>
                ) : null}

                {granting !== null && granting.inviteId === row.inviteId ? (
                  <>
                    <p style={{ color: 'var(--muted)', fontSize: 13 }}>{copy.grantHelp}</p>
                    <Field label={copy.account}>
                      <input value={account} autoComplete="off" onChange={(event) => setAccount(event.target.value)} />
                    </Field>
                    {granting.role === 'manager' ? (
                      <label>
                        <input
                          type="checkbox"
                          checked={canApprove}
                          onChange={(event) => setCanApprove(event.target.checked)}
                        />
                        {canApprove ? copy.canApprove : copy.requestOnly}
                      </label>
                    ) : (
                      PERMISSION_BITS.map((permission) => (
                        <label key={permission.name} style={{ display: 'block' }}>
                          <input
                            type="checkbox"
                            checked={(bits & permission.bit) !== 0}
                            onChange={(event) =>
                              setBits((current) =>
                                event.target.checked ? current | permission.bit : current & ~permission.bit,
                              )
                            }
                          />
                          {copy.perms[permission.name]}
                        </label>
                      ))
                    )}
                    {granted ? <Alert tone="info">{copy.granted}</Alert> : null}
                    <Button disabled={busy} onClick={() => void grant()}>
                      {copy.grant}
                    </Button>
                    <Button variant="ghost" onClick={() => void check()}>
                      {copy.check}
                    </Button>
                  </>
                ) : row.status === 'accepted' && isOwner ? (
                  <Button onClick={() => setGranting(row)}>{copy.grant}</Button>
                ) : null}

                {/* The server takes a withdrawal for `sent` and `accepted` and answers
                    `revoked` either way; anything else it refuses, so nothing is offered. */}
                {row.status === 'sent' || row.status === 'accepted' ? (
                  <Button variant="ghost" onClick={() => void revoke(row.inviteId)}>
                    {copy.revoke}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </Screen>
  );
}
