# Naran Erdem

Website and future registration application for a small Children's Science Center in Mongolia.

This repository is intentionally named `naranerdem.github.io` so one canonical codebase can support:

- primary deployment through Cloudflare Workers Static Assets
- a simple static fallback at `https://naranerdem.github.io`

The project remains deliberately small. It contains a static Astro site, a D1-backed read-only catalog, and disabled-by-default email-verification plumbing. It does not yet submit registrations, create parent accounts, process payments, send production email, or integrate with a bank.

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

Cloudflare deployment is configured in `wrangler.jsonc`. Use `npm run deploy:cloudflare` for production and `npm run deploy:cloudflare:staging` for the separate staging Worker at `https://naran-erdem-staging.naranerdem-github-io.workers.dev`. Static assets remain asset-first. Registration writes remain disabled in both environments, and email/auth sending remains disabled until the documented secrets, safe staging override, and feature flags are deliberately configured.

Sensitive runtime values belong in Cloudflare Worker secrets, never source control: `RESEND_API_KEY`, `STAGING_EMAIL_OVERRIDE_TO`, and `STAGING_AUTH_TEST_KEY`. The planned sending domain is `mail.naranerdem.com`; keep existing root-domain MX/TXT forwarding records unchanged and do not enable Resend inbound receiving.

Future backend services should be designed so public pages still work as a static site. Registration, tuition, reminders, reconciliation, and exports may become unavailable in fallback mode, but the public website should not fail to render.

## Architecture

The planned system has separate boundaries for:

- public/static website
- registration/backend application
- persistence/data store
- teacher interface
- admin interface
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

## Editing Public Content

For small wording, phone, address, schedule, or future price edits, see [EDITING.md](EDITING.md). Public Mongolian wording is kept in `src/content/`; current academic-year data is kept in `src/config/academic-year.ts`.

## Privacy

Children's registration records, private exports, bank data, credentials, API keys, authentication secrets, and operational data must never be committed to the public repository.

The `.gitignore` includes placeholder private data paths, but the main protection should be architectural: real operational data belongs in a private datastore or controlled export location, not in source control.
