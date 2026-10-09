import { useEffect, useState, type ReactElement } from 'react';

import { OVERRIDE_REASONS } from '@monti/shared';

import { Button } from '../../shared/ui';
import { useStaffCopy } from '../copy';
import type { OverrideOutcome, OverrideReason, SnapshotTicket } from '../types';
import { ROLE_KEY, STATUS_KEY, reasonKey, shortAccount } from './overrideText';

const NON_DIGITS = /\D/g;

function toReason(value: string): OverrideReason {
  const parsed = Number(value);
  return (OVERRIDE_REASONS as readonly number[]).includes(parsed)
    ? (parsed as OverrideReason)
    : OVERRIDE_REASONS[0];
}

/** 표 번호 뒷자리만. 콘솔의 다른 화면과 같은 가림이다. */
const maskTicketId = (tokenId: string): string => `••${tokenId.slice(-2)}`;

export interface OverrideDialogProps {
  canApprove: boolean;
  /**
   * 탭으로 이미 화면에 있는 표. 있으면 그 사람이 기본값이고, 없으면 아래 찾기 칸이 뜬다.
   */
  ticket?: SnapshotTicket;
  /**
   * 명단에서 이름·표 번호로 찾기(`snapshot/store.ts` 의 `search`). 배선이 넘겨준다 — 이 파일은
   * 명단을 읽지 않는다. 명단 한 줄이 무슨 뜻인지 정하는 곳은 `snapshot/lookup.ts` 하나다.
   */
  onSearch?: (query: string) => readonly SnapshotTicket[];
  /**
   * 명단이 못 찾을 때의 두 번째 길(`gate/overrideLookup.ts`). 숫자(표 번호)만 입력됐고 위
   * `onSearch` 가 비어 돌아왔을 때만 체인에 한 번 물어, 얼어붙은 인덱서가 빠뜨린 방금 발급된
   * 표를 세운다. 없으면 `undefined` — 창은 '명단에 없음'으로 남는다.
   */
  onResolve?: (query: string) => Promise<SnapshotTicket | undefined>;
  /** 이 승인이 어떻게 됐는지(04 T32). 창을 닫지 않고 여기서 그대로 보여준다. */
  outcome?: OverrideOutcome;
  onSubmit: (pin: string, reason: OverrideReason, tokenId?: string) => void;
  onCancel: () => void;
}

/**
 * 수동 승인 창.
 *
 * **탭이 없어도 열린다.** 이 기능이 있는 이유가 바로 그 경우다 — 휴대폰이 아무것도 내놓지 못하는
 * 관객. 그래서 창은 명단에서 사람을 찾는 칸으로 시작하고, 탭이 이미 있으면 그 사람이 기본값이다.
 * 표를 고르지 않으면 보낼 수 없다: `Ticket.manualOverride(tokenId, …)` 는 누구인지를 반드시
 * 알아야 한다.
 *
 * 이 파일은 여전히 **판단하지 않는다.** PIN 이 맞는지도, 이 계정이 승인할 수 있는지도 묻지
 * 않는다 — 앞의 것은 `override/pin.ts`, 뒤의 것은 `Organizers` 를 그 자리에서 읽는
 * `override/route.ts` 의 몫이다. 여기서 조금이라도 판단을 하면 문을 여는 규칙이 화면과 체인
 * 두 곳에 살게 되고, 그것은 그 자체로 사고다.
 *
 * 단추 문구가 권한에 따라 갈리는 것은 판단이 아니라 **체인이 방금 답한 사실의 표시**다:
 * 승인할 수 있는 사람에게는 "수동 승인", 없는 사람에게는 "결재 요청 보내기" — 누를 수 없는
 * 단추를 비활성으로 보여주고 끝내면, 권한 없는 스태프 앞에 선 관객은 아무 데도 갈 수 없다.
 *
 * PIN 은 가려서 받고, 틀리면 지운다. 줄 서 있는 사람들이 보고 있는 화면에서 틀린 값을 고쳐
 * 넣게 하지 않는다.
 */
export function OverrideDialog({
  canApprove,
  ticket,
  onSearch,
  onResolve,
  outcome,
  onSubmit,
  onCancel,
}: OverrideDialogProps): ReactElement {
  const copy = useStaffCopy();
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState<OverrideReason>(OVERRIDE_REASONS[0]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<SnapshotTicket | undefined>(ticket);

  // 보내는 중이거나 이미 끝난 승인은 두 번 보내지 않는다. 실패만 다시 누를 수 있다.
  const settled = outcome?.status === 'requested' || outcome?.status === 'approved';
  const busy = outcome?.status === 'sending';
  const locked = busy || settled;

  // 틀린 PIN 은 화면에서 지운다. 상태가 바뀐 그 렌더에서 한 번만.
  const [clearedFor, setClearedFor] = useState<OverrideOutcome>();
  if (outcome?.status === 'failed' && outcome !== clearedFor) {
    setClearedFor(outcome);
    if (pin !== '') setPin('');
  }

  const trimmed = query.trim();
  const matches = trimmed === '' ? [] : (onSearch?.(query) ?? []);

  // 명단이 못 찾은 표 번호를 체인에서 한 장 세우는 두 번째 길. 숫자만 입력됐고 동기 검색이
  // 비었을 때만 물어본다 — `onResolve` 는 비동기라 결과를 상태로 받아 그리고, 입력이 바뀌면
  // 지난 조회의 답은 버린다(`live`).
  const digits = /^[0-9]+$/.test(trimmed);
  const [chainMatch, setChainMatch] = useState<SnapshotTicket | undefined>(undefined);
  useEffect(() => {
    if (onResolve === undefined || matches.length > 0 || !digits) {
      setChainMatch(undefined);
      return;
    }
    let live = true;
    void onResolve(trimmed).then((found) => {
      if (live) setChainMatch(found);
    });
    return () => {
      live = false;
    };
  }, [onResolve, trimmed, digits, matches.length]);

  // 명단이 찾았으면 그 줄, 못 찾았고 체인이 세웠으면 그 한 줄. 스태프는 어느 쪽이든 똑같이 눌러 고른다.
  const shown = matches.length > 0 ? matches : chainMatch ? [chainMatch] : [];

  return (
    <div className="gate-dialog" role="dialog" aria-modal="true" aria-label={copy.override.title}>
      <h2 className="gate-dialog__title">{copy.override.title}</h2>

      {picked === undefined ? (
        <>
          <label className="gate-dialog__field">
            <span>{copy.override.searchLabel}</span>
            <input
              type="search"
              autoComplete="off"
              aria-label={copy.override.searchLabel}
              value={query}
              disabled={locked}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {trimmed === '' ? (
            <p className="gate-dialog__hint">{copy.override.searchHint}</p>
          ) : shown.length === 0 ? (
            <p className="gate-dialog__hint">{copy.override.searchEmpty}</p>
          ) : (
            <ul className="gate-dialog__matches">
              {shown.map((match) => (
                <li key={match.tokenId}>
                  <Button variant="ghost" onClick={() => setPicked(match)}>
                    {`${match.displayName} ${maskTicketId(match.tokenId)}`}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="gate-dialog__chosen">
          <span>{copy.override.chosenLabel}</span>{' '}
          <strong>{`${picked.displayName} ${maskTicketId(picked.tokenId)}`}</strong>{' '}
          {locked ? null : (
            <Button
              variant="ghost"
              onClick={() => {
                setPicked(undefined);
                setQuery('');
              }}
            >
              {copy.override.searchAgain}
            </Button>
          )}
        </p>
      )}

      <label className="gate-dialog__field">
        <span aria-hidden="true">{copy.override.pin}</span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-label={copy.override.pin}
          value={pin}
          disabled={locked}
          onChange={(event) => setPin(event.target.value.replace(NON_DIGITS, ''))}
        />
      </label>

      <label className="gate-dialog__field">
        <span>{copy.override.reasonLabel}</span>
        <select
          value={String(reason)}
          disabled={locked}
          onChange={(event) => setReason(toReason(event.target.value))}
        >
          {OVERRIDE_REASONS.map((code) => (
            <option key={code} value={String(code)}>
              {copy.override[reasonKey(code)]}
            </option>
          ))}
        </select>
      </label>

      {outcome === undefined ? null : <Outcome outcome={outcome} />}

      {settled ? null : (
        <Button onClick={() => onSubmit(pin, reason, picked?.tokenId)} disabled={busy}>
          {canApprove ? copy.override.approve : copy.override.request}
        </Button>
      )}
      <Button variant="ghost" onClick={onCancel}>{settled ? copy.done : copy.override.cancel}</Button>
    </div>
  );
}

/**
 * 결과 한 덩이. `role="status"` 라서 스태프가 단추에서 눈을 떼고 있어도 읽힌다 — 이 창이 열려
 * 있는 동안 게이트는 탭을 받지 않으므로, 여기 말고 다른 곳에서 읽힐 문장은 없다.
 */
function Outcome({ outcome }: { outcome: OverrideOutcome }): ReactElement {
  const copy = useStaffCopy();
  return (
    <div className="gate-dialog__outcome" role="status">
      <p className="gate-dialog__outcome-line">
        {outcome.detail ?? copy.override[STATUS_KEY[outcome.status]]}
      </p>
      <dl className="gate-dialog__facts">
        <dt>{copy.override.reasonLabel}</dt>
        <dd>{copy.override[reasonKey(outcome.reason)]}</dd>
        {outcome.role === undefined ? null : (
          <>
            <dt>{copy.override.roleLabel}</dt>
            <dd>{copy.override[ROLE_KEY[outcome.role]]}</dd>
          </>
        )}
        {outcome.approver === undefined ? null : (
          <>
            <dt>{copy.override.approverLabel}</dt>
            <dd className="mono">{shortAccount(outcome.approver)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
