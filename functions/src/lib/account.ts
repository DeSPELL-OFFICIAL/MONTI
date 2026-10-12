import { getAddress, parseAbi } from 'viem';
import { COINBASE_SMART_WALLET_FACTORY_ADDRESS, type Hex } from '@monti/shared';
import { publicClient } from './chain.js';

/**
 * Coinbase Smart Wallet 팩토리의 counterfactual 주소 계산에 필요한 최소 ABI(설계 §3·§7).
 * 4337 은 폐기됐지만 계정은 여전히 counterfactual 이라 이 view 로 주소만 예측한다.
 */
const coinbaseFactoryAbi = parseAbi([
  'function getAddress(bytes[] owners, uint256 nonce) view returns (address)',
]);

/** 사람마다 계정은 하나뿐이라 팩토리 nonce 는 항상 0이다. 기기 추가는 소유자 추가지 새 계정이 아니다. */
const ACCOUNT_NONCE = 0n;

/**
 * 소유자 한 명(`ownerBytes(x, y)` — 64바이트 P-256 x||y)인 스마트 계정의 주소를 팩토리에서
 * 미리 계산해 체크섬 주소로 돌려준다. 패스키 소유자(registerPasskey·recoverAccess)와
 * 기기 키 소유자(open 모드 registerIdentity)가 같은 형식이라 같은 함수를 쓴다.
 */
export async function predictAccount(owner: Hex): Promise<Hex> {
  const predicted = await publicClient().readContract({
    address: COINBASE_SMART_WALLET_FACTORY_ADDRESS,
    abi: coinbaseFactoryAbi,
    functionName: 'getAddress',
    args: [[owner], ACCOUNT_NONCE],
  });
  return getAddress(predicted as string) as Hex;
}
