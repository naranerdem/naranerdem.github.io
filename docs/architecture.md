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

Parent and student rule acknowledgements are distinct product events. Ordinary annual/summer courses use two global D1-backed documents, `Эцэг эхийн журам` and `Сурагчийн журам`. Saving changed text creates a new immutable version; a matching save is a no-op. Registration drafts and canonical records retain their submitted version IDs. A page that loaded a legitimate older version remains valid after a later publication, but fabricated or wrong-document IDs are rejected. Static fallback continues to render checked-in baseline text.

Parent-facing account access should eventually be passwordless and based on verified communication channels: initially email magic links or one-time codes, and later phone/SMS codes. A guardian may have more than one verified channel. A verified channel returns the parent to durable server-side registration/account state, not an old browser tab or client session.

Before email ownership is verified, a public submission must not discover whether an email belongs to an existing guardian, retrieve existing family data, overwrite an existing guardian profile, or authoritatively link supplied data to an existing account. This preserves safe account linking for the future passwordless flow.

Migration 0003 adds one-time verification challenges and short-lived verified-email sessions; migration 0004 renames the premature referral-only input to generic `code_input`; migration 0005 links challenges/sessions to a separate server registration draft and adds per-child capacity holds and verified-draft FIFO entries. Challenge, session, and draft-access tokens use Worker Web Crypto; D1 stores SHA-256 hashes, while raw values exist only in the confirmation URL fragment or secure cookie. Registration-confirmation links expire after 24 hours, are consumed once by a browser `POST`, and create a one-hour `HttpOnly; Secure; SameSite=Lax; Path=/` verified-email cookie. Verification alone never exposes a guardian or child to the browser. After a paid draft's first installment is fully reconciled, migration 0022 may use that verified server-side normalized email for exact GuardianAccount resolution; browser-posted email is never identity authority. Scanner GET requests cannot consume a fragment token.

New staging registration writes create an initial-payment reservation at accepted submission. Its deadline is snapshotted from the typed admin `initial_payment_deadline_setting` (default 1,440 minutes / 24 hours). Email verification runs in parallel and does not create, renew, or release that reservation. An active initial-payment reservation remains capacity-consuming after its deadline until staff explicitly records payment or explicitly releases the unpaid seat; no Cron, catalog query, or cleanup routine may infer non-payment from time. Historical provisional-email rows retain their legacy conversion behavior. A single conditional D1 write checks grouped per-class demand and inserts every requested child hold only when all classes have capacity.

The browser-local pre-submission draft expires after 24 hours. Server drafts expire after seven days for incomplete recovery. New accepted registrations have an independent snapshotted payment deadline and a separately expiring confirmation link. Retention must never delete or release a financially unresolved initial-payment reservation. Resend and email-change actions use a 60-second cooldown, invalidate superseded challenges, and never move the payment deadline.

The future parent portal should show children, current registrations, class/time, payment schedule/status, discounts, available credit, referral status/share link, refund options, Facebook class-group link after confirmation, and returning registration.

### Persistence/data store

The future data store should hold private operational records. It must not be represented by committed files in this public repository.

Records should preserve enough history to explain current state, especially for tuition adjustments, payment confirmations, extensions, cancellations, and payment reassignment.

### Teacher interface

The teacher interface is for daily operational work by a nontechnical user. It should optimize for a few obvious Mongolian-language actions instead of exposing database state, reconciliation adapter names, API concepts, database terminology, deployment settings, or complex configuration.

Teacher Program and Schedule editing use a durable batch model. Individual
changes persist into an internal working revision so the teacher can reload and
resume safely. The ordinary final action is `Хадгалах`; it alone advances the
published/current state while retaining prior immutable history. A page-level
`Болих` confirms before deleting the full unsaved batch, while an inline
`Болих` only abandons the small form currently being entered. No-op saves must
not create duplicate revisions.

Attendance is the primary daily teacher workflow and appears before occasional
program, calendar, holiday, and settings tools. Individual attendance changes
use immediate local feedback with per-student rollback on failure; the Worker
remains authoritative for each audited mutation and the page does not reload
the full roster after every tap. Present and late are the ordinary controls;
late implies present. Unchecked is neutral until the scheduled end and becomes
effective absence afterward without inserting absent rows automatically.

It should emphasize:

- what needs attention today
- payment confirmations
- provisional email holds nearing expiry, and overdue unresolved initial payments
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

Teacher/admin authentication now protects a small set of operational tools.
`Сургалт, арга хэмжээ` is the entry point for annual courses, summer courses,
and one-off events; `Хөтөлбөр`, `Хуваарь`, and `Амралтын хуваарь` handle course
content and dated teaching plans; and `Тохиргоо` holds narrow typed settings.
The current communication setting is one optional Facebook group URL owned by
the concrete Offering and shared by its classes, never by an individual time
slot. A future Mongolian Content/Settings editor should support quick phone
edits but remain desktop-comfortable for long rules. It must stay a collection
of clear operational tools, not a generic heavyweight CMS.

Small public operational content is typed and D1-authoritative: center contact/prose belongs to one `public_center_information` singleton, and recommended grade guidance plus public descriptions belong to the stable Program family rather than lesson-content revisions. Teacher/admin edit this through one phone-friendly `Мэдээлэл` surface and the existing Program screen. These fields never advance curriculum revisions or alter Offering pins. GitHub Pages uses checked-in safe defaults until a future public-page composition pass consumes the D1 content.

The public site consumes one narrow unauthenticated read model that combines only center information, annual Program-family public metadata, published lesson counts, and the existing registration catalog's safe availability result. It never returns lesson titles, notes, revisions, staff records, or payment instructions. Stable public annual Program routes are `/programs/stage-1/`, `/programs/stage-2/`, and `/programs/stage-3/`. Named summer Program detail routes remain a future extension; the static site does not need dynamic routing or SSR for this initial set.

Schedule is for selecting and editing an existing class calendar. Class
creation, edit, and safe deletion belong to the selected Offering detail under
`Сургалт, арга хэмжээ`, so each class has one operational owner in the staff
interface. The real 2026–2027 school-calendar defaults are source-controlled,
explicitly imported planning guidance; staging fixtures remain visibly test
data and do not clutter the normal Holidays list.

Real curricula are proprietary operational data. D1 is their authority and the
public repository contains only fake curriculum fixtures. A whitelisted,
versioned export captures current saved Program revisions into
`/_private/operational-config/`, which Git ignores. Promotion is explicit:
export staging, review counts/checksum, dry-run the target, then use the
production confirmation flag. Importing changed content creates and selects a
new immutable Program revision; unchanged content is a no-op and existing
Offerings retain their pinned revision. Private bundles, lesson content, and
internal notes must not be copied to public logs.

### Program, Offering, class, and calendar domain

The durable hierarchy is `Program family -> CurriculumProgram revision ->
ActivityOffering -> ClassSession -> ClassCalendar`. A logical Program family is
the stable teacher-recognized identity; its current published revision is
ordered lesson content. Offering is one concrete annual course, summer
intensive, or event, with a period, pinned program revision, charge mode,
calendar guidance, and Facebook group. ClassSession
is a course cohort/time option. A published calendar revision is the explicit
operational schedule. Programless events use a narrow event occurrence rather
than a fake one-lesson curriculum.

Class meeting rules support weekly, weekdays, and daily draft generation using
Mongolia-local civil dates. The selected class inherits its Offering program;
calendar generation does not ask the teacher or API caller to choose that
program again. A new annual Offering selects only a stage; the server resolves
that logical Program family's current revision and uses Offering dates to derive
the configured academic-year context. A summer Offering selects a named summer
Program family. Existing Offerings retain their exact revision after later
publication. Raw revision IDs remain internal compatibility/history data.
Annual and summer courses are always paid; events are normally free but
the teacher may mark an event paid. The Offering owns that charge state, not
the event occurrence. School-calendar periods apply automatically to annual
courses only. Each period independently controls initial candidate exclusion
and overlap warnings; changing either never rewrites an explicit calendar.
Recurrence remains only a draft generator and never replaces explicit published
dated occurrences.

Published program and calendar revisions remain immutable. Class-specific
exclusions/restores and manual extra slots remain planning inputs. A published
calendar records explicit `scheduled`, `no_class`, and `cancelled` entries, so
absence never ambiguously means holiday, cancellation, or incomplete setup.
Every class calendar remains independent even where cohorts share one Offering
program.

The unauthenticated published-calendar API exposes only the public class/date,
time, and teaching-state information needed by its preview. It does not join or
return curriculum lessons, sequence numbers, internal notes, or Program-family
data. Full Program content remains behind staff authentication and the
`calendar.view` capability; the accountant role does not have that capability.

The teacher Program editor presents this as ordinary `Засах` then `Хадгалах`.
Saving still creates and atomically selects an immutable Program revision;
existing Offerings retain their pinned historical revision. Lesson titles are
edited inline, while insert-before, append, delete, and move actions keep the
ordered sequence contiguous without a teacher entering sequence numbers.

The Program screen begins as a neutral annual/summer list and shows an
explicitly opened Program detail below both lists. The Schedule screen likewise
begins with a compact class/calendar overview, then shows one explicitly opened
class's chronological calendar below it. A future row's `⋯` actions create or
resume the internal change draft automatically, give a short consequence
preview, and use ordinary `Хадгалах`; teacher UI does not expose draft,
publish, revision, or sequence-lock terminology. Normal rescheduling is
structural: make one active slot no-class, add another slot if needed, and let
the ordered lesson-to-slot mapping reflow. A school-calendar skip can be
restored for one class with a warning governed by that period's current
guidance. Offering-wide course pauses remain a compact `Тусгай өөрчлөлт`; they
affect every class in the Offering and cannot be silently overridden per class.
Annual planning and one-class planned maintenance stay on Schedule.
`/staff/day-changes/` is the separate daily entry point for unexpected
cancellations, whole-day closures, replacement days, and extra dates. It
preflights every affected class, writes whole-day changes all-or-none, and
reuses the same immutable calendar-revision and ordered-slot behavior.

Ordinary post-publication drafts automatically protect the greater of the
stored internal lock, all published lesson assignments whose local teaching
date is already past, and the highest current attendance mark for that class's
pinned Program. This is historical schedule protection, not a claim that the
lesson was delivered. The teacher no longer sees or confirms a raw
completed-sequence boundary. Safe future cancellation retains history and
reflows only future lessons. A summer Offering's planned end is soft guidance:
an overrun is warned rather than silently dropping a lesson. An annual
Offering instead derives its actual end from the explicit calendar. The annual
start date is editable per Offering but prepopulated from the typed, admin-only
global month/day default (initially October 1). See
[program-calendar-model.md](program-calendar-model.md).

New course classes and event occurrences always start with registration closed.
Human class labels are generated from annual stage/weekday/time or summer
period/time. An unused class exposes deletion only in its edit details; durable
references suppress hard deletion. Accountant capability has no access, and
the Worker enforces every permission and same-origin mutation request.

An Offering may be paid, scheduled, and registration-closed before pricing is
configured. Course pricing belongs in Offering detail under `Төлбөрийн нөхцөл`,
not compact creation. Annual and summer courses use a required positive integer
MNT one-time amount and may additionally expose a two-installment plan with
positive first/second amounts and an explicit Mongolia-local due date. The
Offering is the source for new requests only: accepting a registration stores
the selected plan and amounts per child, so later edits never rewrite an
existing family's terms. Events and discounts remain outside this foundation.

Opening a course class is server-gated on valid Offering pricing and completed
teacher/admin-managed operational payment collection information. The parent catalog exposes only safe
plan amounts; bank name, account holder, optional IBAN, account number, and optional transfer
instruction appear after accepted submission creates the initial-payment
reservation with a 24-hour payment deadline. Initial payment confirmation and allocation reconciliation are
implemented; adjustments, credits/refunds, bank adapters, and broader finance
queues remain deliberately unimplemented.

Migration 0023 adds explicit teacher-managed `RegistrationWindow` membership
for ordinary public registration. A class is newly registerable only when its
active annual/summer Offering belongs to at least one window whose inclusive
date range contains the current `Asia/Ulaanbaatar` civil date, pricing and
payment collection are ready, and its existing per-class registration safety
switch remains open. The window never replaces that class switch. The retained
`academic_year.registration_status` compatibility field is not an additional
ordinary public-registration gate. Past windows
are read-only, active windows retain their start date, and reopening is a new
window. Expiry affects only new public acceptance: already accepted drafts,
email verification, payment holds, waitlists, and canonical promotion continue
under their existing durable state.

Course attendance is now editable operational bookkeeping for normal annual and
summer course occurrences. `/staff/attendance/` is a simple phone-first daily
roster with present/late checkboxes and a separate teacher-recorded prior
absence notice. After class end an unchecked student is effectively absent;
before then the student remains unmarked and creates no downstream absence
consequence. Each tap saves immediately; corrections and clearing remain
auditable and no attendance action creates a calendar revision. Attendance uses
the stable class-plus-immutable-lesson identity rather than a revision-scoped
calendar slot. Events, parent-submitted notices, and attendance-derived
financial conclusions are still not implemented.

Effective absence remains derived after class end; the roster stays visually
stable and does not add a red row-level `Ирээгүй` label. `/staff/makeups/`
retains unresolved, scheduled, and `Нөхөхгүй` teacher decisions. A no-makeup
decision remains visible and can be reopened without deleting audit history.

Event attendance is a separate, simpler future record: `attended`, `did not
attend`, and an optional short note. It must not be forced through course
absence-notice, same-lesson make-up, or make-up-invitation semantics.

Parents may later use a simple action such as `Хичээлд ирж чадахгүйгээ мэдэгдэх` for one specific upcoming occurrence and an optional short note. Advance notice may favor teacher consideration of a make-up, but guarantees neither a make-up nor an automatic credit. An uninformed absence creates no automatic entitlement.

`/staff/makeups/` derives its unresolved queue only from effective absences after
the source occurrence ends. The teacher either chooses `Нөхөхгүй`, assigns the
student to a future class occurrence of the exact same immutable
`CurriculumLesson` with capacity, or creates a separate same-lesson special
occurrence. Normal assignments use class plus lesson identity, so they follow a
safe target-calendar date reflow. Correcting source attendance to present or
late invalidates the active make-up decision without deleting history. This
foundation changes neither enrollment nor source attendance and sends no
message or financial consequence.

When no standard occurrence remains, the teacher may group compatible
same-lesson absences into one capacity-limited special occurrence. Parent
acceptance, invitation delivery, completion attendance, and make-up finance
remain future work.

### Future schedule communication policy

This is **future planned domain**, separate from payment reminders even if both eventually reuse the outbound-email and communication-audit foundations. Schedule notices must be event/idempotency based: one cancellation must not repeatedly email the same guardian, unrelated metadata edits must not resend notices, siblings may be grouped into one clear guardian message, and a material reschedule can create a new notice when necessary.

For an irregular cancellation/reschedule, teacher/admin may send immediate email to affected guardians and optionally generate concise Messenger copy for human sending. A replacement date/time is included only when actually known. A planned no-class/holiday entry may produce a configurable reminder roughly one or two days before the habitual class time, specifically to prevent children arriving from habit. About one day before the first lesson after a long break, a concise return reminder may include exact date/time/class. These notifications come from explicit published calendar/break policy; long-gap inference may later suggest a reminder but is not authoritative.

Make-up invitations keep their existing teacher-mediated path: the system may suggest, the teacher approves, then email and/or Messenger-copy text can be produced.

The implemented staging fixtures are explicitly fake. Annual stages retain two
weekly cohorts sharing one 30-lesson example program and exercise breaks,
restore/exclusion, extra slots, and independent progress. A fake 12-lesson
summer Offering exercises weekday and daily scheduling. Events are created only
when needed and are isolated in service tests, not shown as routine list
fixtures. Production is schema-only and receives none of these records.
Parent-submitted absence, make-up communication/completion, event attendance,
public summer/event registration, finance, and parent notification workflows
remain separate future work.

### Scheduled reminder jobs

Reminder jobs should be configurable and should operate on effective deadlines rather than only original due dates.

Initial payment reminders and later installment reminders may share scheduling machinery, but their consequences differ. An overdue initial payment is a teacher reconciliation item, not an automatic release. A late installment must not automatically delete or cancel a confirmed enrollment.

Later-installment reminder policy is also **future planned**. One-time payment is simplest; two installments are expected to be common; exceptional private schedules should not become normal public choices. For ordinary installments, configurable escalation should support one restrained email before the effective deadline, a teacher task that produces copyable Messenger text, and an accountant call queue after an overdue threshold. Reminder timing uses effective due dates while retaining original due dates. The initial 24-hour registration/payment hold is a different, more time-sensitive workflow.

The future copyable Messenger payment message should contain only appropriate parent/child context, amount, due date, and a first-party opaque status/payment link such as `naranerdem.com/p/<opaque-token>`. No PII or amount belongs directly in the URL, and no third-party URL shortener is needed.

### Staff authorization and future accountant queue

Migrations 0007 and 0008 implement separate staff identity, role, challenge, login-attempt, session-policy, and session foundations. Known roles are `admin`, `teacher`, and `accountant`; future scoped roles remain possible, but `assistant_teacher` is not a current role. Staff and guardian challenges, sessions, and cookies are deliberately non-interchangeable. Email links carry a random token in the URL fragment, while an initiating browser holds a separate short-lived claim secret in an `HttpOnly` cookie; D1 stores only SHA-256 hashes. A scanner or browser `GET` cannot consume the link. A same-origin `POST` approves the 15-minute attempt, but only the context with the matching claim cookie can create the staff session. A different email-reading context confirms approval and directs the person back to the original window or optional installed web app.

Public login-start responses are generic for active, unknown, guardian-only, and disabled addresses. Only an active staff account can queue email. Per-email and per-IP hourly limits plus a resend cooldown provide a basic abuse boundary; a future production rollout should add Cloudflare Turnstile and stronger edge rate limiting before enabling `STAFF_AUTH_EMAIL_ENABLED`. Fake staging staff continue to use the mandatory safe-recipient override. An explicitly provisioned, non-test staging staff identity may receive its own login email; public/parent test mail and fake staff never bypass the override. Production staff email remains disabled.

Staff sessions are persistent trusted-device cookies backed by server-authoritative role policy. Teacher defaults are 30 days of inactivity and 90 days absolute; accountant defaults are 14/60 days and admin defaults are 7/30 days. Multi-role sessions use the shortest applicable limits, the absolute deadline never slides, and meaningful `last_seen_at` writes are limited to once every six hours. Policy shortening permanently expires already-over-limit sessions. Protected requests reload current status and roles, so disabling an account or replacing its roles takes effect immediately; disabling also revokes existing sessions. Routine logout is omitted from the staff home, while audited one-session/all-session revocation remains a backend/admin operation. Privileged mutations must use non-GET methods, server-side session and capability checks, and same-origin `Origin`/`Referer` validation or a future explicit CSRF token.

`/staff/team/` is the admin-only `Ажилтнууд` surface. It creates and edits the
existing normalized staff identities, enables/disables access, and revokes all
sessions. Migration 0017 gives one account up to three globally unique login
addresses. Any alias authenticates the same account; one is primary only for
display and compatibility. Adding an alias or changing the primary address
does not revoke account-scoped sessions. Removing an alias invalidates pending
links for that address, while disabling an account revokes all sessions. Role,
address, and status changes are audited and immediately authoritative. The
final active admin cannot be disabled or demoted. Staging and production
identities, aliases, and sessions are independently provisioned and are never
copied between environments.

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

Teacher-facing registration operations live under `Бүртгэл, төлбөр`; public-window setup remains the separate, secondary `Бүртгэлийн хугацаа` surface. A manual `Төлбөр орсон` immediately preserves the received-payment evidence and allocation, then creates a durable tentative confirmation with a snapshot `finalize_after`. A Workers Cron handler finalizes due confirmations; it is never an in-memory timer. The narrow admin-only `payment_confirmation_grace_setting` controls future snapshots only (default five minutes). Undo before finalization leaves no enrollment or confirmation email consequence. After finalization, normal correction must remain audited and use transaction-scoped parent communication.

When an explicitly released reservation has received money, its received-payment history is retained and the unconsumed amount becomes explicit `payment_credit`. It can later be allocated only through an audited operation or marked as manually refunded; matching text contact data is never sufficient for automatic cross-registration allocation.

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

CSV export is the minimum portable future requirement. Current private Program
and schedule reports provide `Хэвлэх / PDF` and `Excel-д хуулах`; the latter
copies human-readable TSV from the same report model. A future downloadable
operational export should still present one simple action such as `Excel файл
татах`, even if it internally produces CSV, XLSX, or another compatible format.

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
## Registration contact and payment lifecycle

An accepted public registration creates its initial-payment reservation and a snapshotted payment deadline immediately. Email verification is an independent contact-channel fact: it enables trusted email communication but does not gate payment instructions, staff reconciliation, or enrollment promotion. A future verified phone/SMS channel follows the same principle; guardian access is based on verified communication channels, not email alone.

An unverified email is never used to match an existing guardian account. If a paid draft is promoted before email verification, it receives a distinct guardian identity that can be reconciled later through a verified channel and staff review. Payment requests retain opaque internal IDs; parents receive a human transfer description based on child name and full guardian phone, with a small suffix only for concurrent collisions.

An unverified submitted email may still receive messages scoped only to that registration, including receipt and payment-instruction communications. Delivery failure is retained as outbound-email operational state; it does not establish or invalidate identity. Future `/parent/` login will send a fresh challenge which both verifies the chosen email or phone channel and creates the parent session. Registration screens must not put raw contact values into public URL parameters.
