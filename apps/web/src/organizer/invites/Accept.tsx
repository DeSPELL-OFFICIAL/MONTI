import { useCallback, useEffect, useState } from 'react';
import type { Hex } from 'viem';
import { useParams } from 'react-router-dom';
import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { api, callableFailure, type InviteCalldata } from '../../shared/api/functions';
import { getStaffAccount } from '../../shared/chain/accounts';
import { readOrganizers } from '../../shared/chain/reads';
import { useOrganizerCopy, type OrganizerCopy } from '../copy';

type InviteProblem = keyof OrganizerCopy['invite']['problems'];

/** The server's reason codes for this one callable, against the sentence that explains them. */
const INVITE_PROBLEMS: Readonly<Record<string, InviteProblem>> = {
  INVITE_NOT_FOR_YOU: 'notForYou',
  INVITE_ALREADY_USED: 'used',
  INVITE_NOT_OPEN: 'used',
  INVITE_EXPIRED: 'expired',
  INVITE_NOT_FOUND: 'notFound',
  PHONE_INDEX_MISSING: 'noPhone',
};

/**
 * Where the link in an invitation lands (`https://<rp>/org/invite/<id>`).
 *
 * Accepting binds the invitation to this account and hands back the calldata that grants the
 * role — but not the right to send it. `Organizers` takes `setAdmin` only from the
 * organisation's owner, so the last step is the owner's, and `requiredSender` is who that is
 * right now. This screen therefore ends by showing the invited person their own account
 * address to pass on, and then watches the chain for the role appearing.
 *
 * It never watches the invitation document: `done` there is written by the Tenderly webhook,
 * which is a mirror of the chain and can be late or absent. The chain is asked directly.
 */
export function AcceptInvite() {
  const { inviteId = '' } = useParams();
  const organizer = useOrganizerCopy();
  const copy = organizer.invite;

  const [invite, setInvite] = useState<InviteCalldata | null>(null);
  const [account, setAccount] = useState<Hex | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<InviteProblem | ''>('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (inviteId === '') return undefined;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const mine = await getStaffAccount()
        .then((staff) => staff.address as Hex)
        .catch(() => null);
      try {
        const accepted = await api.acceptInvite({ inviteId });
        if (cancelled) return;
        setInvite(accepted);
        setAccount(mine);
      } catch (cause) {
        if (cancelled) return;
        const { code, reason } = callableFailure(cause);
        setProblem(INVITE_PROBLEMS[reason] ?? (code === 'not-found' ? 'notFound' : 'failed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteId]);

  const check = useCallback(async (): Promise<void> => {
    if (!invite || !account) return;
    const organizers = readOrganizers();
    const held =
      invite.role === 'admin'
        ? await organizers
            .adminBitsOf(BigInt(invite.orgId), account)
            .then((bits) => bits !== 0)
            .catch(() => false)
        : await organizers
            .managerOf(BigInt(invite.orgId), account)
            .then((manager) => manager.exists)
            .catch(() => false);
    setDone(held);
  }, [account, invite]);

  // One look on arrival: the owner may have sent it while the invited person was elsewhere.
  useEffect(() => {
    void check();
  }, [check]);

  if (loading) {
    return (
      <Screen title={copy.title}>
        <Spinner />
        <p>{copy.working}</p>
      </Screen>
    );
  }

  if (problem !== '' || invite === null) {
    return (
      <Screen title={copy.title}>
        <Alert tone="error">{copy.problems[problem === '' ? 'failed' : problem]}</Alert>
      </Screen>
    );
  }

  const roleName = invite.role === 'admin' ? organizer.team.admin : organizer.team.manager;

  return (
    <Screen title={copy.title}>
      <Alert tone="info">{copy.accepted}</Alert>
      <p>
        {copy.orgId} {invite.orgId}
      </p>
      <p>
        {copy.role} {roleName}
      </p>
      {done ? (
        <Alert tone="info">{copy.done}</Alert>
      ) : (
        <>
          <p>{copy.ownerMustSend}</p>
          <p style={{ wordBreak: 'break-all' }}>
            {copy.yourAccount} {account ?? ''}
          </p>
          <p style={{ wordBreak: 'break-all', color: 'var(--muted)', fontSize: 13 }}>
            {copy.owner} {invite.requiredSender}
          </p>
          <p>{copy.waiting}</p>
          <Button onClick={() => void check()}>{copy.check}</Button>
        </>
      )}
    </Screen>
  );
}
