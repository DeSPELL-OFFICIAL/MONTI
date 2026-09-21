import type { Abi } from 'viem';
import coinbaseFactoryAbiJson from './abi/CoinbaseSmartWalletFactory.json';
import identityAbiJson from './abi/Identity.json';
import montiPaymasterAbiJson from './abi/MontiPaymaster.json';
import organizersAbiJson from './abi/Organizers.json';
import ticketAbiJson from './abi/Ticket.json';

/**
 * sub-plan 01의 script/export-abi.sh 가 컴파일 산출물에서 뽑은 **전체 ABI** 다.
 * 손으로 항목을 추가하지 않는다 — 컨트랙트가 바뀌면 01이 다시 뽑아 준다.
 * JSON import 라 리터럴 타입이 없으므로 readContract 결과는 호출부에서 캐스팅한다.
 */
export const identityAbi = identityAbiJson as Abi;
export const organizersAbi = organizersAbiJson as Abi;
export const ticketAbi = ticketAbiJson as Abi;
export const montiPaymasterAbi = montiPaymasterAbiJson as Abi;
export const coinbaseFactoryAbi = coinbaseFactoryAbiJson as Abi;
