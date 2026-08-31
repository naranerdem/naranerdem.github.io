# Naran Erdem

Website and future registration application for a small Children's Science Center in Mongolia.

This repository is intentionally named `naranerdem.github.io` so one canonical codebase can support:

- primary deployment through Cloudflare Workers Static Assets
- a simple static fallback at `https://naranerdem.github.io`

The project remains deliberately small. It contains a static Astro site, a D1-backed catalog, a staging-only test registration flow with email confirmation, and a separate staff passwordless-authentication foundation. Production still does not submit registrations, create parent accounts, process payments, send email, or integrate with a bank.

## Tech Stack

- Astro
- TypeScript
- Static output
- No client-side framework by default

Astro is used in static mode so the public site can still build and serve even when future backend-dependent registration features are unavailable.

## Local Development

Install dependencies:

```sh
npm install
```

Start the local development server:

```sh
npm run dev
```

Check the project:

```sh
npm run check
```

Build the static site:

```sh
npm run build
```

Preview the production build:

```sh
npm run preview
```

## Deployment Direction

`https://naranerdem.com` is the primary production site. Cloudflare Workers Static Assets hosts the production domain, while the `workers.dev` URL remains useful for development and testing.

GitHub Pages remains a fallback. Because this is a GitHub user site repository named `naranerdem.github.io`, the static site is configured for the root path instead of a project subpath.

GitHub Pages deployment is handled by GitHub Actions on every push to `main`, with a manual workflow option also available. In the GitHub repository UI, Settings → Pages must use `GitHub Actions` as the source. Cloudflare remains the intended future host for backend-dependent functionality.

Cloudflare deployment is configured in `wrangler.jsonc`. Use `npm run deploy:cloudflare:staging` for the separate staging Worker at `https://naran-erdem-staging.naranerdem-github-io.workers.dev`. Production commands deliberately require explicit confirmation: `npm run deploy:cloudflare -- --confirm-production` and `npm run migrate:cloudflare -- --confirm-production`. Static assets remain asset-first. Staging enables explicitly test-marked registration drafts, Turnstile test validation, safe-recipient email confirmation, and staff-login testing. Production keeps registration writes and parent/staff email sending disabled with `REGISTRATION_WRITE_ENABLED=false`, `AUTH_EMAIL_ENABLED=false`, and `STAFF_AUTH_EMAIL_ENABLED=false`.

Use [docs/production-release.md](docs/production-release.md) for the production release and rollback procedure.

Sensitive runtime values belong in Cloudflare Worker secrets, never source control: `RESEND_API_KEY`, `STAGING_EMAIL_OVERRIDE_TO`, `STAGING_AUTH_TEST_KEY`, and any future production `TURNSTILE_SECRET_KEY`. Staging uses Cloudflare's published Turnstile test credentials; the browser receives only the site key. The sending domain is `mail.naranerdem.com`; keep existing root-domain MX/TXT forwarding records unchanged and do not enable Resend inbound receiving.

Staging test registrations can be inspected or removed by exact test-run ID with `npm run cleanup:registration:staging -- --test-run-id=registration:<draft-uuid>`. Cleanup is a dry run unless `--confirm` is added and refuses production.

Staff accounts are separate from parent accounts. Administrators use the protected `Ажилтнууд` tool for ordinary account management, including up to three login email addresses per account; the explicit `npm run staff:create` command remains for bootstrap/recovery. Real staging addresses require `--allow-real-email`, and production provisioning requires `--confirm-production`. Staging and production identities remain separate. The phone-first staff surface can optionally be installed from `/staff/` as a Home Screen web app; authentication remains server-authoritative and each browser/app context keeps its own session. Teachers and admins have protected daily attendance, make-up, and course-day change tools plus private Program/schedule print/TSV reports; accountants do not. See [docs/staff-authentication.md](docs/staff-authentication.md) for the approval flow, session policy, and capability matrix.

Future backend services should be designed so public pages still work as a static site. Registration, tuition, reminders, reconciliation, and exports may become unavailable in fallback mode, but the public website should not fail to render.

## Architecture

The planned system has separate boundaries for:

- public/static website
- registration/backend application
- persistence/data store
- teacher interface
- admin interface
- staff authentication and capability authorization
- scheduled reminder jobs
- email provider
- payment/reconciliation adapter
- export/reporting layer

See [docs/architecture.md](docs/architecture.md) for the high-level boundary plan.

## Language Policy

Mongolian is the product language, not an optional locale. Public website UI, registration UI, parent/student-facing messages, teacher operational screens, and future automated emails/reminders should be in Mongolian.

Code identifiers, TypeScript types, database/property names, and technical documentation should remain in English. Advanced administrator/developer interfaces may use English where technical English is clearer, while user/content data naturally remains Mongolian.

Do not add a heavyweight multilingual/i18n system unless the product direction changes. Keep important user-facing strings lightly organized so future operational wording is not scattered through implementation code.

## Registration and Tuition Model

The registration domain is documented before implementation so the future app preserves the distinction between applications, temporary seat holds, confirmed enrollments, tuition schedules, payment evidence, extensions, and waitlists.

See [docs/registration-model.md](docs/registration-model.md).

The protected staff setup starts with `Сургалт, арга хэмжээ`, then uses
`Хөтөлбөр`, `Хуваарь`, `Амралтын хуваарь`, and a small typed `Тохиргоо` screen.
It supports annual courses, summer intensives, and one-off events while keeping
published course calendars as explicit dated records. Facebook groups and
school-break policy belong to the concrete Offering. Real curricula are private
staging D1 data; automated fixtures remain explicitly fake. Production has no
curriculum, Offering, class, event, or calendar configuration. See
[docs/program-calendar-model.md](docs/program-calendar-model.md).

The checked-in `src/config/operational-defaults.mjs` contains only public
school-calendar guidance. It is imported explicitly, never during deployment:

```sh
npm run seed:operational-defaults -- --env=staging
npm run seed:operational-defaults -- --env=production --confirm-production
```

Real Program content lives in D1 and git-ignored private bundles. The operator
workflow is: edit/review in staging, export a fresh bundle, inspect its counts
and checksum, dry-run the target, then explicitly import it. Production import
always requires the confirmation flag:

```sh
npm run export:private-config -- --env=staging
npm run import:private-config -- --env=production --file=<private-bundle.json> --dry-run
npm run import:private-config -- --env=production --file=<private-bundle.json> --confirm-production
```

Never copy staging D1 wholesale, commit a private bundle, or print its lesson
content in public logs. Private imports create immutable revisions and do not
move existing Offerings from the revisions they already use.

## Editing Public Content

For small wording, phone, address, schedule, or future price edits, see [EDITING.md](EDITING.md). Public Mongolian wording is kept in `src/content/`; current academic-year data is kept in `src/config/academic-year.ts`.

## Privacy

Children's registration records, private exports, bank data, credentials, API keys, authentication secrets, and operational data must never be committed to the public repository.

The `.gitignore` explicitly excludes `/_private/operational-config/`, but the
main protection is architectural: real curricula and other operational data
belong in a private datastore or controlled export location, not source control.
