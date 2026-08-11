# Staff Authentication Foundation

## Boundary

Staff identity is separate from parent identity. A staff email address never creates, looks up, or links a `guardian_account`; parent verification cookies cannot authenticate staff routes, and staff cookies cannot authorize parent registration routes.

The public `/staff/` page is Mongolian and phone-first. Before session bootstrap completes it shows only a neutral loading state. Unknown, guardian-only, disabled, and active addresses receive the same public login-start response. Only an active `staff_account` queues an email.

## Roles And Capabilities

The normalized roles are exactly `admin`, `teacher`, and `accountant`. There is no `assistant_teacher` role.

| Role | Current capability groups |
| --- | --- |
| `admin` | all current admin, program, calendar, registration, payment, and accountant capabilities |
| `teacher` | program/calendar view and management; registration view and management; payment view, management, and extension |
| `accountant` | payment view; call-queue view; contact recording |

Protected Worker routes resolve the staff session and then reload the account's active status and current roles. Server capability checks are authoritative; UI labels are only a convenience. The proof routes under `/api/staff/proof/*` demonstrate 401, 403, and allowed behavior without implementing business mutations.

## Magic Links And Sessions

- Staff login challenges and sessions use their own tables and cookie.
- Raw 32-byte random tokens exist only in the email link fragment or browser cookie.
- D1 stores SHA-256 hashes, never raw tokens.
- A link lasts 15 minutes, is consumed once by `POST`, and is superseded by a later successful resend.
- A scanner or browser `GET` cannot consume the fragment token.
- Reopening a used link in the same browser is friendly only when that browser still has the matching active staff session. Otherwise the page gives a generic used/expired state.
- Staff sessions last 10 hours and use `HttpOnly; Secure; SameSite=Lax; Path=/`.
- Logout revokes the session. Disabling staff invalidates access immediately through the live account join.

This is intentionally a finite session, not a refresh-token architecture. The schema can later add passkey credentials without changing staff identity, roles, or capability checks.

## Email Safety

Staff email uses the existing provider interface, Resend adapter, `outbound_email` ledger, sender domain plan at `mail.naranerdem.com`, and stable idempotency keys. Staging requires `STAGING_EMAIL_OVERRIDE_TO`: the fake `@example.invalid` staff address remains `intended_to_email`, while only the safe inbox becomes `actual_delivery_email`. Missing staging override fails closed. `STAGING_AUTH_TEST_KEY` is unrelated to ordinary staff login and is never accepted as staff authentication.

Production keeps `STAFF_AUTH_EMAIL_ENABLED=false`. Before enabling a public production login-start sender, add Cloudflare Turnstile with server-side verification and stronger edge/cooldown monitoring while retaining generic non-enumerating responses.

## Provisioning And Audit

Use `npm run staff:create` with explicit `--env`, `--email`, `--name`, and `--role`. Staging permits only `@example.invalid` intended identities. Production additionally requires `--confirm-production`. The command is idempotent for an existing email/role, writes no credentials, and records account-creation and role-assignment audit events.

Future staff-management routes must call the administration service so role replacement and enable/disable actions are capability checked and audited. Successful login and logout/revocation are also audited. Raw tokens, API keys, and noisy failed-login details are excluded.

## Mutation Safety

Privileged changes must never use `GET`. Every mutation must validate the staff session and required capability server-side, then validate same-origin `Origin`/`Referer` or a dedicated CSRF token. Menus, hidden controls, and client-side role checks are not authorization.
