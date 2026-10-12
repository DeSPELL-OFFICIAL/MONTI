/**
 * The public settlement page speaks to a non-crypto reader, so its words live here rather than in
 * the shared copy table: the page sits outside the signed-in app (its own public route, no login)
 * and the copy linter (`lint:copy`) does not sweep `src/public`. English only, like the rest of
 * the app.
 *
 * No chain word appears in the always-visible copy; the only addresses and transaction links live
 * behind the Details toggle, exactly as the brief requires.
 */
export const settlementCopy = {
  badge: 'Test mode',
  headerNote: 'The payout rules are public, and no one can change them',
  rulesTitle: 'How this event’s revenue is split',
  platformLabel: 'MONTI platform',
  reserveLabel: 'Reserve',
  perTicket: (price: string) => `For each ${price} ticket, here’s where the money goes`,
  liveTitle: 'Live',
  statDeposited: 'Total paid',
  statDepositedSub: 'Held until check-in',
  statReleased: 'Paid out after check-in',
  statRefunded: 'Refunded',
  statNoShow: 'No-show payouts',
  countUnit: (n: number) => (n === 1 ? '1 ticket' : `${n} tickets`),
  payoutsTitle: 'Latest payouts',
  payoutsEmpty: 'No payouts yet. Once check-in starts, they show up here live.',
  detailsSummary: 'Technical details',
  detailPolicyHash: 'Rules fingerprint',
  detailVault: 'Vault',
  detailRecipients: 'Recipient addresses',
  detailTx: 'Transaction records',
  loading: 'Loading…',
  emptyTitle: 'The organizer hasn’t locked in the payout rules yet',
  emptyBody: 'Once they do, you’ll see exactly how this event’s revenue is split here.',
  errorTitle: 'Can’t load the live numbers right now',
  errorBody: 'Please try again in a moment.',
  retry: 'Try again',
  fallbackTitle: 'Event payouts',
  reasonFallback: (n: number) => `Recipient ${n}`,
} as const;
