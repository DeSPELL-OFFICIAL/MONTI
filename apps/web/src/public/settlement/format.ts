import { keccak256, toBytes, type Hex } from 'viem';

/** 6-dp USDC base units (bigint, or the numeric string the indexer returns) -> "$12.34". */
export function usdFromBaseUnits(raw: string | bigint | null | undefined): string {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw && raw !== '' ? raw : '0');
  return formatUsd(Number(value) / 1_000_000);
}

/** USD cents (the per-tier price the server stores) -> "$30.00". */
export function usdFromCents(cents: number): string {
  return formatUsd((Number.isFinite(cents) ? cents : 0) / 100);
}

/** One dollar amount, always two decimals — the reader never sees six. */
export function formatUsd(dollars: number): string {
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Basis points -> a percentage a person reads: 1500 -> "15%", 1250 -> "12.5%". */
export function percentFromBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(1))}%`;
}

/** One recipient as the public page shows it, joined from the server's readable policy. */
export interface ReadableRecipient {
  account: string;
  bps: number;
  reason: string;
  tag: string;
}

/**
 * The server stores each recipient's readable `reason`; the chain and the indexer carry only
 * `reasonHash = keccak256(utf8(reason))`. This recomputes that hash so a payout row the indexer
 * returns (which has only the hash) can be matched back to the word a person reads — proof the
 * label was not swapped. {@link toBytes} encodes the string as UTF-8, the same bytes the contract
 * hashed, exactly as the region picker hashes its choice in `useEvents.ts`.
 */
export function reasonHashOf(reason: string): Hex {
  return keccak256(toBytes(reason));
}

export interface ReasonLookup {
  byHash: Map<string, string>;
  byAccount: Map<string, string>;
}

/** Build the hash->label and account->label maps once from the server's recipient list. */
export function buildReasonLookup(recipients: ReadableRecipient[]): ReasonLookup {
  const byHash = new Map<string, string>();
  const byAccount = new Map<string, string>();
  recipients.forEach((recipient, index) => {
    const label = recipient.reason || recipient.tag || `수령인 ${index + 1}`;
    if (recipient.account) byAccount.set(recipient.account.toLowerCase(), label);
    if (recipient.reason) byHash.set(reasonHashOf(recipient.reason).toLowerCase(), label);
  });
  return { byHash, byAccount };
}

/**
 * The readable role behind a payout: match the on-chain `reasonHash` first (tamper-proof), fall
 * back to the recipient address, then to a numbered placeholder — the brief's exact fallback order.
 */
export function reasonForPayout(
  payout: { recipient: string; reasonHash: string },
  lookup: ReasonLookup,
  index: number,
): string {
  return (
    lookup.byHash.get((payout.reasonHash ?? '').toLowerCase()) ??
    lookup.byAccount.get((payout.recipient ?? '').toLowerCase()) ??
    `수령인 ${index + 1}`
  );
}

/** A 0x value shortened for display: 0x1234…abcd. */
export function shortHex(value: string): string {
  return value && value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
