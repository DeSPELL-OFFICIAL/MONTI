import type { Abi } from 'viem';
import identityAbiJson from './abi/Identity.json';
import montiForwarderAbiJson from './abi/MontiForwarder.json';
import organizersAbiJson from './abi/Organizers.json';
import settlementVaultAbiJson from './abi/SettlementVault.json';
import ticketAbiJson from './abi/Ticket.json';

/**
 * sub-plan 01의 script/export-abi.sh 가 컴파일 산출물에서 뽑은 **전체 ABI** 다.
 * 손으로 항목을 추가하지 않는다 — 컨트랙트가 바뀌면 01이 다시 뽑아 준다.
 * JSON import 라 리터럴 타입이 없으므로 readContract 결과는 호출부에서 캐스팅한다.
 *
 * Phase 2(설계 §3): 4337 페이마스터·Coinbase 스마트월렛 팩토리 ABI 는 폐기됐고,
 * P-256 기기키 ERC-2771 전달자 `MontiForwarder` 가 그 자리를 대신한다.
 */
export const identityAbi = identityAbiJson as Abi;
export const organizersAbi = organizersAbiJson as Abi;
export const ticketAbi = ticketAbiJson as Abi;
export const forwarderAbi = montiForwarderAbiJson as Abi;
export const settlementVaultAbi = settlementVaultAbiJson as Abi;
