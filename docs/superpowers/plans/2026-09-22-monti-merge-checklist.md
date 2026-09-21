# MONTI — cross-branch interface diff, merge checklist, and the 01b flip-day list

Task 34 of sub-plan 04, executed under the controller rulings: read-only across the five
worktrees, no code edits, this document is the only write.

**Pinned to these commits.** Everything below was derived by `git diff`/`diff -u` and by reading
the files, not from any task report. Re-verify if a branch has moved.

| Worktree | Branch | HEAD at time of writing |
|---|---|---|
| `MONTI-prod` | `mvp` | `c5bc4e4` |
| `MONTI-01b` | `mvp-01b` | `f89132f` |
| `MONTI-backend` | `mvp-backend` | `3519931` |
| `MONTI-web` | `mvp-web` | `c28f473` |
| `MONTI-staff` | `mvp-staff` | `f4ab1dd` |

Ancestry that shapes everything else:

- `mvp-01b` is a **strict descendant of `mvp`** (`merge-base = c5bc4e4 = mvp`).
- `mvp`/`mvp-01b` carry only `contracts/`, `docs/` and `packages/shared/src/abi/*.json`. The
  TypeScript half of `packages/shared` exists **only** on the three consumer branches.
- `mvp-backend` forked from the consumer lineage at `23cc031`; `mvp-staff` forked from `mvp-web`
  at `d54aaa1` (after the `a7faf4e` merge).
- `packages/shared/src/abi/*.json` is **byte-identical on `mvp`, `mvp-web`, `mvp-staff` and
  `mvp-backend`**, and `mvp-01b` is a pure superset of it (Ticket 105→116, Identity 41→47,
  MontiPaymaster 42→45, Organizers and CoinbaseSmartWalletFactory unchanged). No consumer has
  ever hand-edited an ABI file, so the ABI never conflicts.

Winners are assigned per the controller rulings: **`mvp-web` owns `packages/shared` until the
merge**, **`mvp-backend` owns callable request/response shapes**, **`mvp-01b` owns the ABI**.
Where following a ruling literally would break the other branch, that is called out as an
**exception** with the reason.

Sub-plan ledger rulings are cited as **P00/P02/P03/P04/P01b:line**, against
`MONTI-prod/.superpowers/sdd/2026-09-20-monti-{00-master-plan,02-firebase-indexer,03-web-attendee,04-staff-android}/progress.md`
and `…/2026-09-22-monti-01b-redeploy-bundle/progress.md`. The binding merge order is
**P03:148 = P04:53**, restated at **P01b:19**.

**One ledger note is now stale.** P04:36 says "`packages/shared/src/encoding.ts` will conflict at
the next mvp-web→mvp-staff merge — take web's side". It no longer conflicts: `fbe258c` and
`43cd212` made the two copies **byte-identical** (both 395 lines, same 31 exports), which the
dry-run merge confirms. Nothing to resolve there.

---

## Part A — the drift table

**53 numbered interface rows** (D1–D53), each with file:line on both sides. Five are recorded as
*no drift* so nobody "fixes" them later — D7 (auto-merges correctly), D39 (`isOpen`: the clients
are right), D32 (backlog, has an owner), D44 and D45 (real bugs, but backend-internal rather than
cross-branch). The remaining 48 are genuine drift.

### A1 · `packages/shared/src/**`

`packages/shared/src/encoding.ts` is **byte-identical between `mvp-web` and `mvp-staff`**
(both 395 lines, same export list) — the two branches converged on it independently
(`3fdb284` on web, `43cd212`+`fbe258c` on staff). `mvp-backend`'s copy is the pre-split
ancestor and is missing half the module.

| # | Interface | `mvp-web` | `mvp-staff` | `mvp-backend` | Winner |
|---|---|---|---|---|---|
| D1 | `GATE_RESPONSE_VERSION` | `types.ts:22` → `2` | `types.ts:30` → `2` | **absent**; `GateResponseWire.v` is `1` at `types.ts:18` | **web** — v2 is the shipped wire; no device ever ran v1 |
| D2 | `GateResponseWire.nonce` | `types.ts:38` `nonce: Hex` | `types.ts:46` `nonce: Hex` | **absent** (`types.ts:17-21`) | **web** — without it the gate cannot match an answer to the code it served |
| D3 | `isGateResponseWire` | `types.ts:179` checks `v === GATE_RESPONSE_VERSION` + `isHex32(v.nonce)` | same | `types.ts:127` checks `v.v === 1`, no nonce | **web** |
| D4 | `GATE_DENY_CODES` | `types.ts:84-97` — **12** codes | `types.ts:92-106` — **13** (adds `UNKNOWN_REVERT` at `:105`) | **absent entirely** | **staff (exception)** — see D5 |
| D5 | `UNKNOWN_REVERT` | absent | `types.ts:105`; consumed at `staff/gate/denyMap.ts:33,120-121`, `staff/copy.ts:137,283`, `staff/types.ts:19` | absent | **staff — and this is the standing ruling, not an exception.** P04:58 "I3 UNKNOWN_REVERT into @monti/shared on **BOTH** branches (staff types re-export); web side UNKNOWN_REVERT → C-web-1 (shared `GATE_DENY_CODES` **13**)"; P04:60 landed it on staff (`d45751d`); P04:64 lists "web GATE_DENY_CODES 12 → 13 (C-web-1 in flight)" — **C-web-1 never landed** (P03:154 records only C-web-2). Web is simply behind. Taking web's side here would delete a code four staff modules import |
| D6 | The frozen deny-list test | `types.test.ts:105-111` pins the **12**-item list with `toEqual` | `staff/gate/denyMap.test.ts:121-122` asserts `toHaveLength(13)` and label-set equality; staff's own `packages/shared/src/types.test.ts` has **no** deny test | — | **both must move together** — either resolution reds a test on the opposite side |
| D7 | `PersonStatus` | `types.ts:4` — no `'deleted'` | `types.ts:4` — no `'deleted'` | `types.ts:4` — **has `'deleted'`** | **backend** — `accountDeletion.ts` writes that status; git auto-merges this correctly |
| D8 | `P256_ORDER` / `P256_HALF_ORDER` | `constants.ts:43-44`; used at `shared/deviceKey/native.ts:3-4,27-28` and `attendee/enter/buildResponse.ts:20,184` | **absent** — re-declared locally as `P256_N`/`P256_HALF_N` at `shared/deviceKey/native.ts:11-12` | absent | **web** — exactly the duplication the constant's own comment warns about. Git auto-merges to web's version; verify it did |
| D9 | `DEVICE_DIGEST_FORM` + `DeviceDigestForm` | `constants.ts:58-59` → `'v1-fiveField'` | `constants.ts:50-51` → `'v1-fiveField'` | **absent** | **web** (identical to staff) |
| D10 | v2 digest family (`deviceSigPreimage`, `deviceDigestPreimageV2`, `deviceDigestV2`, `deviceDigestPreimage`, `deviceDigest`, `gateCodePreimage`) | `encoding.ts:69,94,105,113,118,32` | identical lines | **absent** — only the 5-field `deviceSigHash` at `encoding.ts:38` | **web** |
| D11 | `UnknownWireKeyError`, `GateResponseVersionError` | `encoding.ts:177,235` | same | **absent** | **web** |
| D12 | `CLOCK_SKEW_SECONDS` | `constants.ts:67` | `constants.ts:59` | **absent** | **web** |
| D13 | **`offerDigest` is the pre-redeploy raw keccak on all three branches** | `encoding.ts:144-158` (`keccak256(abi.encode(uint256,bytes32,address))`); dead vector pinned at `encoding.hash.test.ts:197` | `encoding.ts:144-158` identical; vector at `encoding.hash.test.ts:186` | `encoding.ts:76-90` identical; vector at `encoding.hash.test.ts:92`; **signed for real** at `functions/src/functions/transferInvites.ts:279` and asserted at `functions/test/transferInvites.test.ts:386,405` | **01b** — `abi-delta-01b.md:149-220` replaces it with EIP-712 (`Ticket.offerDigest`, `0x50ba8511`) and says the old vector `0x90244cd7…ed0a` must be **deleted, not kept alongside**. Nobody has done this yet |
| D14 | `LATE_WINDOW_SECONDS` (43 200) / `MIGRATE_DELAY_SECONDS` (86 400) | absent | absent | absent | **01b** — required by `abi-delta-01b.md:275-276` |
| D15 | `packages/shared/src/deployments/seed-10143.json` | all zeros | all zeros | all zeros | **mvp** — `contracts/deployments/seed-10143.json` is seeded on `mvp`/`mvp-01b` (`eventId/gateId/orgId = 1`, 3 members, `tokenIds [1,2,3]`). Merging `mvp` updates the `contracts/` copy only; `pnpm --filter @monti/shared sync:deployments` must run to propagate |

### A2 · `apps/web/src/shared/api/functions.ts` vs the backend callables

Backend exposes **27** `onCall` functions from `functions/src/index.ts`; the export symbol is the
callable name in every case. Web wraps 25, staff 23. Every wrapper on both branches names a real
callable — there are **no phantom callables**. The staff copy is an older snapshot of the same
file; **web matches the backend everywhere the two clients disagree**, with two exceptions where
web is the drifted side (D26, D27).

| # | Callable | Backend (truth) | Client | Winner |
|---|---|---|---|---|
| D16 | `getSignupStatus` | `functions/getSignupStatus.ts:21-33` → `{status; hasPasskey; hasAccount; kycLevel?: 0\|1; kycReason?; personId?}`; not-started answer is `{status:'none',…}` (`:35,74,77`) | web `functions.ts:183-194` ✓; **staff `functions.ts:140-149`** → `{status; kycLevel:number; reason?; account?; kycUrl?}` — renames `kycReason`→`reason`, invents `account`/`kycUrl`, drops `hasPasskey`/`hasAccount`/`personId` | **backend/web** |
| D17 | `getSignupStatus.status` union | `PersonStatus \| 'none'` (`:19`) | staff `functions.ts:87` hardcodes 5 values, **omitting `'none'`** — the value every fresh uid receives | **backend/web** |
| D18 | `getSignupStatus.kycReason` values | `'declined'\|'duplicate_face'\|'face_search_missing'\|'face_search_not_clear'` (`:7-12`) | staff `functions.ts:145` → `'duplicate_face'\|'document_failed'\|'liveness_failed'` — 2 of 3 never emitted | **backend/web** |
| D19 | `reportMessage` | `functions/eventChat.ts:75,90` → `{reported: number}` | web `functions.ts:251` ✓; **staff `functions.ts:184`** → `{ok:true}` | **backend/web** |
| D20 | `pinMessage` request | `functions/pinMessage.ts:114-139` — XOR of `{eventId,text}` / `{eventId,messageId,pinned}`; **`msgId` is never read** | web `functions.ts:167-169,297` ✓; **staff `functions.ts:212`** → `{eventId,msgId,pinned}` — both branches of the XOR are `undefined`, so every call raises `BAD_PIN_TARGET` (`pinMessage.ts:126`) | **backend/web** |
| D21 | `lockDevice` | `functions/device.ts:20,93,108` → `{txHash?; alreadyLocked?: true}` | web `functions.ts:219` ✓; **staff `functions.ts:171`** → `{txHash: Hex}` (reads an absent field when already locked) | **backend/web** |
| D22 | `startDeviceChange` | `functions/device.ts:30-36,238-244` → `{allowedAt; now; cooldownSeconds; allowed; pending?}`; `kycUrl` lives only in the `KYC_REQUIRED` HttpsError **details** (`:202-205`) | web `functions.ts:228-231` ✓ (partial); **staff `functions.ts:172`** → `{allowedAt; kycUrl?}` — invents `kycUrl` in the success body | **backend/web** |
| D23 | `createInvite` | `functions/invites.ts:83,163` → `{inviteId; link}` | web `functions.ts:268-271` ✓; **staff `functions.ts:198-201`** → `{inviteId}` — cannot build the invite link | **backend/web** |
| D24 | `acceptInvite` | `functions/invites.ts:56-67,272` → `InviteCalldata` incl. **`requiredSender`** | web `functions.ts:158-164,276` ✓; **staff `functions.ts:202`** → `{orgId;role;to;data}` — drops the only-the-owner-may-send fact | **backend/web** |
| D25 | `requestAccountDeletion` | `functions/accountDeletion.ts:57-97` reads **no payload**; returns `{scheduledFor; onChainRetained: true}` | web `functions.ts:325-327` ✓; **staff `functions.ts:213`** → request `{reason?}`, response `{ok:true; scheduledFor}` | **backend/web** |
| D26 | `registerIdentity` response | `functions/registerIdentity.ts:31-35` → `{txHash?; alreadyRegistered?; **claimsUpdated: true**}` (always present) | **neither** client types `claimsUpdated` (web `functions.ts:202-205`, staff `:157-160`) | **backend** — both clients drifted |
| D27 | `pinEventMetadata` request | `functions/organizer.ts:97-113,227-229` — `meta` accepts `venue?`, `category?`, `region?` | **web `functions.ts:306-313`** → `{name; description}` only; staff has **no wrapper** | **backend** — web drifted |
| D28 | `startKyc` request | `functions/startKyc.ts:33` accepts `{callbackUrl?}` | web `functions.ts:177` ✓; **staff `functions.ts:139`** → `void` | **backend/web** |
| D29 | `listAttendees` response | `functions/listAttendees.ts:102` → `AttendeeRow[]` with `kycLevel: 0\|1` (`packages/shared/src/types.ts`) | web `functions.ts:254` ✓; **staff `functions.ts:185-188`** inlines the row with `kycLevel: number` | **backend/web** |
| D30 | `listPendingGates` wrapper contract | `functions/pendingGates.ts:185,203-210` → `{gates: PendingGateRow[]}` | web `functions.ts:151,264-265` **unwraps** to `PendingGate[]` (consumed at `organizer/gates/Gates.tsx:99`); staff `functions.ts:194-197` returns the envelope (no call site) | **web** — both are wire-compatible; web's is the one with a caller |
| D31 | Missing wrappers | `revokeInvite` (`invites.ts:285`), `pinEventMetadata` (`organizer.ts:205`) | web has both; **staff has neither** | **web** |
| D32 | Uncovered callables | `listInvites` (`invites.ts:331`), `listPinned` (`pinMessage.ts:183`) | **no wrapper on either branch** | backlog, not a merge blocker |
| D33 | Staff-only named re-exports | — | `staff functions.ts:221,232,233` export `submitPendingGate`, `issueSnapshot`, `getPhotoForGate`; imported at `staff/setup/useGateRegistration.ts:4` and `staff/snapshot/store.ts:22` | **staff (exception)** — taking web's file wholesale deletes three live named imports |

`apps/web/src/shared/api/{auth,deepLink,firebase,sessionHydrator}.ts` are **byte-identical**
between web and staff. `FIREBASE_REGION = 'us-east1'` agrees in all three `constants.ts` and in
`functions/src/config.ts:7` — no region drift.

### A3 · `USED_ABI` / `STRUCT_SHAPES` / events vs the 01b ABI delta

| # | Interface | `mvp-web` | `mvp-staff` | 01b says | Winner |
|---|---|---|---|---|---|
| D34 | `USED_ABI` | `shared/chain/abis.ts:27-50` — Identity 7 entries, Organizers 12, Ticket 20 (incl. `createEvent`, `publishEvent`, `cancelEvent`, `updateEventMeta`) | `shared/chain/abis.ts:27-38` — Identity 3, Organizers 5, Ticket 16 (incl. **`checkIn: 3`**, which web lacks) | — | **union** — each app declares its own call surface. Git auto-merges this **without a conflict marker and produces a duplicate `eventOrg` key** (TS1117). See M4-c |
| D35 | `USED_EVENTS.Ticket` | `abis.ts:74-84` — `CheckedIn: 5`, `EventCreated: 3`, `CheckedInLate: 4` | `abis.ts:58-67` — `CheckedIn: 5`, `CheckedInLate: 4` (no `EventCreated`) | `CheckedInLate(tokenId, gateId, issuedAt, ts)` = 4, topic0 `0xad3c23d7…` (`abi-delta-01b.md:54`) | **union** — both are right about their own subscriptions |
| D36 | `CHECK_IN_FIELDS` (the `checkInOf` tuple) | `shared/chain/reads.ts:188-190` → `['gateId','ts','nonceHash','manual']` | `shared/chain/reads.ts:156-158` → identical | `('gateId','nonceHash','ts','manual','late')` — **same selector `0xdb7b7d7e`, reordered tuple** (`abi-delta-01b.md:93-111`) | **01b** — the one change in the bundle no compiler can catch |
| D37 | `STRUCT_SHAPES` | `reads.ts:223-230` — adds `Organizers.managerOf`, `Identity.activeDevice`; plus `STRUCT_INPUT_SHAPES` at `:219-221` | `reads.ts:168-174` — `Ticket` + `Organizers.gateInfo` only | `Ticket.checkInOf` row moves with `CHECK_IN_FIELDS` or the pin fails (`abi-delta-01b.md:298-301`) | **union**, then apply D36 |
| D38 | `CHECK_IN_ERRORS` / `CHECK_IN_DENY` | — | `staff/types.ts:44-57` — 12 names, **hand-maintained, not derived from the ABI**; mapped at `staff/gate/denyMap.ts:41-53` | The 12 check-in reverts are `NoSuchTicket, WrongEvent, EventCancelled, EventEnded, TicketRevoked, AlreadyCheckedIn, GateNotOpen, GateMismatch, CodeExpired, **NotMember**, DeviceLocked, BadDeviceSignature` (`abi-delta-01b.md:331-334`); `NotMember` is **new on `checkIn`** (`:122`) | **01b** — staff's list has `EventNotPublished` (not a 01b checkIn revert) and is **missing `NotMember`**. Because the list is hand-written, adding the 01b ABI produces **no compile error**: a rotated-away holder gets `UNKNOWN_REVERT` / "알 수 없는 거절" |

Already scaffolded for the redeploy, correctly — no drift, listed so nobody "fixes" them:

- `PENDING_EVENTS` (web `abis.ts:93-97`, staff `abis.ts:77-81`) lists `Ticket: ['CheckedInLate']`;
  `eventTopic()` returns `null` for a pending name so one subscription covers both eras.
- `staff/queue/opQueue.ts:112-119` `hasLateCheckIn()` reads the generated ABI rather than a flag;
  until 01b lands the drain is a dry run that keeps every entry.
- `staff/gate/checkInOp.ts:39` `CheckInFunction` already admits `'checkInLate'`.
- Both branches route every device digest through the switch — web
  `attendee/enter/buildResponse.ts:107,115`, staff `staff/offline/offlineVerify.ts:74,83`. **No
  consumer calls `deviceSigHash` directly.**
- Web `shared/chain/reads.ts:77` names `ROTATION_UNDO_WINDOW_SECONDS = 86_400` once, with a note
  to replace it with a real `ROTATION_UNDO_WINDOW()` read when 01b lands.

### A4 · Indexer entity/field names vs the queries

The suspected `isOpen` drift is real but **inverted**: the clients are correct and the checked-in
schema copies on `mvp-web`/`mvp-staff` are stale.

| # | Field | Indexer | Client | Winner |
|---|---|---|---|---|
| D39 | `Gate.isOpen` | **`MONTI-backend/indexer/schema.graphql:50`** → `isOpen: Boolean!`; written at `indexer/src/EventHandlers.ts:179,198,202,207` | web `shared/envio/queries.ts:59,114` selects `isOpen`, rendered at `organizer/gates/Gates.tsx:211,214`; backend `functions/src/functions/dailyExport.ts:21` selects `isOpen` — **all correct** | — |
| D40 | same, stale copies | **`MONTI-web/indexer/schema.graphql:44`** and **`MONTI-staff/indexer/schema.graphql:44`** say `open: Boolean!` | — | **backend** — `open` is an Envio/ReScript reserved word; `envio codegen` on either copy fails EE210 |
| D41 | `CheckIn.late` | `MONTI-backend/indexer/schema.graphql:125`; selected by `dailyExport.ts:29` | **absent** from the web and staff copies (`CheckIn` block `:104-112`) | **backend** |
| D42 | Schema guard tests | `MONTI-backend/indexer/test/schema.test.ts:28-41` asserts `late: Boolean!` and `isOpen: Boolean!` and `not /^\s+open:/m` | absent from both client copies — the stale schemas **pass their own suite** | **backend** |
| D43 | `EnvioEventStatus` | No contract path emits status code 3: `Ticket.sol` sets Draft/Published/Cancelled only; `Ended` is a derived view | web `shared/envio/queries.ts:15` and staff `:15` declare `'Ended'` as an index value | **indexer** — anything branching on `'Ended'` from the index is dead; compute from `Event.endsAt` |
| D44 | `envioPage` cursor | `MONTI-backend/functions/src/lib/envio.ts:55` pages with `id: {_gt: $cursor}, order_by: {id: asc}` on a **text** PK | — | **backend bug**, not a branch drift: lexicographic ordering on numeric tokenIds can skip or repeat rows in `dailyExport`, `listAttendees`, `snapshot` once ids cross a digit boundary |
| D45 | `Gate` ordering | — | web `shared/envio/queries.ts:113` `order_by: {id: asc}` on a text PK — gate `10` sorts before gate `2` | cosmetic |

`mvp-web` and `mvp-staff` carry **no `config.yaml`, no `EventHandlers.ts`, no `package.json`** under
`indexer/` — they cannot run an indexer. `mvp` and `mvp-01b` have no `indexer/` at all.
Entity names, scalar types (`numeric!`/`String!`) and nullability (`IdentityAccount.nickname`)
agree everywhere; no other drift.

01b adds exactly **two** events — `Ticket.CheckedInLate` and `Identity.RotationCancelled` — both
already reserved in `indexer/scripts/gen-config.mjs:88,48`, and `CheckedInLate` already has a
conditional handler at `EventHandlers.ts:543-561` that self-activates on ABI re-export. **No
existing subscribed event changes signature, so no topic0 moves.**

### A5 · Copy keys shared between attendee and staff

`apps/web/src/shared/copy/{ko,en}.ts` exist on both; `index.ts`, `copy.test.ts` and `i18n.ts` are
byte-identical.

| # | Surface | `mvp-web` | `mvp-staff` | Winner |
|---|---|---|---|---|
| D46 | `shared/copy` key count | 259 keys | 215 keys — 211 shared, **46 web-only**, 2 staff-only, 2 divergent | **web** — staff deleted 14 of 26 `enter.*` keys and 23 of 42 `me.*` keys it does not render |
| D47 | `enter.deviceUnavailable` | `ko.ts:146` "…입장 기능을 쓸 수 없어요. 입구 스태프에게 말씀해 주세요." | `ko.ts:130` "…대는 방식이 안 돼요. QR을 보여주세요." | **web** (staff's QR wording belongs in the staff module) |
| D48 | `me.delete*` | 8-key flow (`ko.ts:187-193`) matching `functions/src/functions/accountDeletion.ts` | 2-key shape `me.deleteConfirm` / `me.deleteDone` (`ko.ts:149`) | **web** |
| D49 | Deny sentences | **none** — `GATE_DENY_CODES` is exported and never consumed anywhere under `MONTI-web/apps`; the attendee keys its own taxonomy at `attendee/enter/useArm.ts:63-82` onto `copy.enter.*` | two competing sets: `staff/gate/denyMap.ts:20-34` (terse) and `staff/copy.ts:124-138` (sentences) | **staff**, but pick **one** of its two sets before the merge |
| D50 | `copy-lint` `IGNORED_DIRS` | `packages/shared/src/copy-lint.ts:16` skips `'organizer'` **and `'staff'`** | skips `'organizer'` only, plus a test pinning the removal (`copy-lint.test.ts:99-115`); root `package.json` lint roots add `apps/web/src/staff` | **staff** — staff copy was run against web's linter and is **clean**, so widening the scope costs nothing |

`BANNED_ATTENDEE_WORDS` is byte-identical on all three branches. The only banned-word hits in the
repo are the two ruled exceptions in `organizer/copy.ts:211,443`, allowlisted at
`organizer/copy.test.ts:26-40`. Widening the lint scope to `staff/` is a standing ruling
(P04:47, restated P04:54 and P04:76).

### A6 · Three carries the ledgers booked for the merge, still open

| # | Item | Current state | Ruling |
|---|---|---|---|
| D51 | `CheckInPush` | declared **locally** on web at `attendee/enter/Result.tsx:76` as `{ tokenId: string; late?: '1' }`, with a shared-marker comment at `:74`; consumed at `:153`. Backend's `tenderlyWebhook.ts` sends the payload with no named type; staff has neither | **P00:42 / P03:141 / P02:168** — becomes a `@monti/shared` type when `mvp-web` and `mvp-backend` meet (**M3**), and the webhook adds `late: "1"` on `CheckedInLate` **post-01b** (so it is also a flip-day item) |
| D52 | `isGateCodeFresh` | **two implementations, different signatures**: web `attendee/enter/verifyGate.ts:72` takes a full `GateCodeWire`; staff `staff/gate/gateCode.ts:79` takes `Pick<GateCodeWire,'issuedAt'>`. Different paths, so **no merge conflict** — both survive silently | **P04:48 / P04:52** — "at merge: hoist `isGateCodeFresh` into `@monti/shared`". Two freshness windows is how one side drifts off the chain's 60 s |
| D53 | `subscribeLogs` `blockNumber` | `shared/chain/subscribeLogs.ts` is **byte-identical** on web and staff; `:62` casts the raw `monadLogs` object to viem's `Log`, so `blockNumber` is **typed `bigint` but arrives as a hex string** | **P04:62 / P04:64** — "upstream fix at merge (web Task 8)" with a formatter. Identical file on both branches, so it is a post-merge fix, not a conflict |

---

## Part B — the ordered merge checklist

Order: `mvp-01b → mvp → mvp-backend → mvp-web → mvp-staff → mvp`.

Every step below was **executed as a dry run** in a throwaway clone; the conflict lists are
observed, not predicted. **15 conflicted files in total, 13 of them in one step.**

### M1 · `mvp-01b → mvp` — 0 conflicts

`mvp-01b` is a strict descendant of `mvp`, so this is a fast-forward. Nothing to resolve.

> Do not run this until 01b's own Task 15 has redeployed and re-seeded. Merging the bundle into
> `mvp` is what makes the flip-day list (Part C) mandatory rather than optional.

### M2 · `mvp → mvp-backend` — 0 conflicts

Consumers never touched `contracts/` or `docs/`, and `packages/shared/src/abi/*.json` is
identical on both sides, so the new ABI arrives as a clean fast-forward of those five files.

**Post-merge, not a conflict:** `contracts/deployments/seed-10143.json` becomes the seeded
version; run `pnpm --filter @monti/shared sync:deployments` to propagate it into
`packages/shared/src/deployments/`, which the merge does **not** do (D15).

### M3 · `mvp-backend → mvp-web` — 2 conflicts

```
UU package.json
UU pnpm-lock.yaml
```

| File | Conflict | Resolution |
|---|---|---|
| `package.json` | one-line JSON; backend added `"indexer:config"`, web added `"engines": {"node":"22.x"}` | **union** — keep both, plus the shared `lint:copy` line they already agree on |
| `pnpm-lock.yaml` | 3 hunks | do not hand-merge: take either side, then `pnpm install` and commit the regenerated lock |

**Auto-merges correctly — verify, do not assume:**

- `packages/shared/src/types.ts` merges clean and is **right**: web's v2 wire + DENY codes plus
  backend's `PersonStatus` `'deleted'`. Confirm `'deleted'` survived and `GATE_RESPONSE_VERSION`
  is still `2`.
- `packages/shared/src/encoding.ts` resolves to **web's** 395-line version (backend's is a
  subset). Confirm `deviceDigest` and the v2 family are present.
- `functions/**` and `indexer/**` are pure backend additions — web never touched them after the
  `23cc031` fork.

### M4 · `mvp-web → mvp-staff` — 13 conflicts

This is the whole of the risk. Observed at `mvp-staff = f4ab1dd` and again at `c3988ab` — the
same 13 files both times.

```
UU apps/web/src/shared/api/functions.ts          (2 hunks)
UU apps/web/src/shared/chain/abis.test.ts        (1)
UU apps/web/src/shared/chain/abis.ts             (2)
UU apps/web/src/shared/chain/reads.test.ts       (1)
UU apps/web/src/shared/chain/reads.ts            (2)
UU apps/web/src/shared/chain/sendSponsoredOp.test.ts (1)
UU apps/web/src/shared/chain/sendSponsoredOp.ts  (1)
UU packages/shared/src/constants.ts              (1)
UU packages/shared/src/encoding.hash.test.ts     (2)
UU packages/shared/src/encoding.response.test.ts (4)
UU packages/shared/src/types.test.ts             (2)
UU packages/shared/src/types.ts                  (4)
UU pnpm-lock.yaml                                (3)
```

**M4-a · `packages/shared/src/types.ts` (4 hunks).** Two are prose. The two that matter:
take **staff's** `UNKNOWN_REVERT` (`:105`) and its rationale paragraph (`:97-101`), and **web's**
wording for the `GATE_RESPONSE_VERSION` and `GateResponseWire` doc comments. Result: 13 codes.
Then **M4-a′**: update `packages/shared/src/types.test.ts:105-111` to list 13, or web's
`toEqual` freeze goes red (D6). Do not resolve this one by taking a side.

**M4-b · `packages/shared/src/constants.ts` (1 hunk).** Take **web's** — it adds `P256_ORDER` /
`P256_HALF_ORDER` (`:43-44`), which staff lacks. Then **delete** staff's local duplicate
`P256_N`/`P256_HALF_N` at `apps/web/src/shared/deviceKey/native.ts:11-12` and point `toLowS` at
the shared constants. Git auto-merges `native.ts` to web's version without a marker — **verify it
did**, because a silent revert to staff's copy leaves two half-orders in the tree (D8).

**M4-c · `apps/web/src/shared/chain/abis.ts` (2 hunks).** Both hunks are prose; the dangerous
part is what git merges **without** a marker. `USED_ABI` auto-merges into a union that contains
**`eventOrg: 1` twice** (once from staff's Ticket line, once from web's event-lifecycle block) —
TS1117. Resolve to the deduplicated union: web's full Identity/Organizers maps, and a Ticket map
that keeps web's lifecycle entries **and** staff's `checkIn: 3`. Same for `USED_EVENTS.Ticket`:
keep `CheckedIn`, `EventCreated` **and** `CheckedInLate`.

**M4-d · `apps/web/src/shared/chain/reads.ts` (2 hunks).** Both are comments. Take web's prose;
keep web's larger `STRUCT_SHAPES` (`:223-230`) and `STRUCT_INPUT_SHAPES` (`:219-221`) — staff's
is a subset. `CHECK_IN_FIELDS` is identical on both sides and stays on the pre-01b order until
flip day (F3).

**M4-e · `apps/web/src/shared/chain/sendSponsoredOp.ts` (1 hunk).** A real signature drift:
staff added a `gasFloors` argument, web added an exported `readOpLogs` helper. **Union** —
`export function readOpLogs(...)` **and**
`sendSponsoredOp({ account, calls, orgId, gasFloors })`.

**This is the single most expensive hunk to resolve carelessly.** `gasFloors` is not a staff
convenience: P00:43 books it as a **cross-plan carry** — "sendSponsoredOp under-estimates
`verificationGasLimit` for WebAuthn accounts (viem's stub short-circuits ~10.3 k low) →
post-deploy UserOps can revert **AA23 for attendees too**; the fix
(`max(estimate × 1.075, 150_000n)`) lands in 04 T21 and **reaches mvp-web at merge**." Taking
web's side here re-breaks the attendee flow on the *second* op of every passkey account
(P04:42, P04:43, P04:56), and reverts the staff gate to guessed gas
(`staff/gate/checkInOp.ts:45`).

**M4-f · `apps/web/src/shared/api/functions.ts` (2 hunks).** Take **web's file wholesale** —
per the backend-owns-callables ruling it is correct on all twelve disagreements (D16–D30) —
then **re-append staff's three named re-exports** (`submitPendingGate`, `issueSnapshot`,
`getPhotoForGate`, staff `:221,232,233`). Without them, `staff/setup/useGateRegistration.ts:4`
and `staff/snapshot/store.ts:22` stop compiling (D33). Keep staff's `PendingGateSubmission`
interface name if you want `useGateRegistration.ts:4`'s type import to survive untouched;
its four fields match web's inline shape exactly.

**M4-g · the four test files.** `abis.test.ts` (import line: take web's
`{ STRUCT_INPUT_SHAPES, STRUCT_SHAPES }`), `reads.test.ts`, `sendSponsoredOp.test.ts`,
`encoding.hash.test.ts`, `encoding.response.test.ts`, `types.test.ts` — all follow whatever the
source resolution above chose. `encoding.hash.test.ts` is prose-only apart from line numbers;
the three pinned vectors are identical on both branches.

**M4-h · `pnpm-lock.yaml`.** Regenerate; do not hand-merge.

**Does not conflict, and should:** nothing. `packages/shared/src/encoding.ts` is byte-identical
on the two branches, which is why the merge is survivable at all.

**Before committing M4, decide two things the merge cannot decide:**

1. Which of staff's two deny-label sets survives — `gate/denyMap.ts:20-34` or
   `staff/copy.ts:124-138` (D49). Both currently reach a screen.
2. Whether `indexer/` is deleted from the merged branch or synced from `mvp-backend`
   (D40–D42). The web/staff copies are stale and unrunnable; deleting them is the honest fix.

### M5 · `mvp-staff → mvp` — 0 conflicts

After M4, `mvp`, `mvp-backend` and `mvp-web` are all ancestors of `mvp-staff`
(verified with `git merge-base --is-ancestor`), so this is a fast-forward.

### After the merge

- `pnpm install` (the lock was regenerated twice).
- `pnpm --filter @monti/shared sync:deployments` (D15).
- `pnpm --filter @monti/shared build` **before** any `tsc`/vitest run — `packages/shared/dist`
  is gitignored (P03:146, P03:31). Node 22 (`fnm exec --using=22 …`); two `<Navigate>` tests
  fail on Node 24.
- `pnpm lint:copy` with the widened roots (D50).
- Hoist the three booked carries: `CheckInPush` (D51), `isGateCodeFresh` (D52), and the
  `subscribeLogs` hex→bigint formatter (D53).
- `apps/web/.env.local` is gitignored and exists per worktree — the merged tree needs one or 14
  web tests go red on `VITE_RPC_URLS` (P04:29, P04:30).
- Full suite: `pnpm vitest run`, `pnpm --filter monti-indexer test`, and
  `cd plugins/hce-android/android && ./gradlew test`.

---

## Part C — the 01b flip-day list

Everything here must land **in one commit per branch**, on the day 01b's Task 15 redeploys and
re-seeds. None of it fails a build if forgotten; all of it fails at the door.

| # | Item | Files | Why it is silent |
|---|---|---|---|
| **F1** | `DEVICE_DIGEST_FORM` → `'v2-domainSeparated'` | `packages/shared/src/constants.ts:59` (web) / `:51` (staff) | One line moves signing, local verification and QR together. Forgotten, **every** check-in reverts `BadDeviceSignature` |
| **F2** | Re-pin the digest-form guards | `packages/shared/src/encoding.hash.test.ts:145` (web) / `:141` (staff); `apps/web/src/staff/offline/offlineVerify.test.ts:91` | Three tests assert `DEVICE_DIGEST_FORM === 'v1-fiveField'` on purpose; they go red the moment F1 lands, which is the intended alarm |
| **F3** | `checkInOf` tuple → `['gateId','nonceHash','ts','manual','late']`, and `CheckInStruct` gains `late: boolean` | `apps/web/src/shared/chain/reads.ts:188-190` (web) / `:156-158` (staff); `STRUCT_SHAPES` at `:223-230` / `:168-174` | **Same selector `0xdb7b7d7e`.** viem decodes positionally: without this, `ts` is read out of `nonceHash`'s slot. `abis.test.ts`'s `STRUCT_SHAPES` pin is the only thing that catches it |
| **F4** | Regenerate `packages/shared/src/abi/*.json` from the redeployed contracts | `Ticket.json` 105→116, `Identity.json` 41→47, `MontiPaymaster.json` 42→45 | Copy from `mvp-01b`; no consumer has ever hand-edited these |
| **F5** | Extend `abi.test.ts` | `packages/shared/src/abi.test.ts:61-66` etc. | It asserts with `arrayContaining`, so a **missing** name is invisible. Add Ticket `checkInLate`, `offerDigest`, `eip712Domain`, `deviceDigest`, `LATE_WINDOW`, `MIGRATE_DELAY`; event `CheckedInLate`; Identity `cancelRotation`, `rotatedAt`, `rotatedFrom`, `ROTATION_UNDO_WINDOW`; event `RotationCancelled`; Paymaster `setAllowed`, `argWordOf`; event `SelectorAllowed` |
| **F6** | `offerDigest` → EIP-712 | `packages/shared/src/encoding.ts:144-158` on **all three** branches; vector `encoding.hash.test.ts:197` (web) / `:186` (staff) / `:92` (backend); caller `functions/src/functions/transferInvites.ts:279`; test `functions/test/transferInvites.test.ts:386,405` | The body is given verbatim at `abi-delta-01b.md:171-216`. **Delete** the old vector `0x90244cd7…ed0a`, assert `0x7171ab38…bc88d`. The signing primitives (`lib/attester.ts` `signKeccak`, `getAttesterAccount().sign`) take a 32-byte digest and need no change. Forgotten, the attester signs the dead digest and **every `acceptOffer` reverts `BadAttesterSig` with a green build** |
| **F7** | `CheckedInLate` subscription on | remove `'CheckedInLate'` from `PENDING_EVENTS.Ticket` — `abis.ts:93-97` (web) / `:77-81` (staff) | `eventTopic()` currently returns `null` for it; `abis.test.ts` asserts it is still absent, so the test fails the day the ABI lands. Arity is **4** (`tokenId, gateId, issuedAt, ts`) — no `eventId`, no `nonceHash`, so it can never name a tap |
| **F8** | `checkInLate` op | add `checkInLate: 3` to `USED_ABI.Ticket` and delete the cast at `staff/queue/opQueue.ts:87-92` | `hasLateCheckIn()` (`opQueue.ts:112-119`) reads the ABI, so the drain switches from dry run to real sends by itself. Gas from the measured numbers: `checkIn` **123 800**, `checkInLate` **132 607**, 200 000 call budget (`staff/gate/checkInOp.ts:45`) |
| **F9** | `NotMember` in the deny map | `apps/web/src/staff/types.ts:44-57` (`CHECK_IN_ERRORS`) and `staff/gate/denyMap.ts:41-53` (`CHECK_IN_DENY`) + a label | 01b makes `NotMember()` a live `checkIn` revert (`abi-delta-01b.md:122`) — a rotation pushes the old account out. The list is **hand-written, not derived from the ABI**, so nothing fails to compile; a rotated-away holder just gets "알 수 없는 거절" |
| **F10** | New revert wording on the attendee side | `RotationPending` and the now-bidirectional `DeviceLocked` (fires on **accepting** an offer) | `abi-delta-01b.md:124-127,313-315` |
| **F11** | Rotation views become real reads | delete `ROTATION_UNDO_WINDOW_SECONDS` at `shared/chain/reads.ts:77`; add `rotatedAt`, `rotatedFrom`, `ROTATION_UNDO_WINDOW` to `USED_ABI.Identity` and `readIdentity()`; screen at `attendee/me/NewDevice.tsx:62-63` | Web already hardcodes 86 400 with a note. Also show the 24 h quarantine and the `deviceUpdatedAt + 7 days` unlock (`abi-delta-01b.md:134-140`) |
| **F12** | `LATE_WINDOW_SECONDS = 43_200`, `MIGRATE_DELAY_SECONDS = 86_400` | `packages/shared/src/constants.ts`, under `CODE_WINDOW_SECONDS` | Absent on all three branches today |
| **F13** | Indexer restart | `contracts/deployments/10143.json` (4 addresses + `block`, currently `64385989`) → re-export ABIs → `pnpm indexer:config` → rewrites `indexer/config.yaml:53-63` | The key is `block`, **not** `startBlock` (P01b:14). `gen-config.mjs:138-144` **hard-fails** on an unclassified new event — the intended guard. `CheckedInLate` and `RotationCancelled` are already reserved at `gen-config.mjs:88,48`, and `EventHandlers.ts:543-561` self-activates. Envio must be **reindexed from the new start block**, not resumed — and the block-pinned `readContract` calls added in `2a87069` need an **archive RPC**: probe `eth_call` at the new start block before deploying (P02:182, P02:184). The public Monad testnet RPC serves only ~23 days of historical state (P02:186) |
| **F13b** | Indexer gate filter | add `revoked: false` to any query that finds a gate **by address** | 01b's `revokeGate` clears `gateOf(account)`, so one address can hold more than one `Gate` row (P02:172; `abi-delta-01b.md:132`). `GATES_QUERY` filters by `eventId` and is unaffected |
| **F14** | Tenderly alerts | the on-chain alert filter is configured off-repo; the webhook's own address filter reads `deployment()` at `functions/src/functions/tenderlyWebhook.ts:286-290` | Updating `deployments/10143.json` fixes the **webhook**; the **9 alerts** must be recreated by the founder against the new addresses, and `TENDERLY_WEBHOOK_SECRET` v1 set afterwards (P02:145). Until then the alert points at dead contracts and simply goes quiet |
| **F15** | Env addresses | `apps/web/.env.local` / `.env.example` — `VITE_ADDR_IDENTITY`, `VITE_ADDR_ORGANIZERS`, `VITE_ADDR_TICKET`, `VITE_ADDR_PAYMASTER` (`:5-8` on both web and staff); backend `functions/.env` `CHAIN_ID`, `RPC_URL`, `ENVIO_GRAPHQL_URL` | Four addresses × three branches × two files |
| **F16** | Re-seed artefacts | `contracts/deployments/seed-10143.json`, then `pnpm --filter @monti/shared sync:deployments` | Gate registration is **once per account**: re-seeding needs the real staff device account and its real P-256 key (`SEED_GATE_KX`/`SEED_GATE_KY`) — `abi-delta-01b.md:348-350` |
| **F17** | Paymaster selector table | six new seeded selectors: `Ticket.checkInLate` (TokenId), `Ticket.revoke` (TokenId), `Organizers.revokeGate` (Platform), `Organizers.createOrganizer` (Platform), `Organizers.transferOwner` (OrgId), `Identity.cancelRotation` (Platform) | `abi-delta-01b.md:76-86`. `cancelRotation` must be sponsored or the undo cannot run from a zero-balance account — the whole point of C3 |
| **F18** | Parity check against the chain | pin one vector against the deployed `Ticket.deviceDigest(...)` view | `abi-delta-01b.md:256-259`: the two inputs a client cannot choose (`chainid`, the Ticket address) are exactly the ones a local re-implementation gets wrong. A hand-rolled sha256 passes every local test and fails at the door |
| **F19** | `CheckInPush.late` | the webhook starts sending `late: "1"` on `CheckedInLate` | P00:42 / P02:168. Pairs with D51 — the type must already be in `@monti/shared` by then |
| **F20** | Unsponsored notices come down | `createOrganizer`, `transferOwner`, `revokeGate`, `Ticket.revoke` become sponsored (F17) — remove the `<UnsponsoredNotice/>` gating | P03:94, P03:149. Until 01b these actions need the organiser to hold MON |
| **F21** | Rotation follow-ups (03 T27b) | migrate / `cancelRotation` buttons + the chain-read rotation views + `me.migrateCta` | P03:128, P03:132 — explicitly deferred to "after the 01b merge". `Ticket.migrate` is **sent by the new account** after `MIGRATE_DELAY`; nothing moves by itself |

Every signature made against the current deployment dies with it — attester signatures for
`acceptOffer`, device signatures for `checkIn`/`checkInLate`, and the gate registrations. There
is no production caller today; Task 15 is where that stops being true.

---

## The three most dangerous drifts

1. **`offerDigest` is still the raw-keccak pre-redeploy shape on all three branches** (D13, F6)
   — and the backend *signs with it* at `functions/src/functions/transferInvites.ts:279`. 01b
   replaces it with EIP-712. Nothing about this fails to compile: the attester signs the dead
   digest and every `acceptOffer` reverts `BadAttesterSig` against a green build.
2. **The `checkInOf` tuple reorders under an unchanged selector** (D36, F3). viem and Envio
   decode positionally, Solidity decodes by name, so only the `STRUCT_SHAPES` pin stands between
   the gate and reading `ts` out of `nonceHash`'s slot — on the read that decides whether a
   ticket has already been used.
3. **`NotMember` has no deny code** (D38, F9). 01b makes it a live `checkIn` revert, but
   `CHECK_IN_ERRORS` is a hand-written list, not derived from the ABI — so the new ABI lands
   without a single compile error and a rotated-away holder is refused at the door with "알 수
   없는 거절".

Two near-misses that are only one careless resolution away from joining them:

- Resolving `packages/shared/src/types.ts` in web's favour — as "web owns `packages/shared`"
  literally reads — deletes `UNKNOWN_REVERT` and breaks four staff modules. The ledger already
  ruled the other way: **13 codes on both branches** (D5, P04:58).
- Resolving `sendSponsoredOp.ts` in web's favour drops `gasFloors`, which P00:43 books as the
  fix for **attendee** AA23 reverts as well as the staff gate's gas budget (M4-e). The conflict
  is visible; the consequence of picking a side is not.
