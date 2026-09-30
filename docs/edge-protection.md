# Edge Protection Activation

This is a deliberately narrow Cloudflare-zone control for the production
custom domain. It complements, but does not replace, the Worker-side public
request policy in `src/server/staff/usage-protection.ts`.

## Current prepared runtime

`wrangler.jsonc` deliberately sets production `workers_dev` and
`preview_urls` to `false`. A future production deploy from this configuration
therefore keeps `https://naranerdem.com` as the only configured public Worker
origin and disables the production script's stable `workers.dev` endpoint.
Staging explicitly retains its `workers.dev` URL for the disposable test
environment.

At the readiness review, the Cloudflare dashboard showed the production stable
and preview `workers.dev` URLs both enabled and public, alongside the
`naranerdem.com` custom domain. Staging also had both `workers.dev` URL types
enabled and public, with no custom domain. The prepared configuration closes
only the production alternates on its next reviewed deployment; staging remains
available for its isolated test work.

This configuration does not revoke a previously issued version/deployment URL
or protect a separately deployed preview. Before activation, inspect the
Workers dashboard for such URLs and disable them or place them behind Cloudflare
Access through a separately approved operational action. No application email,
QR, or public link depends on the production `workers.dev` address: production
uses `APP_ORIGIN=https://naranerdem.com`.

## Proposed zone rule

Create exactly one **active** rate-limiting rule in the `naranerdem.com` zone:

| Setting | Value |
| --- | --- |
| Name | `Public registration burst protection` |
| Expression | `(starts_with(http.request.uri.path, "/api/registration/") or http.request.uri.path eq "/api/waitlist-offer" or starts_with(http.request.uri.path, "/api/auth/email/"))` |
| Characteristics | IP |
| Threshold | 20 requests |
| Period | 10 seconds |
| Action | Block |
| Mitigation timeout | 10 seconds |
| Rule order | The zone's only rate-limiting rule; no existing custom or skip rule precedes it. |

The expression covers the dynamic public registration, recovery, waitlist, and
email-verification APIs. It deliberately excludes static assets, public
content/calendar reads, `/api/health`, `/api/qr`, and every `/api/staff/*`
endpoint. A normal registration loads `catalog` and `bootstrap` and submits one
multi-child payload; it remains well below 20 requests in ten seconds even for
several children. The threshold leaves room for two or three ordinary families
sharing an IP and browser retries, while limiting a sustained burst before the
Worker and D1 run.

Cloudflare's Free-zone rate limit is per client IP and data centre, may allow a
small burst past the threshold before propagation, returns a non-JSON block
response, and is not an exact origin capacity limit. The registration form
keeps its saved draft and one UUID idempotency key on an edge `429`; after the
short block expires its retry can recover an already committed registration
without a second draft or receipt.

## Existing application limits

The Worker already applies independent per-IP limits after edge execution:

| Policy | Registration submit | Registration data | Anonymous message/link |
| --- | ---: | ---: | ---: |
| Normal | 6/minute | 60/minute | 4/minute |
| Heightened | 2/minute | 20/minute | 1/minute |

Those bindings remain separate between production and staging for public
traffic. This zone rule does not change policy presets, application pauses,
staff login, payment confirmation, attendance, capacity updates, or either
Cron expression.

## Activation and recovery

1. Confirm the zone remains on a plan with one available rate-limiting-rule
   slot, and that the expression fields, 10-second period, block action, and
   10-second mitigation timeout are still available in the dashboard.
2. Verify the production Worker deployment uses this commit so the source
   configuration disables the production `workers.dev` and preview URLs.
3. Create the rule above in **Security → Security rules → Rate limiting rules**;
   do not add a broad `/api/*` rule or a Cloudflare Access/managed challenge
   rule as part of this activation.
4. Verify only the expression preview, configuration, and dashboard rule order.
   Do not exhaust the live limit or submit a production registration.

To stop the edge mitigation immediately, disable this one dashboard rule. That
does not change application data or queued work. Re-enabling `workers.dev` or
version URLs is a separate Workers routing decision. Neither the zone rule nor
the Worker-side limits provide a hard monthly spending cap or block every
possible route outside the custom domain.
