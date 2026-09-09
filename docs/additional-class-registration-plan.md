# Same-Child Additional-Class Registration Plan

## Scope

This document specifies the additional-class lifecycle. Its first staff-selected
slice is implemented with a guarded pending admission; later parent selection,
combined payment entry, withdrawal, and class-oriented export remain planned. It adds a
second concurrent class for an already canonical child. It is not a transfer:
the existing enrollment stays active, and each class keeps its own capacity,
payment schedule, confirmation, attendance, cancellation, and history.

The first release is a teacher/admin workflow inside `Бүртгэл, төлбөр`. It
must reuse canonical identity, the ordinary catalog/pricing service, capacity
reservation, payment requests/installments, payment allocation, promotion,
authorization, audit, email Outbox, and scoped staging cleanup. It must not
insert an enrollment directly or create a parallel pricing/payment contract.

## Existing Foundation

- Canonical `student` identity is linked to an `application_child`, while an
  `enrollment` is unique only per application child. There is no student/year
  uniqueness constraint, so a second application child can safely produce a
  second class enrollment for the same student.
- `registration_draft` / `registration_draft_child`, the atomic
  `registration_capacity_hold`, `payment_request`, `payment_installment`,
  `received_payment`, and `payment_allocation` already model an accepted but
  not-yet-confirmed class choice.
- `effectiveInstallmentsForRows`, `discount_award`, payment credits, and the
  reconciliation service derive effective obligations without rewriting raw
  plan snapshots, received payments, or allocations.
- Class transfer is deliberately unsuitable: it supersedes the source
  enrollment only after target completion. Additional class creation must not
  use transfer status, reservation, or financial-difference tables.
- The current export is registration/payment-oriented. It must become an
  explicit class-oriented projection with one row per child-class application
  or enrollment; a received payment remains one record and is never counted
  once per allocated class.

## First-Release Model

Create a new registration draft and one new draft child, but bind it to the
existing canonical student during creation. The draft is explicitly marked as
an additional-class admission and references the source canonical enrollment.
It receives its own selected class, payment plan snapshot, payment request,
installments, capacity hold, acknowledgements, and audit lineage. The source
enrollment is read-only input to this workflow and remains unchanged.

### Durable admission provenance

Migration `0042_staff_additional_class_admissions.sql` adds
`additional_class_admission`. It links the new ordinary draft/child to the
source confirmed enrollment, canonical student and guardian, staff actor and
idempotency key. It stores the accepted family-policy revision/rate and the
source/target base and promised award amounts. Its lifecycle is
`pending_confirmation`, `confirmed`, `cancelled`, or `expired`; a new
additional admission never inserts an enrollment directly.

The optional parent-selection capability remains a later design:

```sql
ALTER TABLE registration_draft_child
  ADD COLUMN additional_class_source_enrollment_id TEXT
  REFERENCES enrollment(id) ON DELETE RESTRICT;

ALTER TABLE registration_draft_child
  ADD COLUMN additional_class_admission_mode TEXT
  CHECK (additional_class_admission_mode IN ('staff_selected', 'parent_selected'));

CREATE INDEX idx_registration_draft_child_additional_source
  ON registration_draft_child(additional_class_source_enrollment_id, status);

CREATE TABLE additional_class_parent_selection (
  id TEXT PRIMARY KEY,
  registration_draft_child_id TEXT NOT NULL UNIQUE
    REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'revoked', 'expired')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1)
);
```

The scoped parent selection capability is necessary only for the optional
parent-time-selection path; staff-selected V1 does not need it. Cleanup removes
the restrictive additional-admission link before its synthetic draft hierarchy,
while audit history remains retained.

## Lifecycle and Atomic Boundaries

1. Teacher/admin opens `Нэмэлт анги нэмэх` from a canonical child. The server
   verifies `registration.manage`, the source enrollment is current and
   eligible, and the child/guardian identity is still authoritative.
2. Staff chooses an eligible offering/stage, plan, and either a class or the
   parent-selection mode. The server uses an explicit staff-admission policy,
   not the public registration window alone. V1 may permit only an active
   staff-eligible offering; it must not create an unrestricted closed-window
   bypass.
3. On staff-selected confirmation, one transaction rechecks target capacity,
   creates the additional draft/child with source provenance and fresh parent
   and child acknowledgement evidence, creates its hold/payment request/
   installments, and writes one audit event. Duplicate submission uses an
   idempotency key.
4. Parent-selected mode creates only an expiring, hashed, revocable selection
   capability. GET/link previews never mutate. The parent explicitly chooses a
   currently eligible class and confirms fresh acknowledgements; one
   idempotent POST rechecks capacity and creates the same ordinary draft/hold
   aggregate. Protected guardian-contact replacement revokes outstanding
   selection links.
5. Normal payment reconciliation and canonical promotion confirm only the new
   class. Cancellation, transfer, attendance, reminders, and waitlist logic
   remain per class.

No email is sent merely by opening a selection link. Delivery or manual copy of
the link is an explicit staff action through existing Outbox policy.

## Payment, Combined Payment, and Discounts

One bank transfer can remain one `received_payment` with multiple explicit
`payment_allocation` rows across the two additional-class payment requests.
Allocation conservation must hold. Seat confirmation is evaluated independently
per class from that class's effective initial obligation and allocations.

Each additional class uses its accepted, selected-plan pricing snapshot. Payment
plans may have different original tuition totals, so a percentage award is
calculated from the original total of that selected agreement, not from another
plan's price. The following figures are examples only, not global prices:

- one-payment agreement: 1,200,000 MNT original total; a 10% award leaves
  1,080,000 MNT payable;
- two-installment agreement: 1,300,000 MNT original total, split as
  650,000 + 650,000 MNT; a 10% award leaves the first 650,000 MNT unchanged
  and deducts the 130,000 MNT award from the second installment, making it
  520,000 MNT and the agreement total 1,170,000 MNT;
- two classes using those two-installment terms and each receiving 10% have a
  combined first payment of 1,300,000 MNT and a combined second payment of
  1,040,000 MNT, allocated separately to the two class obligations.

Same-child multi-class qualification reuses the existing `family_multi_child`
base-award type and its authoritative family-discount policy rate; it does not
create a second configured percentage or stack a duplicate base award on one
agreement. The durable admission link distinguishes this lifecycle from an
ordinary guardian-family award. The preview reads
that rate and its revision from `discount_policy_setting`; a disabled or missing
policy must not fall back to 10% or any other default. The existing setting is
currently a global policy record, so choosing a distinct academic-year or
agreement-specific policy version is a future schema/policy decision. Duplicate
applications for the same child and class never establish additional
eligibility. Family is never inferred from matching email, phone, surname,
address, or the person who submitted registrations. An existing source base
award remains intact; the target may receive its one missing base award at
confirmation. Earned referral awards remain separate under the existing
referral policy.

For a two-installment agreement, the agreed base award is deducted from the
second installment while the first remains half of the original selected-plan
total. No historical received payment or allocation is repriced. Additional
classes remain teacher-initiated.

Target pricing is independent: the target class always uses its own accepted
agreement snapshot and does not inherit the source class's total, installments,
or plan. Requiring a two-installment target is a V1 implementation boundary,
not an inherent class rule. A bounded follow-up may support one-payment targets
by calculating the agreed award against that target's selected upfront plan
before the ordinary registration/payment pipeline creates its obligation.

Agreed first-slice behavior: previewed prices do not change either bill at
admission creation. The durable promise activates each missing base award only
when ordinary payment finalization canonically confirms the target enrollment.
Pre-confirmation cancellation/expiry never activates it. There is no automatic
cross-class award reversal after confirmation in this slice.

Unresolved policy decisions:

- whether an existing first installment already paid may be offset by credit or
  only reduce the later installment;
- exact stacking order with family/referral/manual awards and any total cap;
- rounding direction for basis-point calculations;
- whether discounts that exceed a second installment become an explicit credit,
  reduce another obligation, or require manual reconciliation;
- how a fully paid agreement is adjusted without rewriting its received-payment
  history or allocations;
- whether a pre-attendance cancellation of one class reverses both linked
  awards automatically or leaves an explicit credit/reconciliation decision;
- how a transfer interacts with a linked award; recommend preserving the award
  only when its beneficiary enrollment remains current and requiring explicit
  reconciliation otherwise.

## Withdrawal Policy

During-semester withdrawal is separate from pre-semester cancellation. Its
reconciliation uses undiscounted tuition as the basis because applicable
discounts are void, but it must not automatically claim the full annual amount:
earned/refundable value depends on the later withdrawal calculation. Open
questions include single-class withdrawal from two concurrent classes and
whether linked family/referral awards affecting other children are reversed;
no cascading revocation is implied.

## UI and API Contracts

- `Нэмэлт анги нэмэх` appears only in the expanded canonical child record for
  teacher/admin. The child is shown under each class occurrence; opening either
  occurrence reveals both current classes and their separate obligations.
- A staff form uses the authoritative catalog, plan/pricing projection, and
  explicit discount service. It does not duplicate public form validation.
- Parent selection is a narrow `/additional-class/select` capability surface,
  not parent dashboard authority. It exposes only the linked child, eligible
  class choices, current payment consequences, and fresh consent controls.
- Class-oriented export emits one child-class row and separate allocation
  columns/identifiers so totals can be reconciled without duplicating payments.

## Testing and Cleanup

Focused tests must cover staff/admin authorization, closed-public-window staff
eligibility policy, no direct enrollment, capacity races/full targets,
idempotency, source-enrollment preservation, two-class payment allocations,
per-class confirmation, award/credit arithmetic, parent-link expiry/revocation
and no-mutation GETs, class-oriented export, cancellation/transfer boundaries,
and ordinary public registration unchanged. Staging rehearsals use one marked
synthetic aggregate and supported cleanup for its draft, hold, payment request,
installments, capabilities, Outbox, enrollment, awards, credits, and
reservations while retaining audit history.

## Implementation Sequence

1. Confirm unresolved discount and staff-eligibility policy decisions.
2. Add the smallest migration and service-level draft/source invariants.
3. Implement staff-selected additional admission and tests.
4. Add class-oriented payment list/export and combined-allocation support.
5. Add audited multi-class award/reversal behavior.
6. Add optional scoped parent time-selection capability.
7. Rehearse each stage in staging before a production release.
