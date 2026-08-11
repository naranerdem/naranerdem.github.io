# Data Model

This document summarizes the first D1 registration foundation. The authoritative schema is the versioned SQL migration in `migrations/`; this document explains the design choices around that migration.

## D1 Environments

The project uses two Cloudflare D1 databases:

- `naran-erdem-staging` for realistic end-to-end testing.
- `naran-erdem-production` for future live registrations.

Wrangler remains the source of truth. The top-level Worker configuration binds future production code to `DB -> naran-erdem-production`. The `staging` Wrangler environment binds the same `DB` name to `naran-erdem-staging` and deliberately has no custom domain route.

The Worker serves static Astro assets directly and runs the small API layer only for `/api/*` paths. The production Worker uses `DB -> naran-erdem-production`; the separately deployed `naran-erdem-staging` Worker uses `DB -> naran-erdem-staging`. Both environments currently set `REGISTRATION_WRITE_ENABLED=false`.

## ID And Timestamp Strategy

Application code should generate opaque text IDs, such as UUIDs or similarly unguessable identifiers, before inserting records. SQLite rowids and autoincrement IDs must not become public identifiers.

Timestamps are stored as UTC ISO-8601 text strings. Age is not stored; it is derived from `student.date_of_birth` when needed.

## Core Tables

- `guardian_account`: persistent parent/guardian identity, contact fields, normalized lookup fields, status, and test provenance.
- `student`: persistent child identity with name, gender, date of birth, status, and test provenance.
- `guardian_student_relationship`: persistent relationship between guardians and students, including whether the guardian is currently authorized to manage registration.
- `family_group` and `family_group_member`: minimal explicit family-discount eligibility foundation. Family is not inferred from surname, address, payment origin, or Facebook identity.
- `academic_year`: public label and registration status for a year/session without hard-coding unsupplied year details.
- `class_session`: concrete stage + weekday + start/end time, capacity, availability, optional future Facebook group URL, and test-only marker.
- `pre_registration`: yearly/transactional parent application before confirmed enrollment. One pre-registration may contain multiple children.
- `application_child`: child-specific portion of a pre-registration, including current school, grade, returning/new status, optional referral input, payment-plan choice, and one selected concrete `class_session`.
- `enrollment`: initial seat-hold and confirmed-enrollment foundation, including original/effective hold deadlines and lifecycle timestamps.
- `waitlist_entry`: one FIFO queue entry for one concrete class, with future offer/expiry fields.
- `referral`: explicit referral identity connecting a referring child/enrollment to a referred application child, with pending/qualified state only.
- `outbound_email`: milestone email queue/delivery record, including intended/actual recipients, provider status, provider message ID, stable idempotency key, and compact failure code.
- `email_verification_challenge`: normalized email, one-time token hash, purpose, lifecycle, 15-minute expiry, linked outbound email, and test provenance. It never stores the raw magic-link token.
- `verified_email_session`: normalized verified email, hashed session token, short expiry, optional revocation, and test provenance. It is not a guardian account or long-lived account session.
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

## Future Seat Allocation Atomicity

When registration writes are introduced, the selected concrete class must be atomically capacity-checked while its hold is created. Do not implement it as an unprotected `SELECT` for availability followed later by an `INSERT`; use D1 batch/transaction semantics and database constraints or conditional writes as appropriate.

## Public Catalog Availability

The public catalog returns only non-sensitive aggregate availability for a concrete class. It uses:

```text
remaining seats = capacity - confirmed enrollments - active initial-payment holds
```

Only `enrollment.status = confirmed` counts as confirmed. An active hold means `enrollment.status = awaiting_initial_payment` with an `effective_hold_deadline_at` in the future, and an active underlying application/parent registration. The public value is clamped at zero.

The catalog does not return a pre-registration total. If a future internal surface needs that number, it should count only non-cancelled, non-deleted child applications with the same `selected_class_session_id`; it must not be used for capacity.

For a class with seats, public UI shows only remaining seats. For a full class, it shows `Анги дүүрсэн` and shows the active-hold count only when that count is greater than zero. Production excludes test sessions and test rows from both class listing and aggregate counts. Staging may expose explicit test fixtures so it follows the same code path.

## Email Testing Principle

The Resend adapter and verification-email path are implemented but disabled by configuration. `outbound_email` remains the audit source for queue, attempt, sent, and failed state.

The table distinguishes:

- `intended_to_email`: the parent-entered recipient the system would normally target.
- `actual_delivery_email`: the safe test inbox that actually receives staging/test delivery.
- `delivery_mode`: `production`, `staging_override`, or `test_override`.

For example, staging may record `intended_to_email = fake-parent@example.com` and `actual_delivery_email = gantimur-controlled-test-address@example.com`. This preserves what would have happened without sending arbitrary email to fake or mistyped addresses.

No provider credentials, API keys, raw magic-link tokens, session tokens, or full marketing-email system belong in this schema.

## Constraints And Indexes

The migrations add database-level checks for basic invariants: positive class capacity, valid lifecycle statuses, current grade range, JSON validity where compact metadata is stored, and test-run consistency.

Important uniqueness rules:

- One selected class reference per application child.
- One FIFO waitlist entry per application child.
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
