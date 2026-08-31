# Production Release

This runbook is for `naranerdem.com`. It is deliberately separate from staging.

## Environments

- **Local:** source code and disposable local D1 test state.
- **Staging:** `naran-erdem-staging` with fake/rehearsal records, Turnstile test keys, and a safe email-recipient override.
- **Production:** `naran-erdem-production` and `naranerdem.com`, with only reviewed real operational configuration and real staff identities.

Never copy staging D1, fixtures, secrets, staff sessions, or rehearsal records into production. Production is never the first environment for a new feature or workflow.

## Normal Release

### Pre-release

- Confirm `main`, the intended commit, and `git status --short`.
- Run the relevant local tests, at minimum `npm run check`, `npm run build`, and `git diff --check`.
- Deploy and rehearse the change in staging first: `npm run deploy:cloudflare:staging`.
- Review pending production migrations without applying them:
  `npx wrangler d1 migrations list DB --remote`.
- Require additive/backward-compatible migrations. Any destructive or incompatible migration needs its own reviewed plan.
- Record the live Worker deployment: `npx wrangler deployments list`.
- If a migration is involved, record a D1 Time Travel bookmark immediately before it:
  `npx wrangler d1 time-travel info DB --timestamp=<RFC3339-now> --json`.
- Review production release gates, operational configuration, staff access, and any relevant sender/Turnstile setup.

### Release

- Apply only reviewed migrations:
  `npm run migrate:cloudflare -- --confirm-production`.
- Recheck the migration ledger:
  `npx wrangler d1 migrations list DB --remote`.
- Deploy the intended Worker build:
  `npm run deploy:cloudflare -- --confirm-production`.
- Record the resulting Worker version from `npx wrangler deployments list`.
- Enable a feature only when it is separately reviewed. Code deployment and a major operational gate need not happen together.

### Post-release

- Check `/`, `/api/health`, `/register/`, and `/api/registration/catalog`.
- Confirm the public registration gate has the intended state.
- Check staff login and the registration/payment surface with an approved staff account.
- Read capacity and waitlist state through the staff projection; do not alter real data merely as a smoke test.
- If email is enabled, check the provider/audit health using a controlled plan rather than sending unsolicited parent messages.
- Review Worker errors/logs. Record the deployed version and any incident notes.

## Migration Policy

Default to **expand -> migrate -> contract**:

1. Add new tables, nullable columns, indexes, or typed settings compatibly.
2. Deploy code that understands both old and new representations.
3. Backfill or migrate deliberately when necessary.
4. Remove old representations only in a later, separately reviewed release.

Do not use D1 restore as routine code rollback. A Worker rollback must remain compatible with every already-applied production migration. Any destructive data change needs an explicit backup/recovery and validation plan.

## Release Gates

Current gates are `REGISTRATION_WRITE_ENABLED`, `EMAIL_ENABLED`, `AUTH_EMAIL_ENABLED`, and `STAFF_AUTH_EMAIL_ENABLED`. Keep them disabled until the related production configuration and rehearsal are explicitly approved. Future gates should stay narrow and typed; do not add a generic feature-flag system.

The guarded `npm run` commands are the normal production path. Direct `wrangler deploy` and `wrangler d1 migrations apply` commands bypass those local confirmation guards and are privileged/manual incident or recovery commands only.

## Launch Prerequisites

Code readiness does not enable either public boundary. Complete and rehearse the following external configuration before changing a production gate.

- **Public registration:** create a production Turnstile widget restricted to `naranerdem.com`, configure its public site key and Worker secret, then leave `REGISTRATION_WRITE_ENABLED=false` until the complete registration/payment rehearsal is approved.
- **Staff login:** create a separate production staff-login Turnstile widget and Worker secret, retain the `STAFF_LOGIN_RATE_LIMITER` Worker binding, configure the staff email sender/provider, and leave `STAFF_AUTH_EMAIL_ENABLED=false` until an approved staff identity completes the rehearsal.

The committed Worker rate limit is eight login-start attempts per key per 60 seconds, before email work. The existing per-email/per-IP hourly limits and resend cooldown remain additional safeguards. Production gate readiness also fails closed if the staff-login rate-limit binding is absent.

## Emergency Rollback

1. Record the failing Worker version with `npx wrangler deployments list`.
2. Roll back code first, using a known compatible version:
   `npx wrangler rollback <version-id> --message="<reason>"`.
3. Verify `/`, `/api/health`, and the affected operational path.
4. Do **not** restore D1 just because code was bad.
5. For actual data corruption or a bad data migration only, use the recorded bookmark or timestamp:
   `npx wrangler d1 time-travel restore DB --bookmark=<bookmark>`.
6. Record the incident, versions, migration state, and follow-up.

`wrangler versions view <version-id>` shows a specific Worker version. D1 Time Travel is emergency recovery, not ordinary rollback.
