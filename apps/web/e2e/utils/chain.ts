import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createPublicClient, defineChain, http, type Hex } from 'viem';
import { ticketAbi } from '@monti/shared';

/**
 * Read-only chain truth for the harness (v2 rc1 addresses from `deployments/10143.json`). Specs
 * never trust a screen for an on-chain fact: event status, gate open/registered and MON spent are
 * read here. Every address can be overridden for a run against another deployment.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const deployments = JSON.parse(
  readFileSync(resolve(HERE, '../../../../packages/shared/src/deployments/10143.json'), 'utf8'),
) as { chainId: number; ticket: Hex; organizers: Hex; settlementVault?: Hex };

export const RPC_URL = process.env.E2E_RPC_URL ?? 'https://testnet-rpc.monad.xyz';
export const TICKET_ADDRESS = (process.env.E2E_TICKET_ADDR ?? deployments.ticket) as Hex;
export const ORGANIZERS_ADDRESS = (process.env.E2E_ORGANIZERS_ADDR ?? deployments.organizers) as Hex;
/** The MONTI relayer EOA that pays for every relayed write (publish, gate, override, free claim). */
export const RELAYER = (process.env.E2E_RELAYER ?? '0xFA93A9dB40a4396a8CdcF63991FA8615d1A35fFd') as Hex;
/** The treasury (vault depositor) that sends v2's one-step `purchase` and fronts the USDC. */
export const TREASURY = (process.env.E2E_TREASURY ?? '0xAe6D18fA7dC1e2512a2dC7DaE1d4640D7D786Bb2') as Hex;

const monad = defineChain({
  id: deployments.chainId,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
export const chain = createPublicClient({ chain: monad, transport: http(RPC_URL) });

/** MON balance in wei, or 0n when the RPC does not answer (a cost line is never worth a failure). */
export async function monBalance(address: Hex): Promise<bigint> {
  return chain.getBalance({ address }).catch(() => 0n);
}

/** Wei → MON with nine decimals, for the diag files. */
export function fmtMon(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(9);
}

/** `Ticket.eventStatus` — 0 = no such event (v2 has no on-chain Draft), 1 = Published. */
export async function eventStatus(eventId: string): Promise<number> {
  const status = await chain.readContract({
    address: TICKET_ADDRESS, abi: ticketAbi, functionName: 'eventStatus', args: [BigInt(eventId)],
  });
  return Number(status);
}

const organizersAbi = [
  { type: 'function', name: 'gateOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', name: 'gateInfo', stateMutability: 'view', inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'eventId', type: 'uint256' }, { name: 'account', type: 'address' },
      { name: 'kx', type: 'bytes32' }, { name: 'ky', type: 'bytes32' },
      { name: 'open', type: 'bool' }, { name: 'revoked', type: 'bool' },
    ],
  },
] as const;

/** The gate id a terminal account was registered as, or 0n. */
export async function gateOf(account: Hex): Promise<bigint> {
  return chain.readContract({
    address: ORGANIZERS_ADDRESS, abi: organizersAbi, functionName: 'gateOf', args: [account],
  }).catch(() => 0n);
}

/** Whether a registered gate is open on chain (v2: true straight after `registerGate`). */
export async function gateOpen(gateId: bigint): Promise<boolean> {
  const info = await chain.readContract({
    address: ORGANIZERS_ADDRESS, abi: organizersAbi, functionName: 'gateInfo', args: [gateId],
  }).catch(() => null);
  return info === null ? false : Boolean(info[4]);
}

/** Polls `read` until it returns a truthy value or `ms` passes; answers the last value read. */
export async function pollUntil<T>(read: () => Promise<T>, ms: number, everyMs = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!value && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, everyMs));
    value = await read();
  }
  return value;
}
