# Conditional Family Discount Design

Status: local implementation in progress. Nothing in this document has been
applied remotely. The local candidate uses the same quote/fence finalizer for
new same-submission siblings, a verified same-guardian pending draft,
staff-confirmed family membership, and one canonical child in distinct classes.
Historical rows require an explicit dry-run and audited adoption operation;
rows with used, transferred, reserved, or refunded residual value remain in
`reconciliation_review` rather than being silently reinterpreted.

## Scope

This design changes when the configured `family_multi_child` discount becomes
earned. It does not merge child identities, merge guardian accounts, expand
parent access, change referral ownership, pool sibling credit, or introduce a
refund or withdrawal formula.

Family relationship evidence stays within the released sources:

- same guardian and same academic year;
- staff-confirmed `family_group` membership and same academic year; or
- one canonical child in distinct class sessions in the same academic year.

The same child in the same class does not count twice. A relationship alone
does not create an award; it only permits a qualifying set to be evaluated.
Every percentage continues to use the agreement's frozen selected-plan total,
the stored rate snapshot, existing rounding, and compatible stacking rules.

## Released Baseline and Implemented First Slice

The released baseline was not conditional:

1. A public submission containing two or more selected children creates active
   `family_multi_child` awards at submission time. The registration regression
   asserts this before any cash payment or canonical promotion.
2. Canceling a three-child submission down to two or one leaves those active
   awards untouched. The same regression deliberately asserts no automatic
   recalculation.
3. Same-guardian and explicit-family awards generated after canonical
   promotion use current confirmed same-year enrollment occurrences. The
   predicate requires two distinct students or one student in two distinct
   class sessions; deterministic award IDs prevent duplicate award rows.
4. Ordinary active awards are projected proportionally across unpaid
   installments. The released additional-class finalizer alone applies its
   promised award to the final installment first.
5. Raw installments, receipts, and payment allocations are immutable. Award
   balance recalculation can identify residual value, but the submission-time
   award path can leave an automatic fully-paid award without the linked
   durable child-credit root used by later family/additional recovery paths.
6. Ordinary promotion recognizes paid effective installments or the existing
   staff partial-seat approval. It does not recognize a provisional family
   quote. Reminders use active awards and a child's own credit review; they do
   not model an unresolved family condition.
7. The additional-class admission already provides the relevant coordination
   pattern: durable claim ID, expiry, monotonically increasing fence, guarded
   writes, idempotent reservations, a protected finalizer, and audit/recovery.

The local first slice changes only new submissions with two or more selected
children in the same draft. It records one frozen conditional quote per
agreement instead of immediately creating `family_multi_child` awards. The
shared effective-installment projection displays the conditional amount but
does not create ledger value. A protected funded-subset finalizer later earns
the awards. One funded child can receive a quote/revision/reason-bound
conditional seat approval; ordinary promotion remains blocked while its quote
is pending. The approval creates separate capability-free parent and internal
conditional-seat Outbox events rather than a misleading final-settlement
event. Each has a deterministic identity and the internal event can recover
after a parent event has already sent.

The local candidate does not change any unqualified single-child registration,
ordinary payment recording, staff credit operation, transfer, cancellation, or
additional-class settlement. The established additional-class credit
reservation/finalizer remains its own lifecycle. Conditional quotes only alter
the financial path of an agreement with current qualifying relationship
evidence. A failure still requires a revision-bound staff replacement deadline;
until then, the existing reminder milestone remains pending and cannot turn the
old raw amount into an overdue message.

## Precise Proposed Qualification and Funding Predicate

### Definitions

For one academic year and one relationship basis, a **resolution subset** is a
selected set of two or more distinct agreement occurrences. An occurrence is
`canonical_student_id + class_session_id`; a same-child/same-class duplicate is
one occurrence. The finalizer may choose a funded subset of a larger submitted
family. It must never include an unresolved sibling merely because it belongs
to the same draft.

Each member is one of the following:

| Member kind | Counts as a qualifier? | Required evidence |
| --- | --- | --- |
| Existing valid qualifier | Yes | Current canonical enrollment, current class/academic year/relationship, and either ordinary full-price coverage or a previously earned family award. A conditional seat status alone is insufficient. |
| Pending one-payment candidate | Yes, only in the claimed subset | Actual recorded cash + already-applied earned credit + specifically authorized contingent inbound credit is at least raw total minus its own provisional award. |
| Pending two-installment candidate | Yes, only in the claimed subset | Actual first-installment cash is at least the raw first installment. No future annual balance is required; no new credit application may satisfy this first cash installment. |
| Conditionally confirmed seat | Not on status alone | It must independently meet the relevant pending funding predicate above. |
| Cancelled, expired, released, superseded, wrong-year, or same-class duplicate | No | It is excluded before a claim is taken. |

For a one-payment agreement with raw total `R`, provisional own award `A`,
actual cash `C`, already-applied earned credit `E`, and a teacher-authorized
contingent incoming donor amount `T`, the pending funding predicate is:

```text
C + E + T >= R - A
```

`T` exists only as a non-spendable, quote-bound reservation from an existing
valid donor whose new residual award will be earned in the same finalizer. It
is not a payment, child-credit root, or general available balance. Its source,
recipient, exact installment, amount, quote revision, and teacher reason are
all fixed before the finalizer claims the subset.

For a two-installment agreement, the predicate is instead:

```text
actual first-installment cash >= frozen raw first installment
```

The newly earned family award applies to the final installment first. The
first installment remains cash-only. Existing historical credit applications
are preserved and do not prove eligibility for a new conditional operation.

### Protected subset finalization

1. Read the current relationship graph, agreement snapshots, class/enrollment
   state, qualifying evidence, cash allocations, applied credit, reservations,
   and quote revisions.
2. Select only currently eligible, funded pending candidates plus zero or more
   existing valid qualifiers. Require at least two distinct occurrences.
3. Claim every pending quote in the selected subset, in stable ID order, only
   when it remains `quoted_pending` and unclaimed/expired. Each claim increments
   that quote's fence. If every claim is not acquired, release only the claims
   obtained by this operation and retry from a fresh read. No effect is written.
4. Re-read the entire subset under the claims. Recheck each predicate,
   relationship, academic year, source donor/recipient, reservation, hold,
   cancellation, and fence.
5. Create/reuse one deterministic **provisional** award per claimed agreement.
   For a contingent settlement, materialize the donor's reserved root in a
   separate durable phase; it is not generally spendable while provisional.
6. In one independently fenced financial batch, consume the reserved donor
   value only into its specified eligible application. Every statement in that
   batch repeats the quote claim/fence, root-reservation, and target-installment
   predicates; it cannot proceed merely because a preceding guard wrote zero
   rows. Refresh installment state and promote only agreements whose own
   guarded settlement rule is met.
7. Mark only the claimed quotes resolved. A remaining unfunded sibling stays
   `quoted_pending`, has no award/root, and may later form a different subset
   with an earned member as its existing valid qualifier.

The local same-submission finalizer claims a funded subset in stable order and
uses deterministic award IDs. Cancellation refuses to race an unexpired quote
claim, then cancels only the pending quote for its child. With fewer than two
remaining unresolved members, it marks the surviving quote
`qualification_failed` without inventing a payment deadline.

Every future cross-basis write must carry the quote ID, claim ID, current fence, quote revision, and
current validity predicate. Thus competing subsets `A+B` and `B+C` cannot both
win: both need B's claim. Non-overlapping subsets may proceed independently.
Deterministic award IDs, one root per `source_discount_award_id`, one payment
allocation per receipt, and payload-bound operation fingerprints prevent a
receipt, award, or credit unit from being counted twice.

### Implemented durable boundaries and recovery

The local implementation deliberately has recoverable boundaries; it does not
claim an all-or-nothing database transaction across receipt recording, award
creation, enrollment promotion, and Outbox work.

| Durable phase | Writes that survive it | Owner and recovery entry point | What prevents misuse or duplication |
| --- | --- | --- | --- |
| Quote claim | Quote `claim_id`, expiry, and incremented `claim_fence` | The scheduler's `recoverFundedConditionalFamilyQuotes` reclaims only expired claims | Every later quote/award/financial write checks the claimed ID and fence; a live claim blocks conflicting cancellation. |
| Provisional award | Deterministic award row and `linked_discount_award_id` | Same claimed finalizer; retry finds the deterministic award | `qualification_state='provisional'` excludes its residual root from all normal credit projections, payment review, transfer, and application paths. |
| Donor reservation | Deterministic donor root plus its reserved amount | Same finalizer; cancellation invalidates the quote and releases an unspent reservation | The root belongs to the provisional award and is hidden from general credit. A target operation can use it only through the exact donor/recipient quote, installment, amount, and operation ID. |
| Protected financial settlement | One `child_credit_operation`, donor debit, recipient transfer entry, recipient application, reservation release, and audit event | Idempotent finalizer replay finds the operation by its payload-bound ID | The batch is rollback-tested on an injected application failure. Each statement repeats the same claim/fence, root, and installment predicate, so a stale or invalid claim cannot leave a downstream write. |
| Qualification resolution | Award becomes `earned`; quote becomes `qualified` | Scheduler sees a released/expired retryable quote and resumes | The finalizer verifies every claimed quote resolved before calculating residual roots. A committed financial operation has no intermediate recipient credit. |
| Promotion and notices | Canonical enrollment and ordinary final enrollment notices | Existing stranded-promotion and Outbox recovery | Qualified quotes may be promoted only by the guarded normal promotion path. Before that, staff sees qualified/recovery state rather than a fabricated final notice. |

The original local defect was specific to one SQL shape, not a blanket claim
about D1: an earlier D1 batch inserted an award/root and then used later
statements that selected those freshly inserted rows as prerequisites. In the
real local Worker/D1 run, the award/root materialized but the dependent
transfer/application statements selected no row, leaving a retryable partial
intermediate. The repair materializes the root in an earlier phase, then makes
every statement in the financial batch depend only on already-materialized
quote/root/installment rows and the same current fence. A post-batch ledger
check rejects a zero-row settlement rather than treating it as complete.

### Required examples and assertion table

All values are MNT and use a 10% configured rate. `Requested now` is the
truthful current request, not an assertion that a conditional amount is paid.

| Step | Cash | Earned / provisional award | Credit ownership or application | Requested now | Shortfall if condition fails | Seat state |
| --- | ---: | --- | --- | ---: | ---: | --- |
| Two pending one-payment A | 1,080,000 | 0 / 120,000 | none | 0 conditional | 120,000 | hold; not automatic promotion |
| Two pending one-payment B | 1,080,000 | 0 / 120,000 | none | 0 conditional | 120,000 | hold; not automatic promotion |
| A+B protected finalizer | same receipts | 120,000 earned each | each excess/root only if its own receipt exceeds earned obligation | 0 | 0 | each may promote through its guarded settlement |
| Sequential source | 1,200,000 | 120,000 earned when the target subset qualifies | source owns a 120,000 residual root | 0 | 0 | ordinarily confirmed |
| Sequential target | 960,000 | 120,000 earned / 0 provisional | exactly 120,000 source credit is created and immediately applied to this target | 0 | 0 | promoted only by the protected finalizer |
| Two-installment agreement | 650,000 first cash | 130,000 earned / 0 provisional after qualification | no first-payment credit; final installment becomes 520,000 | 520,000 later | 130,000 if qualification later fails before earned | normal initial seat lifecycle |
| Three-child A/B funded, C pending | A/B as above | A/B earned; C 0 / its own provisional amount | no C root or application | C's conditional request remains its own | C's own amount | C remains pending |
| One child remains after sibling cancellation | 1,080,000 | 0 / 0 after failure | no new credit | 120,000 after staff review sets a due date | 120,000 | existing conditional approval remains visible for review |

Two staff-approved seats do not qualify solely because their status is
confirmed. They appear in the subset only when their independent funding
predicate is true. Conversely, two pending one-payment agreements paid at
`1,080,000 + 1,080,000` satisfy their predicates simultaneously, so their
protected subset can earn the two awards without a full-price receipt.

## Communication and Reminders

Seat communication and financial-settlement communication are separate events.

- An explicit conditional seat approval sends a parent and permitted internal
  notice that the seat is confirmed **subject to an unresolved family-discount
  condition**. It includes the current conditional amount, the condition in
  plain language, and the fact that the final payable amount can change if the
  condition fails. It does not say the agreement is fully settled.
- The existing teacher/admin internal event must remain visible and retryable;
  a conditional approval must not disappear merely because an enrollment exists.
  Use a separate structured event key/template from final enrollment settlement
  confirmation. It contains no access capability beyond existing safe policy.
- The ordinary final enrollment/settlement message is emitted only when the
  protected finalizer has committed earned awards and the agreement's actual
  settlement predicate is complete.
- While the same-submission quote is pending, the effective-installment
  projection is the amount requested by the existing reminder scheduler. The
  raw conditional difference is therefore not separately overdue. The scheduler
  recalculates effective installments immediately before delivery.
- When that quote definitively fails, its original milestone stays pending. A
  payment-capable staff member must record a new deadline and reason against the
  displayed quote revision before the existing reminder and overdue milestones
  are rescheduled. No arbitrary deadline is created at quote creation or
  failure, and no catch-up event is fabricated.

Parent-facing payment instructions, prepared staff messages, export, staff
balances, and reminders must consume the same conditional-settlement projection.
They must show raw obligation, earned reduction, provisional reduction, actual
cash, applied credit, current request, and failure shortfall as separate values.

## Existing-Record Adoption: Exact Proposed Transition

No grandfathering means old submission-time awards eventually receive the same
qualification outcome as new agreements. Receipts and payment evidence never
change. The cutover must retain the historical award row but prevent an
unverified old award from being treated as an earned reduction.

### Three-child disposable example

For a disposable historical submission with three `1,200,000` MNT agreements
and existing active 120,000 MNT submission-time awards:

| Existing evidence at adoption | Proposed adoption state | Display / settlement effect | Safe next step |
| --- | --- | --- | --- |
| No payment | Quote `quoted_pending`; historical award effect is provisional | Request 1,080,000 conditionally | A funded two-child subset can qualify; an unfunded sibling stays pending |
| Partial payment | Quote `quoted_pending` | Preserve cash; request only the remaining conditional amount | No automatic seat promotion until ordinary coverage, protected qualification, or existing authorized partial approval |
| Exactly 1,080,000 received | `cash_coverage_ready` | Preserve conditional 1,080,000 quote; actual failure balance is 120,000 | Protected qualification may earn it; staff may use the existing partial-seat approval path with a quote reference and reason |
| Qualification succeeds | `qualified` | Existing historical award becomes earned financial effect; root materializes idempotently only for residual value | Continue normal settlement/promotion/communication gates |
| Qualification fails | `qualification_failed` | Award no longer reduces the actual obligation; receipt remains 1,080,000 and review shows 120,000 | Staff sets a due date before overdue escalation; no refund/reversal is invented |
| Award value already reserved, transferred, or applied | `reconciliation_review` | Do not relabel or undo ledger lineage automatically | Staff uses a future reviewed reconciliation action |

The migration must mark historical `same_registration_guardian_multiple_children`
awards with an explicit financial-effect/qualification state linked to a quote.
The award's original amount, reason, rate, timestamp, and audit history remain
immutable. New effective-obligation projection uses only `earned` effect state;
the conditional projection supplies the preserved quote. This is necessary to
avoid an "active" historical row silently settling a bill before qualification.

### Implemented local adoption boundary

Migration `0052_conditional_family_discount_quotes.sql` is additive. Before a
staff adoption operation, a historical award retains its released
`qualification_state = 'earned'` effect and the old Worker continues to read it
normally. The new Worker preserves that same ordinary financial projection;
its adoption-specific classification is available only through a non-mutating
preview. Neither runtime creates a quote, sends a message, reschedules a
reminder, or alters a receipt merely because the migration was applied.

The preview returns a SHA-256 review fingerprint over the award, relationship,
cash, applied-credit, and credit-lineage snapshot. Adoption requires that exact
fingerprint, an authorized staff reason, and one operation UUID. The operation
creates a deterministic quote marker before linking the award, so an
interruption is resumable without a dangling foreign key or duplicate value.
Replaying the same UUID recovers any missing deterministic quote/root and
returns the original result; a changed reviewed state requires a new preview.

Classification is deliberately narrow:

- Two currently funded members of the released same-submission group become
  `earned`; an already fully paid agreement recovers only its missing residual
  child-credit root.
- A valid group with fewer than two funded members remains `provisional` and
  retains its conditional quote.
- A group reduced to one active member becomes `qualification_failed`; its
  immutable receipts remain, and staff must set the existing review deadline
  before ordinary overdue scheduling resumes.
- Any reserved, transferred, applied, or refunded residual-credit lineage is
  `reconciliation_review`. It is hidden from ordinary spendability and requires
  a later reviewed reconciliation operation; this adoption does not claw back,
  refund, or move value.

### Two-funded fixture accounting terms

The disposable two-funded example uses three raw `1,200,000` MNT agreements
with a `120,000` MNT family award per agreement. Its `2,280,000` MNT cash total
means `1,200,000 + 1,080,000`: it is cash received, not the sum of agreement
price and discount. The award is a separate non-cash reduction and must never
be counted as received money.

| Child | Raw obligation | Cash received | Award state / amount | Applied credit | Available residual credit | Payable balance |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| Funded A | 1,200,000 | 1,200,000 | earned / 120,000 | 0 | 120,000 only after canonical ownership exists | 0 |
| Funded B | 1,200,000 | 1,080,000 | earned / 120,000 | 0 | 0 | 0 |
| Pending C | 1,200,000 | 0 | provisional / 120,000 | 0 | 0 | conditional request 1,080,000 |

The first row's residual is a child-owned ledger root, not extra cash. If the
historical row has no canonical child owner yet, adoption preserves the award
and receipt but does not invent that root; normal identity/promotion handling
must establish ownership first. A root that is already reserved, transferred,
applied, or refunded is reconciliation evidence and remains unavailable.

### Rollout and recovery

1. Record a D1 recovery bookmark and normal non-sensitive baselines.
2. Apply `0052`, then deploy the Worker that understands quotes and
   `qualification_state`.
3. Verify health and schema read-only. Existing unadopted records continue on
   the released financial path until individually previewed and adopted.
4. Rehearse on a disposable, scoped historical fixture. Only after review may
   staff run a separately scoped adoption operation.

Worker rollback does not undo the migration or adopted records. An older Worker
must not be assumed compatible once conditional quotes or non-`earned` award
states exist; database recovery requires the recorded bookmark and a reviewed,
coordinated Worker/database plan.

The old Worker is compatible only during the additive interval after `0052`
and before any staff adoption links an award to a quote or changes a historical
award away from `earned`. Once either occurs, rolling back code alone is unsafe:
the older Worker does not understand provisional/failed/reconciliation effects
or their quote/recovery semantics.

## Minimal Implementation Scope

The existing partial-payment approval, `payment_confirmation` lifecycle,
additional-admission claim/fence pattern, `child_credit_operation` idempotency,
credit reservation rules, and audit events should be reused.

### Necessary schema changes only

The next number after 0051 is reserved in this proposal as
`0052_conditional_family_discount_quotes.sql`. It must be additive and must not
edit applied migrations.

1. Add `conditional_family_discount_quote`.
   - Agreement child, academic year, relationship basis/reference, frozen rate,
     base/award, installment strategy, revision, state, failure/review reason,
     current claim ID/expiry/fence/error, operation provenance, test provenance,
     and links to the historical/earned award.
   - Unique current quote per agreement and basis; indexes for pending claim,
     academic year, relationship reference, and reconciliation state.
   - This is the only new table required for lifecycle, locking, and recovery;
     claim fields live here rather than in a parallel claim table.
2. Add nullable quote reference/revision/reason fields to the existing
   `payment_confirmation` record. Reuse its existing finalization, permission,
   idempotency, seat-approval, and audit mechanism for conditional seat approval.
   No parallel approval table or approval endpoint is needed.
3. Add a financial-effect/qualification-state field to `discount_award`, linked
   to its quote. The original award record stays historical; its effect becomes
   `provisional`, `earned`, `failed`, or `reconciliation_review`. Existing
   `status`/reversal audit remains intact.

No new payment, generic credit, family-membership, identity, or refund table is
needed. Existing `child_credit_entry`, `additional_class_credit_reservation`,
and payment allocation tables remain the only ledger representations.

### Actions and projections

- Extend the existing staff partial-payment/seat-confirmation action with an
  optional quote ID/revision and reason. It performs one recognizable teacher
  action, uses the existing authorized partial-payment role, and records the
  conditional communication event. **Proposed default, awaiting approval:**
  retain the existing authorized role; no new two-person approval is required.
- Add a read-only conditional-settlement projection and preview. It is the only
  source for payment UI, messages, parent instructions, export, and reminders.
- Add a normal finalizer/recovery handler, not a separate teacher approval API.
  It claims selected quote rows, finalizes a funded subset, and resumes after a
  process failure with the same operation/fence rules.
- Add a staff reconciliation view that exposes failed/historical complex cases.
  It may retry processing; it cannot create a payment, erase credit use, refund,
  or reverse awards automatically.

## Lifecycle and Conflict Rules

| State | Entered when | Transition | Financial effect |
| --- | --- | --- | --- |
| `quoted_pending` | Eligible relationship exists but no funded finalization has won | funded subset claim, cancel/expire, or restoration under existing rules | Provisional quote only; no active usable value |
| `cash_coverage_ready` | A quote's funding predicate is met | finalizer, existing partial-seat approval, cancellation/expiry | Conditional amount is covered; difference is not overdue while pending |
| `conditionally_confirmed` | Existing authorized partial-seat approval references current quote + reason | finalizer, failure review, existing cancellation/restoration | Seat confirmed; condition and teacher notices remain open |
| `qualified` | All claimed subset predicates revalidate under one fence | terminal settlement path | Awards earned, residual roots/applications created once, eligible promotion occurs |
| `qualification_failed` | No valid qualifying subset remains | staff review or existing restoration pathway | Raw minus real cash/earned/applications becomes visible; staff chooses due date |
| `reconciliation_review` | Existing award/credit lineage cannot safely adopt automatically | reviewed future operation | No automated debit, credit, refund, or reversal |

Cancellation or expiry wins if it changes a claimed child before the guarded
finalizer write. If finalization wins, later cancellation follows existing
rules; this design does not add automatic cross-child clawback. **Proposed
default, awaiting approval:** existing restoration rules remain authoritative;
a restored record must re-enter predicate evaluation rather than revive an old
claim or stale quote revision.

## Focused Test Plan

`npm run test:conditional-family-discount-design` is a pure executable design
specification. It labels every expectation PROPOSED and currently asserts:

- two pending one-payment agreements at 1,080,000 + 1,080,000;
- two teacher-approved but unfunded seats failing the predicate;
- sequential 1,200,000 + 960,000 with explicit contingent donor authorization;
- two-installment first-cash funding and final-installment-first award effect;
- three-child subset resolution and overlapping finalizer claim exclusion;
- stale/cancelled finalizer rejection; and
- one payload-bound donor transfer/application with no intermediate spendable
  recipient balance and no replayed value.

The runtime implementation must add disposable local Worker/D1 and browser
coverage for each row in the assertion table, mixed prices/plans/rates,
existing valid qualifiers, same-child distinct class versus same class,
current family-group membership, payment/retry/refresh failure, exact Outbox
events, reminder behavior, claim expiry/reclaim, cancellation/expiry/
restoration, finalizer stage failures, historical award adoption, residual/
reserved/transferred/applied credit, capacity, and no duplicate enrollment.

## Remaining Decisions

Only these concrete policies remain open:

1. Confirm the proposed operational defaults: existing partial-payment role;
   conditional reminders for only unpaid conditional cash; staff-set due date
   after failure; existing restoration rules; and final-installment-first family
   award treatment for new compatible agreements.
2. Decide the compatible stacking order when a family award coexists with
   referral or manual awards, rounding residue, or an award greater than the
   final installment.
3. Decide the reviewed resolution for withdrawal or a failed qualification after
   earned credit has already been reserved, transferred, applied, refunded, or
   used in attendance. No automatic refund, credit reversal, or clawback is
   proposed here.

## Plain-Language Predicate

A family discount can be quoted before it is earned, but a quoted discount is
not money. Two agreements qualify only when they are two real, current class
occurrences and each is either already validly funded or brings enough actual
cash and explicitly authorized, bound value into the same protected operation.
A teacher-confirmed seat by itself cannot make that true. When the condition
succeeds, awards and any credit are created once under a fence. When it fails,
the receipt stays exactly as received and staff sees the genuine difference for
review.
