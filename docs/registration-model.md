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

Current policy expects a short initial hold of about 24 hours, configurable later. Approval of exceptional terms does not automatically extend or freeze the hold unless the teacher/admin separately grants an explicit extension. If the hold expires before payment, the pre-registration remains, the seat is released, any approved custom terms may remain associated with the pre-registration where sensible, and the parent must reacquire an available class/time, choose another time, or join the waitlist.

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

Registration should reflect that parent/guardian and child review the registration information and rules together. This is an operational acknowledgement, not a fabricated legal digital-signature system.

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

A science program offered by the center. Programs may last a full academic year.

The center has a three-year progression, so a returning student may participate in year 1, year 2, or year 3 of the broader program.

### Session or Academic Year

A concrete offering of a program for a specific academic year, schedule, capacity, and teacher-facing cohort.

### ClassSession

A concrete class is not merely a stage or level. A `ClassSession` is:

```text
stage
+ weekday
+ start time
+ end time
```

It should eventually also include capacity, current availability, academic year/session, and the class Facebook group URL.

For example, two different Saturday `1-р шат — Анхан шат` time slots are two different classes. Parents choose a specific class/time during registration.

Class/session capacity should be configurable. Historically a class has 10 children.

### Ranked Class Preferences

Public registration should let a parent rank one or more concrete class/time preferences for each child. Each ranked item is a concrete `ClassSession`, not merely a stage:

```text
1st preference -> stage + weekday + start/end time
2nd preference -> stage + weekday + start/end time
3rd preference -> stage + weekday + start/end time
```

Parents should only rank times they would actually accept. The first preference is the highest priority, but later preferences are also acceptable if earlier choices are unavailable.

Future backend seat-hold semantics:

- when creating a seat hold, try the highest-ranked acceptable class with capacity
- if the first preference has no capacity but the second does, the second may receive the seat hold
- if none of the acceptable choices has capacity, preserve waitlist entries/preferences in ranked order
- when a relevant seat becomes available, offer the best-ranked available choice
- once one concrete class is paid/confirmed, remove or deactivate the child's other competing waitlist/preferences for that enrollment

Do not add complicated public policies yet, such as asking parents to decide whether they want to wait only for preference #1 even if preference #2 has a seat.

### Enrollment

An enrollment connects a student to a program/session/academic year.

Enrollment status should distinguish:

- `awaiting_initial_payment`: temporary seat hold created, first required payment not received
- `confirmed`: first required payment received and the child has a confirmed place
- `initial_hold_expired`: initial payment was not received before the effective deadline
- `cancelled`: enrollment was manually or administratively cancelled
- `completed`: enrollment finished normally

A later overdue installment must not automatically cancel, delete, or hide a confirmed enrollment.

### Waitlist Entry

A waitlist entry is separate from an unpaid seat hold. It represents interest when no seat is currently available.

When a seat becomes available, a waitlisted contact or billing group may receive a temporary opportunity with its own payment window. Failure to pay can eventually pass that opportunity to the next waitlisted contact or group.

## Initial Seat Hold Flow

Intended flow:

```text
available seat
-> temporary hold
-> first required payment received
-> confirmed enrollment
```

If initial payment is not received, the system may send reminders and expire the hold. Reminder timing and expiry timing must be configurable, not hard-coded.

An approved short extension can move the effective deadline without erasing the original deadline.

## Tuition

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

Model referral identity explicitly. Do not infer friendship/referral from school, address, Facebook, names, or payment origin. Future implementation should use a referral code or referral link tied to the referring child/enrollment. The referred child's own parent follows or enters that referral and completes their own registration.

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

An expired initial-payment hold may release a seat. A delayed later installment must not automatically remove an already enrolled child.

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

## Facebook Class Groups

Facebook is a major operational communication channel for parents and students. Each class may have its own Facebook group.

Future registration data should be able to record a guardian's Facebook profile name or profile link when useful. After enrollment is confirmed, the system should eventually be able to show or send that class's Facebook group link so the parent/student can request to join.

Do not require a child to have a Facebook account. Do not plan automated Facebook group invitations, Facebook API integration, or Facebook Login as part of the core registration model.

## Teacher Dashboard Direction

The future teacher dashboard should stay small, Mongolian-language, and operational. It should optimize for a few obvious actions rather than expose database state or technical concepts. It may surface:

- what needs attention today
- payments awaiting confirmation
- initial holds nearing expiry
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
