# Registration Model

This document describes the future registration and tuition model. It is a domain guide, not an implementation contract yet.

## Core Principle

A child's application is not a confirmed registration until the first required payment has been received.

Submitting pre-registration/application information does not by itself reserve a seat or consume class capacity. A pre-registration record may be reviewed, corrected, or used by the teacher/admin to apply privately approved terms before a payment request is generated.

Normal future flow:

```text
pre-registration completed
-> standard payment terms selected
-> class availability checked
-> temporary short seat hold created
-> required first payment requested
-> payment received/reconciled
-> enrollment confirmed
```

Exceptional future flow:

```text
pre-registration completed
-> selected class has capacity and temporary short seat hold is created
-> parent separately contacts teacher while the hold clock is running
-> teacher privately approves exceptional terms
-> approved first payment requested
-> payment received/reconciled
-> enrollment confirmed
```

A pre-registration that never proceeds to payment must not occupy class capacity. Only active temporary seat holds and confirmed enrollments should consume capacity.

After timely email verification, the initial payment has a fixed payment deadline of about 24 hours, configurable later. It is a deadline for payment, not an automatic seat-release clock. An unresolved initial-payment reservation remains capacity-consuming until an explicit reconciliation decision resolves it. Approval of exceptional terms does not automatically move the effective deadline; a future explicit extension will preserve the original deadline. Only an authorized explicit release can free an unpaid reserved seat.

## Course Payment Terms

Annual and summer courses currently have one required `single` plan and may
offer `two_installment`. The browser submits only that stable plan identity;
the server reads the Offering's current terms and records per-child base
amounts and the second due date on the accepted registration draft. A later
Offering price edit therefore applies only to new registrations. Once email
verification creates the normal 24-hour initial-payment hold, the authenticated
status response may show that child's saved initial amount and configured
transfer instructions. The public catalog never includes account details.
The accepted snapshot now creates generic installment obligations at email
verification. The payment request has one stable opaque transfer reference that
can cover several children while retaining individual obligations. Discounts,
credits, and adjustments remain separate future layers.

## Privacy Principle

Collect only information genuinely needed for enrollment, communication, tuition tracking, and safety. Do not design around collecting government identifiers or unnecessary sensitive personal data.

Children's registration records must never be committed to this public repository.

## Language Principle

Mongolian is the product language for parents, students, the registration flow, teacher operational screens, and future automated emails/reminders. Technical documentation and implementation names should remain in English. The advanced admin/developer area may use English where technical terms are clearer.

## Main Concepts

### Student

A persistent child identity applying for or participating in a program.

Likely future fields include:

- surname and name
- gender
- date of birth
- enrollment/stage history
- notes needed for safe participation

Gender and date of birth are persistent student information. Age should be derived from date of birth when needed, not manually maintained as the authoritative field.

Year-specific or confirmable student data may include current grade, current school, selected class/time, payment plan, and current rule acknowledgements. Grade remains required because the teacher uses it operationally and because placement rules are academic-year sensitive.

### GuardianAccount

A persistent parent/guardian identity that can communicate with the center, register children under their care, receive email milestones, return to registration/payment state, and manage account credit.

Likely future fields include:

- name
- children/dependents
- primary phone number
- optional second phone number
- required email address
- Facebook profile name or link, if useful for identifying the guardian and class-group communication
- one free-text approximate home address
- credit balance/ledger
- registration history
- preferred language, if needed

A child may only be registered by their parent or actual guardian. Public registration should not normalize casual relatives, friends, another child's parent, or other organizers registering someone else's child. Exceptional guardianship clarification can be handled privately by teacher/admin.

Returning parent/student pairs should not need to fill everything again each year.

Email verification is a prerequisite for future safe returning-account lookup and linking. A successful magic link currently proves only that the browser recently controlled the normalized email address; it must not by itself create or attach a `GuardianAccount`, reveal whether one exists, or expose children or prior registrations.

Do not collect Mongolian government registration/ID numbers. Do not collect unnecessary government identifiers.

Home address should be one free-text field, not district/khoroo/street/building/apartment fields. At minimum, ask for district-level information; parents may add khoroo, town/complex, or other detail if they choose. Exact apartment/unit information should not be required. The main purpose is to understand roughly how far the child's home is from the center.

### Returning Registration

Intended future returning-family flow:

```text
authenticated/passwordless returning guardian
-> existing child shown
-> confirm or update contact/address/school
-> update/confirm grade
-> DOB remains persistent
-> previous Naran Erdem stage/history already known
-> next stage recommendation
-> choose concrete class/time
-> parent + child review current rules
-> choose payment plan
-> proceed to seat hold/payment
```

Returning registration should be substantially shorter than first registration.

### Parent and Child Acknowledgement

Registration should reflect that parent/guardian and child review the registration information and rules together. This is an operational acknowledgement, not a fabricated legal digital-signature system. The accepted draft preserves the exact legitimate guardian/student rule versions loaded by that page. A later rule publication does not invalidate a genuine already-loaded historical version or rewrite accepted/canonical provenance.

Future public wording should remain concise and friendly, with concepts like:

- guardian: `Би хүүхэдтэйгээ хамт бүртгэлийн мэдээлэл, журмыг уншиж танилцсан бөгөөд хүүхдээ бүртгүүлэхийг зөвшөөрч байна.`
- child: `Би энэ сургалтад өөрийн хүсэлтээр суралцахыг хүсэж, сурагчийн журамтай танилцлаа.`

### BillingGroup

A financial/contact/reconciliation grouping for obligations that may be billed, contacted, reminded, paid, or reconciled together.

A bank payment may come from another person and may cover multiple obligations. Therefore `BillingGroup` must remain flexible and should not be used by itself to infer family relationships or discount eligibility.

A billing group can support:

- managing several enrollments together
- associating one payer/contact with several enrollments
- grouping reminders
- presenting a combined payment request for several installments

Individual students and enrollments must remain distinct records with their own program placement, tuition, adjustments, schedules, and enrollment state.

A payment must not be required to belong to exactly one billing group. Reconciliation needs to remain flexible because a received transfer may cover children across more than one household or group.

### FamilyGroup

An internal grouping for children who belong to the same family/guardian household for family-discount purposes.

Do not infer family relationships merely from surname, address, phone number, Facebook identity, or payment origin. A guardian registering multiple children under their care can establish the relationship directly. More complicated duplicate-parent or account-linking situations can later be handled by admin.

Do not expose `FamilyGroup` or `BillingGroup` terminology unnecessarily in public UI.

### Program

A logical Program is the stable teacher-recognized course identity. Its current
published `CurriculumProgram` revision is the ordered lesson content taught by
a new course; older revisions remain attached to the Offerings and calendars
that already used them. Program length is data. The annual progression has only
stages 1, 2, and 3; there is no Stage 4. A one-off event may have no program.

### ActivityOffering

An `ActivityOffering` is one concrete run offered by the center:

- annual course
- summer course
- one-off event

It owns the period, pinned Program revision, charge mode, calendar guidance,
and shared Facebook group. A new annual Offering chooses only a stage and the
server resolves the current logical Program revision; its academic year comes
from dates/current configured school-year logic. Annual and summer courses are always paid; events are free by
default and may be made paid. These modes do not yet create prices, payment
schedules, or obligations.

A paid Offering may be created and scheduled before pricing exists, but future
public registration must remain closed until it has a valid pricing basis and
required payment-plan terms. That future configuration belongs in Offering
detail under `Төлбөрийн нөхцөл`, not in compact Offering creation.

### Registration Window

`RegistrationWindow` is the teacher-facing `Бүртгэлийн хугацаа`: a name,
inclusive Mongolia-local start/end dates, and an explicit snapshot of one or
more annual/summer `ActivityOffering`s. It is many-to-many because one Offering
may be advertised again through a later reopening window. New Offerings are
never attached implicitly. A window is future, active, or past solely from its
dates; future windows are editable/deletable, active windows keep their start
date while their end/membership may be corrected, and past windows are
read-only.

Ordinary public acceptance requires an Offering in at least one active window,
valid pricing and bank-transfer settings, the concrete class's existing open
safety status, and the normal capacity/eligibility checks. A full class still
uses the ordinary FIFO waitlist. No active windows means new ordinary public
registration is closed. `academic_year.registration_status` is retained for
compatibility but does not add a second ordinary public-opening gate. Window
closure never releases or invalidates an
already accepted draft, verification path, initial-payment reservation, paid
identity review, canonical promotion, or waitlist record; it only rejects a
stale browser before a new draft is accepted. Teaching dates and registration
dates remain independent, so ordinary registration may remain open after a
course begins.

### ClassSession

A `ClassSession` is a concrete registration time/cohort inside a course
Offering. It is not merely a stage or level. Its authoritative meeting rule is:

```text
+ first date and optional last date
+ weekly / weekdays / daily recurrence
+ start time
+ end time
```

It includes capacity and registration availability. Annual compatibility still
retains academic year, stage, and weekday fields for the current public catalog.
A normal label is generated from teaching details rather than typed.

For example, two Saturday Stage 1 times are distinct annual classes. A summer
Offering can instead have `6/1–6/16 · 10:00–11:30` and
`6/15–6/26 · 13:00–14:30` classes that share one program but use different
periods and recurrences.

Class/session capacity should be configurable. Historically a class has 10 children.

### Program And Published Calendar

The durable course path is `CurriculumProgram -> ActivityOffering ->
ClassSession -> ClassCalendar`. The ClassSession supports registration and
family expectations but is not curriculum content and does not mechanically
define the occurrence calendar.

Weekly, weekday, and daily patterns only generate draft candidates. Published
`scheduled`, `no_class`, and `cancelled` rows are operational truth. The class
inherits the Offering program, so calendar generation cannot reselect it.
Annual school-calendar periods apply automatically and carry either an initial
exclusion or a warning-only behavior. Course-specific Offering breaks apply to
every class in one annual or summer Offering. Class-specific exclusion, restore,
and extra-slot decisions remain available.

After publication, cancellation preserves the original dated entry and only
reflows safe future assignments. Normal changes automatically protect past
published dates, any stronger stored internal boundary, and current recorded
attendance. The teacher does not enter a completed-lesson sequence. This
protection does not claim that a past lesson was delivered. Planned
Offering/class end dates are soft operational guidance: a
complete draft may extend beyond them with a warning, rather than silently
dropped lessons. Read-only class schedules expose no registration data. Details are in
[program-calendar-model.md](program-calendar-model.md).

Programless events use an explicit `OfferingEventOccurrence` for date/time,
capacity, and registration state rather than pretending to have Lesson 1.
Teachers and admins configure these records through a protected Mongolian
operational surface. Accountants cannot open or mutate it.

A missed Lesson 7 can be made up only through another suitable occurrence of Lesson 7, not by joining Lesson 8 because it has space. Future make-up suggestions require the same curriculum lesson, a suitable future occurrence with capacity, an unresolved absence, and teacher consideration. Suggestions never automatically invite parents; the teacher approves/rejects and can override them. A teacher may create one extra non-standard occurrence when normal occurrences are unavailable.

### Attendance and Future Parent Absence Notice

Course attendance is now protected staff-only operational bookkeeping for a
stable class/lesson occurrence, with present, late, absent, and a separate
teacher-recorded prior absence notice. The teacher has a phone-first roster and
can correct or clear an earlier entry while retaining audit/history. It does not
yet create make-up, credit, payment, or parent-portal behavior.

The future parent action `Хичээлд ирж чадахгүйгээ мэдэгдэх` selects one upcoming occurrence and may include a short note. Advance notice may favor make-up consideration but guarantees nothing. An uninformed absence gives no automatic make-up entitlement or credit.

### Future Schedule Communication

Schedule communication is future planned and separate from payment-reminder escalation. Irregular cancellation/rescheduling may send immediate email and generate optional teacher copy/paste Messenger text, including a replacement date/time only when known. A published planned no-class/holiday can send a configurable reminder about one or two days before the habitual slot. A concise return reminder may be sent around one day before the first lesson after a configured long break, including exact class/date/time.

Communication needs event/idempotency semantics: avoid duplicate sends for one published change, do not notify on unrelated metadata edits, group siblings where clearer, and allow a materially changed reschedule to create a new notice. Make-up messages remain teacher-approved before they are generated or sent.

Current staging calendar fixtures are deliberately fake and carry test
provenance. They include annual weekly cohorts and a 12-lesson summer Offering
with weekday and daily classes. Events are isolated service-test cases, not
routine staging list data. The fixtures exercise breaks, independent progress,
class restoration/exclusion, and extra slots. They are not Naran Erdem's real
curriculum or public schedule.

### Future Generalized Registration Target

The current public flow remains the existing annual stage/class flow. It still
selects one stable `ClassSession`, and its capacity, hold, and FIFO waitlist
rules do not change in this migration.

Future course registration should target `ActivityOffering + ClassSession`.
Future event registration should target `ActivityOffering +
OfferingEventOccurrence`. Both should share guardian/student identity, verified
email, capacity checks, and a class/occurrence-specific FIFO waitlist where
appropriate. A free event can eventually confirm after email verification and
capacity confirmation without a payment-only hold. Every course must use common
future pricing/payment machinery. Public summer/event registration is not
implemented yet.

### Selected Class

The current annual public registration selects at most one concrete
`ClassSession` for each child:

```text
stage + weekday + start/end time
```

The selected class is not merely a preferred stage. It is the class to capacity-check before creating a future temporary hold. A stage recommendation may be derived from previous confirmed participation where known, but it remains an editable parent choice. Homepage stage links may preselect a stage in the prototype; they never lock it. Selection precedence is explicit user choice, then a valid initial URL stage, then a derived recommendation. Once the parent chooses manually, returning-history changes and catalog refreshes must not overwrite that choice.

The phone-first prototype keeps the child form compact: required fields use only the red asterisk, optional fields have no marker, and missing-field feedback appears only after an attempted continuation. Previous-stage selection appears and becomes required only for a returning child, and stage/class controls read as ordinary fields rather than a nested wizard. When a selected stage has no configured classes, the page explains that state at the class field and does not redirect focus to the stage selector.

### Enrollment

An enrollment connects a student to a program/session/academic year.

Enrollment status should distinguish:

- `awaiting_initial_payment`: temporary seat hold created, first required payment not received
- `confirmed`: first required payment received and the child has a confirmed place
- `initial_hold_expired`: legacy historical status; new initial-payment reservations are released only by an explicit audited reconciliation action
- `cancelled`: enrollment was manually or administratively cancelled
- `completed`: enrollment finished normally

A later overdue installment must not automatically cancel, delete, or hide a confirmed enrollment.

The ordinary public flow creates at most one current class choice for an application child. In the rare case that a student should study in two stages/classes at once, a future teacher/admin operation may create the exceptional additional enrollment. It is never advertised or requested through parent registration. The current schema does not impose a student-per-year uniqueness rule, so it already permits this exceptional second enrollment with its own class and tuition obligation.

### Waitlist Entry

A waitlist entry is separate from an unpaid seat hold. It represents interest in one specific full class and forms one FIFO queue per concrete `ClassSession`, ordered by stable entry creation time and opaque ID as a deterministic tie-breaker.

Ordinary parent-facing behavior permits at most one active preferred waitlist target. A parent may choose an available fallback class and one full preferred class at the same time. Once the fallback enrollment is confirmed, its preferred-class waitlist remains active. If every class is full, one waitlist target is enough for the future waitlist-only path; no fake primary class is required. The public registration and waitlist model has no ranked alternatives.

When a seat becomes available, the first eligible active entry for that class receives a temporary transfer or acceptance offer. If it expires, the offer moves to the next entry. A public parent must not be able to join every full class.

### Transfer And Additional Enrollment

A transfer replaces an existing enrollment only after the target has succeeded. If a child confirmed in class B is waiting for class A, an A offer temporarily reserves A while B remains confirmed. Declining, expiry, or an unpaid required difference releases A back to its queue and leaves B untouched. Only a completed transfer releases B, which may then trigger B's FIFO queue.

An exceptional additional enrollment is different: teacher/admin creates another enrollment, the original seat remains, and the second class has its own tuition/pricing obligation and any separately approved adjustment.

Cross-level transfer must use each enrollment's actual pricing snapshot, payment plan, discounts, charges, and already-received payments. A higher target obligation requires the difference before the source seat is released. A lower target obligation creates account credit after transfer; historical received payments are never rewritten. Equal obligations need no financial adjustment.

## Initial Seat Hold Flow

Intended flow:

```text
finish form + rules + review
-> save pending registration/draft
-> atomically capacity-check selected class
-> 20-minute provisional email-confirmation hold
-> email confirmation
-> initial-payment reservation with a 24-hour payment deadline
-> first required payment received
-> confirmed enrollment
```

The staging implementation now follows this flow. The provisional hold protects a seat while the parent confirms email. It never consumes time from the initial-payment reservation's 24-hour payment deadline, which starts only after timely email confirmation. A provisional hold stops consuming capacity when its 20 minutes pass. An active initial-payment reservation continues to consume capacity after its deadline until staff explicitly reconciles payment or releases the seat. Public full-class temporary counts include both kinds of capacity-consuming holds, never identities.

Initial-payment reconciliation records durable payment evidence and allocations.
After the required first installment is fully reconciled, migration 0022 safely
promotes each eligible child to canonical guardian/student/application/enrollment
records. It uses only the verified server-side normalized email for GuardianAccount
resolution and only strict normalized name, DOB, and gender comparison within
that guardian's already-linked children for automatic Student reuse. Ambiguous or
returning no-match cases remain paid and seat-protected until teacher/admin review.

The registration confirmation link itself remains usable for a longer configurable lifetime, currently about 24 hours. If confirmation happens after the 20-minute provisional hold expired, atomically re-check capacity. Reacquire the class and start a fresh payment hold if possible; otherwise explain that the temporary guarantee expired and show available classes plus the selected class's FIFO waitlist. Saved registration data remains recoverable.

Email scanners must not consume confirmation links. The future one-click flow places the secret in the URL fragment, then the real browser posts it to the verification endpoint; a scanner's ordinary HTTP GET never receives or consumes it. Ordinary login/auth magic links remain conceptually separate and may have a shorter lifetime.

After staging form completion, the parent sees a simple email-status screen with the displayed address, resend and change-address actions, the provisional-hold explanation, and Spam/Junk advice. Resend has a 60-second cooldown; resend and change-address invalidate superseded links but never restart the provisional clock. An HttpOnly draft-access cookie restores this status without refilling the form.

The browser-local pre-submission draft lasts 24 hours for accidental refresh or overnight closure and never creates a registration or hold. An accepted server draft has a separate seven-day retention deadline. Retention does not extend the 20-minute seat guarantee or 24-hour confirmation link. It must never delete or rescind a financially unresolved initial-payment reservation.

Before verification, preferred waitlist intent stays only on the server draft. Verification materializes one FIFO entry per child. Waitlist-only creates no seat hold; fallback plus preferred waitlist converts the fallback to a payment hold and creates the preferred entry. Canonical promotion links but does not duplicate a materialized draft waitlist entry, so its original FIFO timestamp remains authoritative. Waitlist-only canonicalization remains future work.

If initial payment has not been reconciled, the system may later send reminders, but elapsed time alone is never payment evidence and never releases the seat. A positive future bank/QPay signal may confirm money received; an absent signal must not release anything.

An approved short extension can move the effective deadline without erasing the original deadline.

## Tuition

### Future Reminder, Accountant, and Settlement Direction

This section is **future planned domain**, not implemented payment/accountant functionality. Standard plans remain one-time or two-installment; exceptional arrangements are private and teacher/admin-approved. Later-installment reminders should use effective due dates while preserving original dates, with restrained email, copyable Messenger text for a teacher, then a narrow accountant call queue after configurable overdue timing. Initial registration/payment holds remain a distinct time-sensitive process.

The first accountant view should be `Залгах шаардлагатай`: a derived queue of unresolved teacher-approved receivables. Contact outcomes and promise dates may be recorded, but a parent promise is not an official extension. Only teacher/admin approval changes an effective deadline.

When a student stops after partial attendance/payment, settlement should normally consider lessons delivered during the active period, not simply lessons attended. The system may provide advisory elapsed-lesson and attendance-based comparisons with payment, adjustment, absence, and make-up context. The teacher approves or edits the final operational amount; no formula is legally authoritative by itself, and historical received payments remain immutable.

An enrollment conceptually has:

- selected payment-plan tuition/pricing basis
- zero or more tuition reductions
- net tuition
- zero or more ancillary charges
- total obligation before account credit
- applied available credit, if any
- currently payable amount
- a payment schedule with one or more installments

The system should preserve enough information to explain how final tuition was calculated.

### Standard Payment Plan Pricing Basis

The parent first chooses a standard payment-plan pricing basis. For example:

- full-year tuition total
- two-installment tuition total

These may have different totals. Do not treat the cheaper full-year plan itself as a percentage `TuitionAdjustment`; it is a different standard plan price.

Use a conceptual value such as `pricingBasis` or `selectedPlanTuitionTotal`.

### Tuition Reduction

Possible reduction types include:

- automatic family discount
- automatic referral discount
- 10% merit award for selected good returning students
- manually approved exceptional adjustment

Percentage reductions are calculated independently against the chosen plan's pre-discount tuition total. If selected-plan tuition is `T`, two referral reductions are:

```text
5% * T + 5% * T = 10% * T
```

not:

```text
T * 0.95 * 0.95
```

Reduction records should preserve:

- rate
- basis
- calculated amount
- reason/rule
- who or what approved/qualified it
- when it was approved/qualified
- whether it affects the whole enrollment or specific installments

Do not hard-code an arbitrary maximum discount. Advanced admin policy settings should conceptually control family discount rate, referral discount rate, whether referrals accumulate, optional referral cap, optional total automatic-discount cap, whether family + referral stack, whether merit award + automatic discounts stack, and future adjustment-combination rules. These settings belong in advanced admin, not teacher daily UI.

### Automatic Family Discount

There is a normal, public family discount: if two or more eligible children from the same family are enrolled in the same academic year, each receives a 10% tuition reduction.

This is not a teacher-only exceptional discount. It should be modeled as an automatic business rule based on `FamilyGroup` eligibility.

Recommended qualification semantics:

- base the discount on genuinely participating/paid children, not fake or abandoned pre-registrations
- consider the benefit final when at least two eligible family children have made the required initial payment / become confirmed
- if children are processed together, the system may eventually generate an appropriately discounted combined payment
- if one child paid earlier at full price and a second child later qualifies the family, the earlier child can receive account credit

Keep the precise activation algorithm configurable enough that backend implementation can refine it later.

### Referral Discount

There is a normal referral program:

- an existing/current child A may refer child B
- B must still be registered by B's own parent/guardian
- A does not register B
- successful referral gives 5% tuition reduction to both A and B
- A may refer several children and can earn multiple 5% reductions
- percentages add linearly, not multiplicatively

A referral only financially qualifies when both relevant children have made their required initial payment / are confirmed.

If B pays before A, B may initially pay full price. When A later pays and the referral becomes qualified, A's 5% can affect A's payment immediately where possible, and B receives equivalent account credit if B already paid too much.

Model referral identity explicitly. Do not infer friendship/referral from school, address, Facebook, names, or payment origin. The optional public `Код` is generic: it may represent a referral, teacher award, one-time benefit, reusable event code, campaign, or another configured benefit. A referral remains a special code type with an explicit relationship because both families may receive reciprocal benefits. The family's own shareable referral code/link is not generated during registration; it becomes available only after the first required payment confirms enrollment.

### Private Teacher/Admin Financial Approval

Merit awards, custom reductions, three-installment schedules, custom dates/amounts, delayed first-payment handling, or other exceptional arrangements must be privately approved by teacher/admin before payment. They must not appear as public self-selectable options or clues in the registration UI. Where practical, approval should modify the effective tuition/payment schedule before a payment request is generated, rather than relying on reimbursement after payment.

### Ancillary Charge

The model should support modest explicit fee components in addition to tuition adjustments:

```text
selected payment-plan tuition
- tuition reductions calculated from that tuition basis
= net tuition

net tuition
+ ancillary charges
= total obligation before account credit
```

Examples may include a laboratory coat or another explicitly defined required item. A child who already owns the required item may not need that charge. Percentage tuition discounts do not apply to laboratory coats or other ancillary charges. Do not hard-code historical ancillary amounts as current prices, and do not turn this into a general accounting package.

### Account Credit Ledger

Credit is not a tuition discount.

A late-qualified family/referral/merit adjustment, overpayment, or another valid event may create account credit for the guardian.

Credit should preserve:

- amount created
- reason/source
- originating child/enrollment when relevant
- created time
- remaining balance
- applications/refunds against it
- audit history

Do not simply edit an old payment amount after money has already been received.

Credit application should conceptually work as:

```text
selected-plan tuition
- tuition discounts
+ ancillary charges
= obligation

obligation
- applied available credit
= currently payable amount
```

A guardian with multiple children may eventually apply eligible account credit to an appropriate future obligation subject to business policy. Available credit may remain across installments and across academic years, including use when a child advances to the next stage. If the guardian does nothing, the safe default is to leave the amount as available credit.

### Refund Workflow

A parent may choose to receive available credit back. Do not plan automatic outgoing bank transfers yet.

Future refund workflow:

```text
available credit
-> parent requests refund
-> refund due/requested
-> teacher/admin manually transfers money
-> simple action marks refund completed
-> audit record retained
```

Refunding consumes the corresponding credit balance.

## Payment Schedules

Standard templates will probably include:

- one full-year payment with a lower total fee
- two installments with a slightly higher total fee

Administrators must also be able to approve exceptions such as three installments, custom installment amounts, and custom due dates.

Therefore installments should be modeled generically rather than with fields such as `payment1` and `payment2`.

The public registration UI should show only currently configured standard choices, such as `Бүтэн жилээр төлөх` and `2 хувааж төлөх`. It must not publicly advertise three-payment arrangements, merit awards, custom reductions, delayed first payment, or a generic request for special terms.

### Installment

An installment should conceptually contain:

- amount
- original due date
- effective due date
- status
- paid date, when paid
- reconciliation or payment references

Possible statuses include:

- `upcoming`
- `due`
- `paid`
- `overdue`
- `cancelled`
- `waived`

The effective due date is derived from the original due date plus any approved extension. The original due date should remain visible for audit and explanation.

## Short Payment Extensions

Parents sometimes ask for two or three extra days to pay. The teacher should eventually be able to approve this very easily.

Do not model an extension by silently overwriting the original due date.

An extension should preserve:

- original due date
- new or effective deadline
- when the extension was granted
- who granted it
- optional short note or reason
- whether it applies to the initial payment window or a later installment

Reminder and overdue logic should operate on the effective deadline.

An approved extension changes only the effective deadline and preserves the original. An overdue initial-payment reservation remains reserved until explicit reconciliation; a delayed later installment must not automatically remove an already enrolled child.

## Payment Records and Evidence

Payment reconciliation must be architecturally separate from enrollment logic.

The model must not assume that one bank transaction belongs to exactly one child or exactly one installment.

Real cases include:

- one parent paying for two siblings in one transfer
- one person paying for their children plus a relative's child
- one transfer covering several outstanding installments
- one installment being paid through multiple partial transfers

### Payment

A `Payment` represents an actual received financial transaction or evidence of money received.

It should conceptually contain:

- amount received
- received date/time
- source or reference information
- reconciliation status
- evidence records
- amount currently allocated
- amount currently unallocated

Do not make `studentId` or `installmentId` a required direct ownership relationship of `Payment`.

A payment may be:

- fully allocated
- partially allocated
- currently unallocated
- duplicated or suspected duplicate
- incorrectly matched at first and later corrected
- an overpayment relative to known installments

Do not silently force an unmatched amount onto an installment.

### PaymentAllocation

A `PaymentAllocation` represents some portion of one `Payment` being applied to one `Installment`.

It should conceptually contain:

- payment
- installment
- allocated amount
- who or what made the allocation
- allocation time
- optional reason or note

This creates a many-to-many relationship:

```text
Payment A
-> part to Installment 1
-> part to Installment 2
-> part to Installment 3
```

and:

```text
Installment 1
<- Payment A
<- Payment B
```

Allocation history should be preserved if allocations are later corrected, split, merged, or reassigned.

### Evidence Sources

The same underlying payment records should be able to accept evidence from any future source:

- manual teacher confirmation based on Khan Bank SMS
- imported bank transaction statement
- direct bank API, if available
- payment reference encoded in a bank-transfer QR
- future automated reconciliation

The current foundation records `staff_manual_bank`, `staff_manual_cash`,
`parent_claim`, and `staff_checked_not_found`. A parent claim is optional,
idempotent supporting evidence, never proof of payment, never a deadline
extension, and never a capacity change. A future receipt screenshot may attach
private object-storage evidence to such a claim. It needs authenticated staff
viewing, validation, retention policy, and no public URL; R2 storage and OCR
are deliberately not provisioned yet.

The opaque payment reference contains no personal information. A later
Монголбанк-standard transfer QR may fill recipient, amount, and this reference,
but remains an ordinary bank transfer and does not confirm payment by itself.

### Manual Teacher Confirmation

A key future workflow:

1. The teacher receives a Khan Bank SMS indicating an incoming tuition payment.
2. She finds or is shown the expected payment.
3. She presses a simple Mongolian action such as `Төлбөр орсон`.

The interface should require almost no technical knowledge. Internally, the action must create auditable payment evidence rather than toggling an anonymous boolean or exposing a raw checkbox.

The future UX should protect against accidental clicks without becoming cumbersome:

- for an obvious/common match, record the payment evidence immediately
- show a short-lived Undo action such as `Буцаах`
- if amount, date, or allocation is ambiguous, ask for the minimum additional information needed

Payment evidence should preserve:

- amount
- payment date/time, when known
- proposed or confirmed allocation, when known
- evidence source, such as manual confirmation based on bank SMS
- who confirmed it
- when it was confirmed
- optional note or reference

Later bank statement or API reconciliation should be able to corroborate this record without erasing the original manual confirmation history.

If incoming payment evidence strongly matches one or more expected installments, the teacher phone UI may show the child or children, the received amount, and a simple proposed allocation with one action such as `Баталгаажуулах`. If a transfer covers several children or installments, the combined transfer should be shown as one received payment while preserving the expected allocation to each installment underneath.

Ambiguous or complicated allocation should be deferred naturally to a desktop reconciliation view rather than forcing dense financial tables onto the teacher's phone.

### Experimental iPhone SMS Evidence Adapter

The teacher uses an iPhone. A future experimental adapter may be investigated:

```text
Khan Bank incoming SMS
-> iPhone personal automation
-> secure HTTPS POST
-> payment evidence ingestion endpoint
```

This is not a current dependency and is not yet known to work with exact Khan Bank SMS contents. Before relying on it, the project needs a small proof-of-concept with the teacher's actual iPhone and a real or representative Khan Bank incoming-payment SMS.

The SMS path is bounded:

- the public registration system must not depend on the teacher's phone being online
- SMS ingestion is untrusted payment evidence, not authoritative bank truth
- the ingestion endpoint must not confirm enrollment, mark an installment definitively paid, alter tuition, or perform privileged financial operations
- at most, it may create normalized/untrusted payment evidence or a possible incoming payment for reconciliation
- duplicate SMS delivery should be harmless and idempotent where possible
- parsing must be isolated from core enrollment/payment logic
- later bank statement or API data should be able to corroborate the same payment

## Imperfect Payments

Real payments may not match perfectly. The future system should support a small `needs attention` queue for reconciliation issues such as:

- missing references
- wrong amounts
- payment from a grandparent or another person's account
- duplicate payments
- partial payments
- overpayments
- unallocated received money
- manual transfers that ignore a generated QR

The model should allow payment evidence to exist before it is confidently allocated, and should preserve allocation/reassignment history when a payment is later matched or corrected.

## Grouped Reminders and Payment Requests

Future communication should avoid unnecessary duplicate messages.

If one contact has several children or installments due at approximately the same time, the reminder system should be capable of sending one understandable Mongolian message containing the relevant children, amounts, and total instead of mechanically sending several separate emails.

Underlying installments remain individually auditable.

Similarly, a future payment request may present a combined total while preserving the expected allocation to individual installments. This should work naturally with `BillingGroup`, `Payment`, and `PaymentAllocation`, but should not require every payment to belong to one billing group.

## Facebook Offering Groups

Facebook is a major operational communication channel for parents and students.
The authoritative operational model has one optional Facebook group per
`ActivityOffering`, shared by all of that Offering's concrete class times. An
annual stage run may therefore share one group across Saturday morning and
afternoon classes, while a summer run may use another. Migration 0009's older
academic-year/stage setting remains compatibility/history and is not a second
write authority.

Future registration data should be able to record a guardian's Facebook profile name or profile link when useful. After enrollment is confirmed, the system should eventually be able to show or send that Offering's Facebook group link so the parent/student can request to join.

Do not require a child to have a Facebook account. Do not plan automated Facebook group invitations, Facebook API integration, or Facebook Login as part of the core registration model.

## Teacher Dashboard Direction

The future teacher dashboard should stay small, Mongolian-language, and operational. It should optimize for a few obvious actions rather than expose database state or technical concepts. It may surface:

- what needs attention today
- payments awaiting confirmation
- provisional email holds nearing expiry
- overdue initial-payment reservations awaiting explicit reconciliation
- installments due soon
- overdue installments
- contacts or billing groups who have been granted extensions
- quick student/family search
- spreadsheet export

Avoid a large enterprise-style dashboard. Advanced configuration, adapter names, API concepts, database terminology, reconciliation internals, and technical settings belong in the admin/developer interface.

Some administrative business operations may still belong to the teacher if they are made simple, including granting a 2-3 day extension, confirming a payment, finding a child/family, viewing outstanding tuition, and exporting current records.

Most daily teacher operations should be designed for iPhone first. The phone UI should favor large obvious actions, short lists/cards, and minimal typing. Dense financial tables, ambiguous reconciliation, detailed payment allocation, audit history review, bulk operations, and complex configuration can be desktop-enhanced workflows.

## Export Requirements

Exportability is a first-class requirement.

At minimum, plan for CSV export as a portable baseline. The teacher should eventually see one simple action such as `Excel файл татах`, even if the implementation internally produces CSV, XLSX, or another spreadsheet-compatible representation.

Later XLSX export may contain clean sheets for:

- enrollments
- students and guardians
- payment schedules
- received payments
- outstanding installments
- summary or snapshot information

Teacher exports should reflect current operational state in useful, human-readable views. They should not require understanding database structure and should not be raw database dumps. A separate richer or raw export may be appropriate for administrators.

## Audit Requirements

Important operational actions should eventually be auditable, especially:

- manual payment confirmation
- payment reassignment
- tuition adjustment
- payment extension
- cancellation

Auditability should live in the underlying model and services. The teacher-facing interface can remain simple while the system records the history needed for accountability.
