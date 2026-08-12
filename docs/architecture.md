# Architecture

This project starts as a static Astro site and should remain deployable as a public/static fallback even after backend-dependent registration features are added.

## Goals

- Keep the public website simple, static, and resilient.
- Treat phone-first design as a hard product requirement, not just a responsive layout concern.
- Keep teacher workflows uncluttered and task-oriented.
- Keep administrative and technical controls out of the normal teacher interface.
- Keep payment reconciliation separate from enrollment logic.
- Keep operational data and secrets out of the public repository.
- Preserve audit history for important operational actions.

## Language Policy

Mongolian is the product language for public, parent/student-facing, registration, teacher-facing, and reminder interfaces. The site should declare Mongolian as the document language where appropriate.

Technical documentation, code identifiers, TypeScript types, database/property names, and adapter/service names should remain in English. The advanced admin/developer area may use English where technical English is clearer. Do not introduce a heavyweight multilingual/i18n system at this stage; instead, keep important user-facing strings lightly organized so they can be reviewed and kept consistent.

## Mobile-First Requirement

Most parents and students will interact with the system only on phones. The teacher will also perform most routine daily operations on an iPhone.

This is a phone-first product requirement, not merely a request for desktop screens to be responsive. Future interfaces should start from phone-primary workflows and then add desktop-enhanced views where larger screens genuinely help.

Phone-primary workflows include:

- public website
- registration
- choosing a payment plan
- payment instructions and payment action
- registration and payment status
- teacher daily attention screen
- teacher payment confirmation
- teacher granting a short extension
- quick student/family search

Teacher phone UI should prefer large obvious actions, short lists/cards, minimal typing, and no dense financial tables by default.

Desktop-enhanced workflows may include:

- ambiguous or complicated reconciliation
- detailed payment allocation
- bulk operations
- spreadsheet review/export
- audit history
- program and fee configuration
- advanced admin/developer settings

## System Boundaries

### Public/static website

The public website contains general pages, program information, and entry points into registration. It should be able to build to static files and serve correctly on both Cloudflare Workers Static Assets and GitHub Pages.

On Cloudflare, static assets remain asset-first. A small Worker API runs only for `/api/*`, with D1 access kept in explicit service layers. Production registration writes and email/auth remain disabled. The separately deployed staging Worker uses staging D1, has no custom domain, and enables the real test registration path with Cloudflare's documented Turnstile test credentials and the mandatory safe email-recipient override. The older provider smoke endpoint remains behind its staging secret test gate.

The public site must not require a production database, authentication service, email provider, or bank integration to render.

### Registration/backend application

The backend application will eventually handle application submission, seat holds, enrollment status transitions, tuition schedules, payment evidence, reminders, and exports.

The backend should expose narrow application-level operations instead of letting UI code directly mutate persistence records. Examples include:

- create application and temporary seat hold
- confirm first required payment
- grant payment extension
- record payment evidence
- allocate received payments to installments
- cancel enrollment
- export operational records

Ordinary registration selects at most one current concrete class per child. Future class availability and seat-hold creation must use that selected class atomically. A full class uses a simple FIFO waitlist for that same class; ranked alternative-class choices are not part of the public model. A parent may pair an available fallback class with one full preferred waitlist target. Confirming the fallback must not silently remove that active preferred waitlist.

The current non-submitting prototype keeps stage selection deterministic: an explicit user choice wins, a valid `?stage=` value is only an initial default, and a previous-stage recommendation is used only when neither is present. Returning-history controls must never overwrite a manual stage choice. Conditional controls are disabled while hidden so native validation cannot target invisible fields.

The production catalog may legitimately contain no configured classes. The UI must then focus and explain the class-availability state rather than treating the already-valid stage select as the missing field. A previous prototype bug did the latter because its custom selected-class check ran for every successful catalog response, including an empty catalog, and always focused the stage select. Regression coverage preserves the corrected behavior.

Parent and student rule acknowledgements are distinct product events. Staging submissions persist the explicit stable parent/student rule versions from the content layer; future published rule changes must use new immutable version IDs.

Parent-facing account access should eventually be passwordless, based on verified email magic links or one-time codes. Email links should return the parent to durable server-side registration/account state, not rely on an old browser tab or client session remaining alive.

Before email ownership is verified, a public submission must not discover whether an email belongs to an existing guardian, retrieve existing family data, overwrite an existing guardian profile, or authoritatively link supplied data to an existing account. This preserves safe account linking for the future passwordless flow.

Migration 0003 adds one-time verification challenges and short-lived verified-email sessions; migration 0004 renames the premature referral-only input to generic `code_input`; migration 0005 links challenges/sessions to a separate server registration draft and adds per-child capacity holds and verified-draft FIFO entries. Challenge, session, and draft-access tokens use Worker Web Crypto; D1 stores SHA-256 hashes, while raw values exist only in the confirmation URL fragment or secure cookie. Registration-confirmation links expire after 24 hours, are consumed once by a browser `POST`, and create a one-hour `HttpOnly; Secure; SameSite=Lax; Path=/` verified-email cookie. This proves recent control of an email address but does not create, look up, or link a `GuardianAccount`. Scanner GET requests cannot consume a fragment token.

Staging registration writes use two distinct temporary timings: a 20-minute provisional hold after the form/review is accepted and a fresh 24-hour initial-payment hold after email confirmation. A late confirmation atomically reacquires all requested child seats or none; if it cannot, email verification still succeeds and the parent sees current same-stage alternatives plus the original class waitlist. A single conditional D1 write checks grouped per-class demand and inserts every requested child hold only when all classes have capacity. D1 batch wraps draft, children, and that conditional statement transactionally, so a family never receives misleading partial protection. Deadline comparisons, not Cron cleanup, determine whether a hold consumes capacity.

The browser-local pre-submission draft expires after 24 hours. Server drafts expire after seven days for incomplete recovery; their 20-minute provisional hold, 24-hour confirmation link, and 24-hour payment hold are independent deadlines. Resend and email-change actions use a 60-second cooldown, invalidate superseded challenges, and never move the provisional deadline.

The future parent portal should show children, current registrations, class/time, seat-hold deadline, payment schedule/status, discounts, available credit, referral status/share link, refund options, Facebook class-group link after confirmation, and returning registration.

### Persistence/data store

The future data store should hold private operational records. It must not be represented by committed files in this public repository.

Records should preserve enough history to explain current state, especially for tuition adjustments, payment confirmations, extensions, cancellations, and payment reassignment.

### Teacher interface

The teacher interface is for daily operational work by a nontechnical user. It should optimize for a few obvious Mongolian-language actions instead of exposing database state, reconciliation adapter names, API concepts, database terminology, deployment settings, or complex configuration.

It should emphasize:

- what needs attention today
- payment confirmations
- holds nearing expiry
- due and overdue installments
- granted extensions
- quick student/family search
- spreadsheet export

Some business operations may belong in the teacher interface if they are made simple and safe, such as granting a 2-3 day extension, confirming a payment, finding a child/family, viewing outstanding tuition, and exporting current records. Technical configuration remains admin-only.

For manual payment confirmation after a Khan Bank SMS, the primary UI should be an action such as `Төлбөр орсон`, not a raw checkbox. For obvious/common matches, the action can record payment evidence immediately and show a short-lived Undo action such as `Буцаах`. If amount, date, or allocation is ambiguous, ask only for the minimum additional information needed.

When incoming payment evidence has a strong possible match, a routine phone flow may show the relevant child or children, the received amount, and the proposed allocation, then offer one clear action such as `Баталгаажуулах`. If one transfer covers several children or installments, the combined transfer and proposed allocation should be shown clearly but simply.

Complicated cases should naturally move to a desktop reconciliation view instead of forcing a dense accounting interface onto the teacher's phone.

Staff authentication is now passwordless and phone-friendly through short-lived email magic links. The schema and service boundaries remain passkey-ready, but passkeys are not implemented yet. Teacher authorization is genuinely limited through server-checked capabilities for operational actions such as confirming payment, granting short extensions, marking refunds sent, searching students, inspecting straightforward payment state, and exporting records.

### Admin interface

The admin interface is for the developer/owner and future trusted administrators. It can contain advanced configuration and technical operations such as:

- program/session setup
- tuition templates
- payment schedule templates
- discount/referral policy, stacking rules, and caps
- reminder timing
- hold expiry timing
- user and role management
- reconciliation adapter settings
- exceptional adjustments
- integrations
- raw or diagnostic exports

Migration 0007 and the staff service layer preserve this teacher/admin separation. `admin`, `teacher`, and `accountant` are normalized roles mapped to compact capabilities; every protected request reloads the active account and current role assignments. Authorization is enforced by the Worker, not merely by different visual menus.

### Content And Settings Direction

Teacher/admin authentication now protects the small annual-setup tools. They
are deliberately separate: `Хөтөлбөр` for ordered stage lessons, `Хуваарь` for
class times and dated class calendars, `Амралтын хуваарь` for year-wide breaks,
and `Тохиргоо` for typed stage/year operational settings. The first typed
setting is one Facebook group URL per academic year and stage; it is not a
per-class setting. A future Mongolian Content/Settings editor should support
quick phone edits but remain desktop-comfortable for long rules and future
yearly setup. It must stay a collection of clear operational tools, not a
generic heavyweight CMS.

### Program and academic-year calendar domain

The implemented calendar foundation keeps three concepts separate: `curriculum_program` is the ordered named lesson content for one stage/year; `ClassSession` is the registered cohort and habitual time; and a published `class_calendar_revision` is the explicit operational schedule. Weekly recurrence only generates draft candidates. It is never the source of truth after publication.

Published program and calendar revisions are immutable. Global academic-year breaks, class-specific exclusions/restores, and manual extra slots form draft planning inputs. A published calendar stores explicit `scheduled`, `no_class`, and `cancelled` dated entries, so an absent row never has to stand for a holiday, cancellation, or incomplete configuration. Every class calendar remains independent even where cohorts share the same program lesson.

Future cancellation/reflow is limited by a manual locked/delivered lesson prefix rather than wall-clock inference. Cancelling one future active slot retains cancellation history and either extends the habitual tail or lets a chronological replacement slot absorb the lesson. See [program-calendar-model.md](program-calendar-model.md) for the exact invariants and generator semantics.

The protected Mongolian annual setup uses four focused teacher tools rather
than one large editor. `Хөтөлбөр` makes and publishes ordered lessons;
`Амралтын хуваарь` records global year-wide breaks; `Хуваарь` records a class's
weekday/time/capacity and then makes its explicit dated calendar; and
`Тохиргоо` holds typed annual stage settings. A class label is generated from
stage, weekday, and start time. The teacher sees only `Бүртгэл нээлттэй` or
`Бүртгэл хаалттай`; this registration choice is separate from the immutable
draft/published calendar lifecycle. New classes start closed. A calendar change
after publication always starts from a new draft revision; a teacher can
confirm only a forward delivered prefix before a future cancellation/reflow.
Accountant capability has no access, and the Worker enforces every permission
and same-origin mutation request.

Future attendance is editable operational bookkeeping. For a concrete occurrence, the teacher should have a very simple phone-first roster with concepts such as present, late, and absent, plus a separate prior-absence-notice flag. Records must remain correctable after class and meaningful corrections must retain audit/history; they are not frozen immediately when a lesson ends.

Parents may later use a simple action such as `Хичээлд ирж чадахгүйгээ мэдэгдэх` for one specific upcoming occurrence and an optional short note. Advance notice may favor teacher consideration of a make-up, but guarantees neither a make-up nor an automatic credit. An uninformed absence creates no automatic entitlement.

The system may suggest a make-up only for a suitable future occurrence of the **same** `CurriculumLesson`, with capacity, unresolved absence, and teacher policy all considered. The teacher approves or rejects every suggestion and can override it. After approval, a later communication can be emailed, generated as concise `Messenger мессеж хуулах` text for human copy/paste, or recorded as a phone agreement. No Facebook API automation is planned. History should eventually distinguish emailed, manually Messenger-sent, phone-agreed, accepted, declined, and no-response states.

When no standard occurrence remains, the teacher may create an extra non-standard occurrence of the same lesson and see an aggregate such as `Level 2 — Lesson 7: 5 unresolved absences`. Availability coordination remains a small teacher-led phone/Messenger process, not an automated polling system.

### Future schedule communication policy

This is **future planned domain**, separate from payment reminders even if both eventually reuse the outbound-email and communication-audit foundations. Schedule notices must be event/idempotency based: one cancellation must not repeatedly email the same guardian, unrelated metadata edits must not resend notices, siblings may be grouped into one clear guardian message, and a material reschedule can create a new notice when necessary.

For an irregular cancellation/reschedule, teacher/admin may send immediate email to affected guardians and optionally generate concise Messenger copy for human sending. A replacement date/time is included only when actually known. A planned no-class/holiday entry may produce a configurable reminder roughly one or two days before the habitual class time, specifically to prevent children arriving from habit. About one day before the first lesson after a long break, a concise return reminder may include exact date/time/class. These notifications come from explicit published calendar/break policy; long-gap inference may later suggest a reminder but is not authoritative.

Make-up invitations keep their existing teacher-mediated path: the system may suggest, the teacher approves, then email and/or Messenger-copy text can be produced.

The implemented staging fixtures are explicitly fake: two cohorts per stage share a 30-lesson fake program, include short and winter breaks, a class exclusion, a break restore, and a manual extra slot. They deliberately show a Stage 2 lesson on Sunday and the following Tuesday for the other cohort. Attendance, absence, make-up, and parent notification workflows remain separate future work.

### Scheduled reminder jobs

Reminder jobs should be configurable and should operate on effective deadlines rather than only original due dates.

Initial payment reminders and later installment reminders may share scheduling machinery, but their consequences differ. An expired initial hold can release a seat. A late installment must not automatically delete or cancel a confirmed enrollment.

Later-installment reminder policy is also **future planned**. One-time payment is simplest; two installments are expected to be common; exceptional private schedules should not become normal public choices. For ordinary installments, configurable escalation should support one restrained email before the effective deadline, a teacher task that produces copyable Messenger text, and an accountant call queue after an overdue threshold. Reminder timing uses effective due dates while retaining original due dates. The initial 24-hour registration/payment hold is a different, more time-sensitive workflow.

The future copyable Messenger payment message should contain only appropriate parent/child context, amount, due date, and a first-party opaque status/payment link such as `naranerdem.com/p/<opaque-token>`. No PII or amount belongs directly in the URL, and no third-party URL shortener is needed.

### Staff authorization and future accountant queue

Migrations 0007 and 0008 implement separate staff identity, role, challenge, login-attempt, session-policy, and session foundations. Known roles are `admin`, `teacher`, and `accountant`; future scoped roles remain possible, but `assistant_teacher` is not a current role. Staff and guardian challenges, sessions, and cookies are deliberately non-interchangeable. Email links carry a random token in the URL fragment, while an initiating browser holds a separate short-lived claim secret in an `HttpOnly` cookie; D1 stores only SHA-256 hashes. A scanner or browser `GET` cannot consume the link. A same-origin `POST` approves the 15-minute attempt, but only the context with the matching claim cookie can create the staff session. A different email-reading context confirms approval and directs the person back to the original window or optional installed web app.

Public login-start responses are generic for active, unknown, guardian-only, and disabled addresses. Only an active staff account can queue email. Per-email and per-IP hourly limits plus a resend cooldown provide a basic abuse boundary; a future production rollout should add Cloudflare Turnstile and stronger edge rate limiting before enabling `STAFF_AUTH_EMAIL_ENABLED`. Staging reuses the mandatory safe-recipient override, keeping the fake intended staff identity separate from the actual test inbox. Production staff email remains disabled.

Staff sessions are persistent trusted-device cookies backed by server-authoritative role policy. Teacher defaults are 30 days of inactivity and 90 days absolute; accountant defaults are 14/60 days and admin defaults are 7/30 days. Multi-role sessions use the shortest applicable limits, the absolute deadline never slides, and meaningful `last_seen_at` writes are limited to once every six hours. Policy shortening permanently expires already-over-limit sessions. Protected requests reload current status and roles, so disabling an account or replacing its roles takes effect immediately; disabling also revokes existing sessions. Routine logout is omitted from the staff home, while audited one-session/all-session revocation remains a backend/admin operation. Privileged mutations must use non-GET methods, server-side session and capability checks, and same-origin `Origin`/`Referer` validation or a future explicit CSRF token.

The first accountant surface should be intentionally narrow: `Залгах шаардлагатай`. It is a derived live queue of overdue, teacher-approved receivables showing only the guardian, phone, relevant child/children, approved amount, effective due date/days overdue, and recent contact/reminder status. It disappears when its reason disappears, such as reconciliation, approved extension, cancellation/removal, or other approved resolution; underlying history remains.

Future accountant actions may record `Ярьсан`, `Холбогдоогүй`, a promised follow-up/payment date, or `Багштай ярилцана`. A parent's informal promise date is contact follow-up only. It does not change the effective payment deadline without teacher/admin approval.

For later withdrawal/unpaid-balance settlement, the system must not produce a legally final debt automatically from attendance. It may present clearly labeled advisory comparisons, normally centered on lessons elapsed/delivered during the active period and optionally attendance-based context. The teacher reviews tuition/pricing snapshots, adjustments, delivered/attended lessons, noticed and uninformed absences, make-ups, and received payments, then approves or edits the operational receivable. Historical received payments are never rewritten.

### Email provider

Email sending is abstracted behind an application service and a small provider interface. The initial adapter calls Resend's HTTPS API; authentication and registration code do not depend on Resend response details. Provider sends use a stable outbound-email ID to create a Resend idempotency key, and `outbound_email` is marked sent only after provider success or failed after an auditable final failure.

The planned send-only domain is `mail.naranerdem.com`, with a sender such as `Наран Эрдэм <burtgel@mail.naranerdem.com>`. It is intentionally separate from root-domain email forwarding. Do not enable Resend inbound receiving or alter the root-domain Porkbun MX/TXT forwarding records.

Email is a core parent-facing record and return path, not merely an optional notification channel. The application database remains authoritative, but milestone emails should help parents understand current status, exactly what action is needed, any relevant deadline, and a secure link back to current registration/account state.

Parent-facing milestone emails may include:

- pre-registration received
- seat hold/payment request created
- hold deadline reminder
- exceptional financial terms approved, when applicable
- exceptional request refused, when parent action is needed
- seat hold expired
- waitlist joined
- waitlist seat offer
- first payment confirmed / enrollment confirmed
- Facebook class-group link available
- later installment upcoming/due
- short extension granted
- credit earned
- refund requested/completed
- other material state changes

Do not send redundant emails for every internal technical state transition. Production keeps `EMAIL_ENABLED=false` and `AUTH_EMAIL_ENABLED=false`; registration writes also remain disabled.

Staging tests must exercise the real challenge, Mongolian template, outbound-email, provider, verification, and session path. `STAGING_EMAIL_OVERRIDE_TO` is mandatory whenever staging sending is enabled: `intended_to_email` preserves the entered address and `actual_delivery_email` is always the controlled inbox. Missing override configuration fails closed. The staging start route also requires `STAGING_AUTH_TEST_KEY` in the `X-Naran-Test-Key` header; the key is never placed in browser JavaScript or URLs, and the bypass does not exist in production.

The staging registration submit and email-change operations require Cloudflare Turnstile and validate every token server-side with Siteverify; missing, invalid, replayed, expired, and network-failed validation all fail closed. The public browser receives only a site key. Before production registration is enabled, the owner must create a production widget restricted to the production hostname, store its secret as a Worker secret, retain generic non-enumerating errors, and add broader rate-limit monitoring. A client-only bot check is never sufficient.

### Payment/reconciliation adapter

Payment evidence can come from several future sources:

- manual teacher confirmation based on Khan Bank SMS
- imported bank statement
- bank API, if available
- payment reference encoded in a bank-transfer QR
- future automated reconciliation

The adapter layer must be replaceable. Enrollment logic should work with normalized payment evidence and reconciliation decisions, not Khan Bank-specific parsing details.

#### Experimental iPhone SMS Evidence Adapter

The teacher uses an iPhone, so a future experimental adapter may be investigated:

```text
Khan Bank incoming SMS
-> iPhone personal automation
-> secure HTTPS POST
-> payment evidence ingestion endpoint
```

This route is not a dependency and is not yet known to work end-to-end with actual Khan Bank SMS contents. Before relying on it, the project needs a small proof-of-concept using the teacher's actual iPhone and a real or representative incoming-payment SMS.

Important boundaries:

- the public registration system must not depend on the teacher's phone being online
- SMS ingestion is payment evidence, not authoritative bank truth
- the SMS ingestion endpoint must not have authority to confirm enrollment, mark an installment definitively paid, alter tuition, or perform other privileged financial operations
- at most, SMS ingestion may create normalized/untrusted payment evidence or a possible incoming payment for reconciliation
- duplicate SMS delivery should be harmless and idempotent where possible
- SMS parsing must stay isolated from core enrollment and payment logic
- later bank statement/API data should be able to corroborate the same payment

### Export/reporting layer

CSV export is the minimum portable future requirement. The teacher-facing UI should eventually present one extremely simple Mongolian action such as `Excel файл татах`, even if the implementation internally produces CSV, XLSX, or another spreadsheet-compatible representation.

XLSX export may later provide cleaner workbook views for:

- enrollments
- students and guardians
- payment schedules
- received payments
- outstanding installments
- summary snapshots

Teacher exports should reflect the current operational state in a human-readable way and should not require understanding database structure. Administrator exports may include richer diagnostic or raw data when appropriate.

## Static Fallback

The current Astro configuration uses static output and a root `site` URL appropriate for the GitHub user site `https://naranerdem.github.io`.

Future backend-dependent routes should degrade gracefully. If the app is served from GitHub Pages without backend services, public content should continue to work and dynamic registration tools should show a clear unavailable state or link to an alternative process.

Creating a future temporary seat hold for a selected class must perform capacity validation and hold creation atomically. A separate availability read followed by a later insert is not sufficient.
