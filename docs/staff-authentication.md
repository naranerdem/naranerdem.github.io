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
- Raw 32-byte random tokens exist only in the email link fragment or browser cookies.
- D1 stores SHA-256 hashes, never raw tokens.
- Migration 0008 separates email approval from session claiming. The initiating browser receives an opaque claim secret in a short-lived `HttpOnly` cookie; the email challenge approves that server-side attempt, and only a browser with the matching claim cookie can create the staff session.
- A link and its fixed login attempt last 15 minutes. Resending may reuse the same pending attempt but never extends its original expiry.
- A scanner or browser `GET` cannot consume the fragment token.
- Opening the link in the initiating browser approves and claims in one step. Opening it in another browser or mail app only shows `Нэвтрэх хүсэлт баталгаажлаа.` and tells the person to return to the original window or installed Naran Erdem app. It does not transfer authentication to the email-reading browser.
- The initiating page checks the claim endpoint every four seconds only while visible. This narrow endpoint accepts no attempt ID and does not refresh an existing staff session.
- Unknown, guardian-only, and disabled addresses can receive an indistinguishable non-authenticating waiting attempt, but no email or claimable staff identity.
- Staff session cookies are persistent and use `HttpOnly; Secure; SameSite=Lax; Path=/`. D1 remains authoritative, so copying, lengthening, or retaining a cookie cannot bypass expiry or revocation.

## Session Policies

Session policy is stored per role and has both inactivity and absolute limits. Defaults are:

| Role | Inactivity | Absolute maximum |
| --- | ---: | ---: |
| `teacher` | 30 days | 90 days |
| `accountant` | 14 days | 60 days |
| `admin` | 7 days | 30 days |

A multi-role staff member receives the shortest limit in each column. The absolute deadline never slides. Meaningful protected use may advance `last_seen_at`, with writes throttled to once every six hours; login-attempt polling is not meaningful activity. The protected `/staff/settings/auth/` page lets an administrator update all three policies within server-enforced bounds. Shortening applies to existing sessions immediately and permanently marks already-over-limit sessions expired, so later lengthening cannot resurrect them.

Multiple devices may keep independent sessions. Backend operations can revoke one session or all sessions for an account; disabling an account revokes all active sessions and cancels pending login attempts. Routine visible logout is intentionally omitted from the phone-first staff home because these are trusted-device sessions, while revocation remains available to administration and future device-management UI.

This is still a finite server-side session model, not a refresh-token architecture. The schema can later add passkey credentials without changing staff identity, roles, or capability checks.

## Home Screen App

The static manifest names the optional app `Наран Эрдэм`, starts at `/staff/`, and uses standalone display with the existing logo and palette. Installation is entirely optional: there are no install prompts, custom URL schemes, or claims that the site can open an installed app. Browser, standalone PWA, and mail-app contexts retain independent cookie stores and therefore follow the same approval/claim rules.

## Email Safety

Staff email uses the existing provider interface, Resend adapter, `outbound_email` ledger, sender domain plan at `mail.naranerdem.com`, and stable idempotency keys. Staging requires `STAGING_EMAIL_OVERRIDE_TO`: the fake `@example.invalid` staff address remains `intended_to_email`, while only the safe inbox becomes `actual_delivery_email`. Missing staging override fails closed. `STAGING_AUTH_TEST_KEY` is unrelated to ordinary staff login and is never accepted as staff authentication.

Production keeps `STAFF_AUTH_EMAIL_ENABLED=false`. Before enabling a public production login-start sender, add Cloudflare Turnstile with server-side verification and stronger edge/cooldown monitoring while retaining generic non-enumerating responses.

## Provisioning And Audit

Use `npm run staff:create` with explicit `--env`, `--email`, `--name`, and `--role`. Staging permits only `@example.invalid` intended identities. Production additionally requires `--confirm-production`. The command is idempotent for an existing email/role, writes no credentials, and records account-creation and role-assignment audit events.

Future staff-management routes must call the administration service so role replacement and enable/disable actions are capability checked and audited. Successful login, policy changes, and revocation are also audited. Raw tokens, API keys, and noisy failed-login details are excluded.

## Mutation Safety

Privileged changes must never use `GET`. Every mutation must validate the staff session and required capability server-side, then validate same-origin `Origin`/`Referer` or a dedicated CSRF token. Menus, hidden controls, and client-side role checks are not authorization.
