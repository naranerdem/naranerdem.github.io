# Data Model

This document summarizes the first D1 registration foundation. The authoritative schema is the versioned SQL migration in `migrations/`; this document explains the design choices around that migration.

## D1 Environments

The project uses two Cloudflare D1 databases:

- `naran-erdem-staging` for realistic end-to-end testing.
- `naran-erdem-production` for future live registrations.

Wrangler remains the source of truth. The top-level Worker configuration binds future production code to `DB -> naran-erdem-production`. The `staging` Wrangler environment binds the same `DB` name to `naran-erdem-staging` and deliberately has no custom domain route.

The Worker serves static Astro assets directly and runs the small API layer only for `/api/*` paths. Production uses `DB -> naran-erdem-production` and keeps `REGISTRATION_WRITE_ENABLED=false`. The separately deployed staging Worker uses `DB -> naran-erdem-staging` and sets the flag true only for explicitly test-marked registrations.

## ID And Timestamp Strategy

Application code should generate opaque text IDs, such as UUIDs or similarly unguessable identifiers, before inserting records. SQLite rowids and autoincrement IDs must not become public identifiers.

Timestamps are stored as UTC ISO-8601 text strings. Age is not stored; it is derived from `student.date_of_birth` when needed.

## Core Tables

- `guardian_account`: persistent parent/guardian identity, contact fields, normalized lookup fields, status, and test provenance.
- `student`: persistent child identity with name, gender, date of birth, status, and test provenance.
- `guardian_student_relationship`: persistent relationship between guardians and students, including whether the guardian is currently authorized to manage registration.
- `family_group` and `family_group_member`: minimal explicit family-discount eligibility foundation. Family is not inferred from surname, address, payment origin, or Facebook identity.
- `academic_year`: public label and registration status for a year/session without hard-coding unsupplied year details.
- `curriculum_program_family`: stable logical annual stage or named summer Program identity, with one current published revision pointer.
- `curriculum_program`: immutable historical revision beneath a Program family; its ordered lessons are the taught content.
- `activity_offering`: one annual course, summer course, or event, with typed period/context, pinned program revision, break policy, charge mode, optional shared Facebook group, status, and provenance. Its `facebook_group_url` is the sole operational write authority.
- `class_session`: concrete course cohort/time option attached to an Offering, with capacity, registration availability, and test provenance. Legacy annual stage/weekday/time and stored label fields remain for current catalog compatibility.
- `class_meeting_rule`: authoritative weekly, weekdays, or daily generation rule and local period/time for one course class.
- `offering_event_occurrence`: narrow programless one-off event date/time, capacity, and registration state.
- `academic_year_stage_setting`: legacy 0009 annual Facebook setting retained for compatibility/history; new operational writes use `activity_offering.facebook_group_url`.
- `annual_course_start_default`: one typed singleton month/day rule for the editable default start date of a new annual Offering; it is admin-managed, audited, and deliberately not a general key/value settings table.
- `pre_registration`: yearly/transactional parent application before confirmed enrollment. One pre-registration may contain multiple children.
- `application_child`: child-specific portion of a pre-registration, including current school, grade, returning/new status, optional generic `code_input`, payment-plan choice, and one selected concrete `class_session`.
- `enrollment`: initial seat-hold and confirmed-enrollment foundation, including original/effective hold deadlines and lifecycle timestamps.
- `waitlist_entry`: one FIFO queue entry for one concrete class, with future offer/expiry fields.
- `referral`: explicit referral identity connecting a referring child/enrollment to a referred application child, with pending/qualified state only.
- `outbound_email`: milestone email queue/delivery record, including intended/actual recipients, provider status, provider message ID, stable idempotency key, and compact failure code.
- `email_verification_challenge`: normalized email, one-time token hash, purpose, lifecycle, configurable registration-confirmation expiry (currently 24 hours), linked outbound email, and test provenance. It never stores the raw magic-link token.
- `verified_email_session`: normalized verified email, hashed session token, short expiry, optional revocation, and test provenance. It is not a guardian account or long-lived account session.
- `registration_draft`: seven-day server-side guardian/contact snapshot, rule versions, payment-plan/code input, hashed draft-access token, and registration lifecycle. Staging rows are explicitly test-marked.
- `registration_draft_child`: per-child snapshot with one nullable current/fallback class and one nullable preferred FIFO target. It is deliberately separate from canonical `student` identity.
- `registration_capacity_hold`: one per draft child, moving from a 20-minute `provisional_email_confirmation` deadline to a fresh 24-hour `initial_payment` deadline after verification.
- `registration_draft_waitlist_entry`: one verified FIFO entry per draft child. Unverified waitlist intent remains only on `registration_draft_child`.
- `audit_event`: compact non-PII audit event/tombstone table for future operational actions.

## Ownership And Deletes

Guardian and Student are persistent shared records. Deleting a pre-registration must not automatically delete its guardian or student rows.

Owned application records use `ON DELETE CASCADE` where the ownership is unambiguous:

- `pre_registration -> application_child`
- `application_child -> enrollment`
- `application_child -> waitlist_entry`
- `application_child -> referral` for the referred side
- `family_group -> family_group_member`

Shared or durable references are restrictive or set-null instead. For example, class sessions, academic years, guardian accounts, and students are not deleted just because one pre-registration is hard-deleted.

Future admin hard delete should be guarded:

1. Verify strong admin privilege.
2. Verify hard deletion is allowed.
3. Delete the pre-registration and owned dependents transactionally.
4. Inspect persistent guardian/student/family rows.
5. Remove only explicit test rows that are now genuinely orphaned.
6. Preserve a compact non-PII deletion audit/tombstone when required.

Production real records should normally use cancellation/archive, not routine hard delete. Hard delete in production is reserved for explicit test records, accidental duplicates, privacy-driven cases, and similarly guarded exceptions.

## Test Provenance

Most operational tables include:

- `is_test`
- `test_run_id`

Staging naturally contains test data, but test provenance is still useful for cleanup, analytics exclusion, and future production smoke tests.

`is_test` must never mean "skip workflow logic." Staging and production smoke tests should exercise the same registration, hold, waitlist, tuition, reminder, email-generation, and teacher/admin workflows as real data. Production smoke-test records should eventually use dedicated test class/session data so they cannot consume real family seats.

A future advanced-admin/dev action such as `Delete all test data` must operate only on explicit test data or staging, require strong admin privilege and confirmation, clean in dependency-safe order, and never become a public endpoint.

## Public API Safety

The public catalog API may return only registration configuration. It must never return guardian, student, application, email, audit, or other private operational records.

An unauthenticated future registration submission must not reveal whether a guardian email already has an account, return existing guardian/student data for a supplied email, overwrite an existing guardian's contact details, or authoritatively link a new child/application to an existing guardian merely because emails match. Existing-account access and linking must wait for the future passwordless email-ownership verification flow, and API responses must not disclose account existence.

Successful magic-link verification creates only a short-lived verified-email session. Challenge consumption and session creation execute in one D1 batch so replay cannot create another session. No authentication query reads `guardian_account`, and no guardian row is created or linked by this foundation.

## Seat Allocation Atomicity

Migration 0005 implements staging allocation with one conditional `INSERT ... SELECT`. It groups requested seats by class, subtracts confirmed enrollments plus active legacy and draft holds, and inserts all requested child holds only if no class is short. D1 executes the surrounding batch transactionally and serializes its statements; a capacity-race loser inserts zero holds and receives current availability instead of an email. Late confirmation uses the same all-or-none grouped check when reacquisition is needed. Multiple children therefore never receive accidental partial seat protection.

## Public Catalog Availability

The public catalog returns only non-sensitive aggregate availability for a concrete class. It uses:

```text
remaining seats = capacity - confirmed enrollments - active provisional holds - active initial-payment holds
```

Only `enrollment.status = confirmed` counts as confirmed. Active temporary counts include legacy `enrollment.status = awaiting_initial_payment` rows with a future effective deadline and migration-0005 capacity holds with `status = active` and a future deadline. This includes both 20-minute provisional and 24-hour initial-payment holds, but not confirmed enrollments. Expired rows stop counting immediately even before cleanup, and the public value is clamped at zero.

The catalog does not return a pre-registration total. If a future internal surface needs that number, it should count only non-cancelled, non-deleted child applications with the same `selected_class_session_id`; it must not be used for capacity.

For a class with seats, public UI shows only remaining seats. For a full class, it shows `Анги дүүрсэн` and `Түр хадгалагдсан: N` only when a temporary count is greater than zero. Production excludes test sessions and test rows from both class listing and aggregate counts. Staging may expose explicit test fixtures so it follows the same code path.

## Email Testing Principle

The Resend adapter and verification-email path are enabled only in staging with a mandatory safe-recipient override. Production remains disabled. `outbound_email` remains the audit source for queue, attempt, sent, and failed state and links registration confirmation mail back to its server draft.

The table distinguishes:

- `intended_to_email`: the parent-entered recipient the system would normally target.
- `actual_delivery_email`: the safe test inbox that actually receives staging/test delivery.
- `delivery_mode`: `production`, `staging_override`, or `test_override`.

For example, staging may record `intended_to_email = fake-parent@example.com` and `actual_delivery_email = gantimur-controlled-test-address@example.com`. This preserves what would have happened without sending arbitrary email to fake or mistyped addresses.

No provider credentials, API keys, raw magic-link tokens, session tokens, or full marketing-email system belong in this schema.

## Constraints And Indexes

The migrations add database-level checks for basic invariants: positive class capacity, valid lifecycle statuses, current grade range, JSON validity where compact metadata is stored, and test-run consistency.

Important uniqueness rules:

- One selected current class reference per application child.
- One FIFO waitlist entry per application child; it may coexist with the selected/current class.
- No student-plus-academic-year uniqueness rule: teacher/admin can create a rare additional enrollment without weakening the public one-current-class rule.
- A concrete class-session time is unique within an academic year/stage/weekday/start/end combination.

Indexes cover expected lookup paths without indexing everything: guardian email/phone lookup, guardian-student relationships, class sessions by year/stage/status, pre-registrations by guardian/year/status, enrollment class/status and hold deadline, FIFO waitlists by class/status/creation order, outbound email queue processing, and audit subject/time lookup.

## Deferred Finance Concepts

This migration deliberately does not implement:

- payment records
- payment allocation
- credit ledger
- refund ledger
- full tuition adjustment engine
- bank payment evidence
- Khan Bank SMS/API adapter

`application_child.selected_payment_plan_code` is only a registration-time placeholder for the selected standard payment plan. Complete tuition, payment, discount, credit, refund, and reconciliation tables should come in a later finance migration.

## Program And Calendar Foundation

Migration `0006_program_and_calendar_foundation.sql` implements class-level program/calendar data without attendance or make-up records:

- `curriculum_program` was the original versioned parent for academic-year/stage content. Migration 0013 keeps that compatibility context but places every revision beneath a stable `curriculum_program_family`; its child `curriculum_lesson` rows have explicit positive, unique sequence numbers, titles, optional internal notes, and test provenance.
- `academic_year_break` stores named inclusive planning periods. It is an input to generation, not an occurrence.
- `class_calendar` belongs one-to-one to a `class_session` and fixes `Asia/Ulaanbaatar` as its teaching-time timezone.
- `class_calendar_revision` is a draft/publish snapshot associated with the matching stage/year program. Only one published revision exists per calendar. The internal `locked_through_sequence` is retained as one input to historical schedule protection; it is not exposed as teacher-confirmed attendance or delivery.
- `class_calendar_revision_override` gives one class a dated `exclude` or `restore` planning decision.
- `class_calendar_slot` is the explicit dated result. It has a unique class/date/time, permits each lesson at most once per revision, and distinguishes `scheduled`, `no_class`, and `cancelled`. Cancellations retain a lesson number/title snapshot rather than deleting the public history; later structural changes keep those rows while recalculating the ordered active slot sequence.

Database triggers allow lessons, overrides, and entries only while their parent is a draft, require program/year/stage compatibility, and prevent deletion or identity edits of published program/calendar history.

The protected staff setup surface uses these existing tables directly through
narrow server operations. It adds no generic database editor or new persistence
model: published rows remain immutable, copied program lessons receive new IDs,
and a post-publication calendar change is a separately auditable draft revision.

Migration `0009_academic_year_stage_settings.sql` added an intentionally narrow
annual stage-setting record. Migration 0010 preserves that table as
legacy/history and copies an existing annual stage Facebook URL into the new
corresponding Offering where safe. New staff behavior reads and writes only the
Offering-level URL, so 0009 is not a second authority. The older
`class_session.facebook_group_url` column also remains compatibility-only.

## Activity Offering And Meeting Rules

Migration `0010_activity_offerings_and_meeting_rules.sql` adds the domain layer
between curriculum content and concrete cohorts:

- `activity_offering` represents one `annual_course`, `summer_course`, or
  `event`. Typed fields hold title, selected Program, period, calendar guidance,
  `free`/`paid` charge mode, optional Facebook group URL, status, test
  provenance, and timestamps. An annual Program derives the annual Offering's
  academic year/stage context.
- `class_session.activity_offering_id` attaches existing and future course
  cohorts to an Offering without rebuilding the registration table.
- `class_meeting_rule` is one-to-one with a course class and supports `weekly`,
  `weekdays`, and `daily` recurrence, first/optional last date, weekly weekday,
  and authoritative local start/end time.
- `offering_event_occurrence` stores a programless event's local date/time,
  capacity, registration status, lifecycle, and provenance without inventing a
  fake class or curriculum lesson.

Existing annual year/stage programs and classes are backfilled into one annual
Offering per year/stage, retaining stable ClassSession IDs. The migration also
backfills weekly meeting rules from existing class/calendar data and copies the
legacy 0009 Facebook setting to the annual Offering. The legacy ClassSession
weekday/time fields continue to support the current public annual catalog; new
staff/calendar services treat the meeting rule as authoritative and mirror
those values for compatibility.

Course classes inherit their program, break policy, charge mode, and shared
Facebook group from their Offering. Database triggers prevent mismatched
year/stage attachment and consequential Offering/program changes after a
published calendar exists. Harmless communication changes remain possible.
New classes and event occurrences start with registration closed.

Annual and summer Offerings are always paid; events default to free and may be
paid. These values create no finance records. Future paid registration must use
common pricing/payment machinery, while a free event can eventually confirm
after email verification and capacity checks without a payment-only hold.

Production has the schema only and no operational Offerings, classes, programs,
events, Facebook groups, or personal data. Staging fixtures are explicitly
test-only and exercise annual and summer behavior; event behavior is isolated
in service tests because events are occasional.

Migration `0011_legacy_calendar_program_continuity.sql` is a narrow transition
guard for calendars that were already published before Offerings existed. A
new initial calendar must use the Offering's current program. A later revision
may continue a superseded program only when it is directly based on published
history for the same class/calendar and same program. This preserves old
operational schedules without permitting arbitrary program substitution. New
staff behavior prevents an Offering program change once any class calendar
exists, so this exception cannot create new drift.

Migration `0012_offering_breaks_and_calendar_guidance.sql` classifies Programs
as annual or summer, enforces the matching course Program kind, and enforces
that annual/summer Offerings are paid while annual school guidance remains on.
It adds `activity_offering_break` for a shared course-specific break and the
legacy `academic_year_break.generation_behavior` compatibility field. It also creates
`operational_default_import`, which records stable source-template imports.
The Schedule surface manages this shared all-class break; school-calendar
periods remain separate annual guidance in Holidays.

Migration `0014_annual_course_start_default.sql` adds the small typed singleton
used to prepopulate the start date of a new annual Offering. Existing Offering
periods remain unchanged; their actual lesson end continues to come from the
explicit calendar. The default is an administrative setup preference rather
than a teacher-facing daily control.

Migration `0015_independent_school_calendar_guidance.sql` makes school guidance
orthogonal with `academic_year_break.exclude_from_generation` and
`academic_year_break.warn_on_overlap`. It backfills legacy
`exclude_by_default` rows to `1/1` and legacy `warn_only` rows to `0/1`; the
legacy enum remains compatibility-only. It also repairs an invalid historical
Program-family state where an interrupted defaults import superseded the
revision still named by the family's current pointer.

Approved non-private startup Programs and school-calendar periods live in
`src/config/operational-defaults.mjs`. The baseline contains the three annual
logical Program families with 30, 30, and 23 ordered lessons and the explicit
2026–2027 Ulaanbaatar VI–IX operational calendar template from Ministry of
Education Order A/211 (2026-07-08), Annex 1. Its six inclusive initial
exclusions and warnings include Republic Day (11/26) and International Women's
Day (3/8); winter guidance starts on 12/26. There is no generic
summer-vacation record.
Import is explicit and idempotent:

```sh
npm run seed:operational-defaults -- --env=staging
npm run seed:operational-defaults -- --env=production --confirm-production
```

The command never runs during deployment, never copies staging data to
production, and never overwrites teacher-edited or published records. The
stable import marker makes already-imported templates visible as skipped.

Attendance, absence notice, make-up, accountant workflow, payment-reminder, and settlement tables remain deferred. Future schema design should keep these distinctions explicit:

- attendance bookkeeping and prior absence notice: editable operational records attached to a concrete occurrence, with auditable correction history.
- make-up consideration/invitation/agreement: teacher-mediated records attached to the same curriculum lesson, not automatic credits or generic free-class access.
- approved payment obligation and effective due date: later finance concepts that may feed a derived accountant call queue without erasing original deadlines, payments, or contact history.
- settlement review: teacher-approved operational receivable supported by transparent advisory calculations; it must not be a silently authoritative attendance-derived debt.

Migration `0007_staff_authentication_foundation.sql` adds `staff_account`, normalized `staff_role` and `staff_account_role`, separate `staff_login_challenge` and `staff_session` tables, and coarse login throttling. The only roles are `admin`, `teacher`, and `accountant`; `assistant_teacher` is intentionally absent. Capabilities are mapped in the server authorization layer so later scopes do not require replacing the identity/session model. `outbound_email.staff_account_id` connects staff login delivery to the existing auditable queue. The audit actor vocabulary now includes `staff`.

Migration `0008_persistent_cross_context_staff_sessions.sql` adds `staff_login_attempt` and `staff_session_policy`, links each challenge to its attempt, and extends sessions with `last_seen_at`, permanent `expired_at`, and an optional coarse client label. An attempt stores only the hash of the initiating browser's claim secret. Email challenge consumption changes an attempt from pending to approved; session creation requires that claim secret and atomically changes the attempt to claimed. Decoy attempts for unknown or disabled addresses have no `staff_account_id` and can never become authenticated.

Raw staff magic-link, attempt-claim, and session tokens are never persisted. D1 stores 64-character SHA-256 hashes. Session policy is normalized per role; the effective inactivity and absolute limits are the shortest values among current roles. Roles are not copied into a session, so role and policy changes apply to existing sessions. Expired and revoked markers prevent later policy lengthening or account re-enabling from resurrecting a session. Staff records remain wholly separate from `guardian_account` and `verified_email_session`.

Future schedule communications should reuse provider/audit infrastructure with event/idempotency semantics but remain separate from payment-reminder policy. A published cancellation/reschedule is one meaningful event even when it reassigns many later lessons. Later additions may include planned no-class reminders, return-from-break reminders, and teacher-approved make-up invitations; none are sent by this foundation.

## Migration Workflow

Use Cloudflare D1 versioned migrations in `migrations/`.

Recommended flow:

```sh
npm run test:d1:local
npx wrangler d1 migrations apply DB --env staging --remote
npx wrangler d1 migrations apply DB --remote
```

Use staging before production. Before applying production migrations, verify the target production database is the intended empty/new database. Do not use ad hoc destructive SQL against production.

The staging catalog API has a deliberately fake, non-PII fixture set. Apply it only to staging with `npm run seed:catalog:staging`; the SQL uses `INSERT OR IGNORE` and must never be applied to production.
