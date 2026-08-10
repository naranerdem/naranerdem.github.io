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

On Cloudflare, static assets remain asset-first. A small Worker API runs only for `/api/*`, with D1 access kept in an explicit service layer. The currently deployed API is deliberately read-only (`/api/health` and `/api/registration/catalog`); registration writes remain disabled in production and staging. The separately deployed staging Worker uses the staging D1 database and has no custom domain.

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

Ordinary registration selects one concrete class per child. Future class availability and seat-hold creation must use that selected class atomically. A full class uses a simple FIFO waitlist for that same class; ranked alternative-class choices are not part of the public model.

Parent and student rule acknowledgements are distinct product events. The current prototype keeps them as separate client-side state only; a real submission must persist versioned acknowledgements with the application.

Parent-facing account access should eventually be passwordless, based on verified email magic links or one-time codes. Email links should return the parent to durable server-side registration/account state, not rely on an old browser tab or client session remaining alive.

Before email ownership is verified, a public submission must not discover whether an email belongs to an existing guardian, retrieve existing family data, overwrite an existing guardian profile, or authoritatively link supplied data to an existing account. This preserves safe account linking for the future passwordless flow.

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

Teacher authentication should eventually be strong and phone-friendly, preferably passkey/device-biometric or similarly passwordless. Teacher authorization must be genuinely limited to operational actions such as confirming payment, granting short extensions, marking refunds sent, searching students, inspecting straightforward payment state, and exporting records.

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

Authentication is not implemented yet, but future routes and modules should preserve this teacher/admin separation. Admin authentication should also prefer strong passkey/passwordless access. Teacher and admin must have different authorization permissions, not merely different visual menus.

### Scheduled reminder jobs

Reminder jobs should be configurable and should operate on effective deadlines rather than only original due dates.

Initial payment reminders and later installment reminders may share scheduling machinery, but their consequences differ. An expired initial hold can release a seat. A late installment must not automatically delete or cancel a confirmed enrollment.

### Email provider

Email sending should be abstracted behind an application service. Registration logic can ask for a reminder or notification to be sent without depending directly on a specific provider.

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

Do not send redundant emails for every internal technical state transition. No email provider is implemented in this foundation.

Staging must still exercise the real future email generation and provider path. Test/staging status should not suppress milestone emails or skip workflow logic. Instead, staging delivery should preserve both the intended parent-entered recipient and the actual safe test inbox used for delivery override.

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
