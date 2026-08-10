# Data Model

This document summarizes the first D1 registration foundation. The authoritative schema is the versioned SQL migration in `migrations/`; this document explains the design choices around that migration.

## D1 Environments

The project uses two Cloudflare D1 databases:

- `naran-erdem-staging` for realistic end-to-end testing.
- `naran-erdem-production` for future live registrations.

Wrangler remains the source of truth. The top-level Worker configuration binds future production code to `DB -> naran-erdem-production`. The `staging` Wrangler environment binds the same `DB` name to `naran-erdem-staging` and deliberately has no custom domain route.

The current Worker remains asset-only. Wrangler supports `main` being optional for asset-only Workers and supports D1 bindings in `wrangler.jsonc`; the binding is ready for the next API phase, but no Worker script or public API has been introduced yet.

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
- `application_child`: child-specific portion of a pre-registration, including current school, grade, returning/new status, optional referral input, and selected payment-plan code.
- `ranked_class_preference`: ranked concrete class-session choices. The schema allows more than three ranks.
- `enrollment`: initial seat-hold and confirmed-enrollment foundation, including original/effective hold deadlines and lifecycle timestamps.
- `waitlist_entry`: ranked class waitlist entry and future offer/expiry fields.
- `referral`: explicit referral identity connecting a referring child/enrollment to a referred application child, with pending/qualified state only.
- `outbound_email`: future milestone email queue/delivery record. It does not send email yet.
- `audit_event`: compact non-PII audit event/tombstone table for future operational actions.

## Ownership And Deletes

Guardian and Student are persistent shared records. Deleting a pre-registration must not automatically delete its guardian or student rows.

Owned application records use `ON DELETE CASCADE` where the ownership is unambiguous:

- `pre_registration -> application_child`
- `application_child -> ranked_class_preference`
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

## Email Testing Principle

Email delivery is not implemented in this foundation, but `outbound_email` is designed so staging can test the real generation/provider path safely.

The table distinguishes:

- `intended_to_email`: the parent-entered recipient the system would normally target.
- `actual_delivery_email`: the safe test inbox that actually receives staging/test delivery.
- `delivery_mode`: `production`, `staging_override`, or `test_override`.

For example, staging may record `intended_to_email = fake-parent@example.com` and `actual_delivery_email = gantimur-controlled-test-address@example.com`. This preserves what would have happened without sending arbitrary email to fake or mistyped addresses.

No provider credentials, API keys, or full marketing-email system belong in this schema.

## Constraints And Indexes

The migration adds database-level checks for basic invariants: positive class capacity, valid lifecycle statuses, positive preference rank, current grade range, JSON validity where compact metadata is stored, and test-run consistency.

Important uniqueness rules:

- One preference rank per application child.
- One class session may not be repeated for the same application child.
- A concrete class-session time is unique within an academic year/stage/weekday/start/end combination.

Indexes cover expected lookup paths without indexing everything: guardian email/phone lookup, guardian-student relationships, class sessions by year/stage/status, pre-registrations by guardian/year/status, child preferences, enrollment class/status and hold deadline, waitlists by class/status, outbound email queue processing, and audit subject/time lookup.

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
