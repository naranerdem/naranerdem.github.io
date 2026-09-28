# Usage Protection (Observation Mode)

`/staff/settings/usage/` is an admin-only, on-demand surface. It reads one
policy row and one environment-local cache row; the page does not poll and no
ordinary request writes diagnostic data.

## Collector

The staged Worker has the existing staggered background expression and
`*/15 * * * *` for usage collection. When this same collector is separately
approved for production, the two Workers will use four Cron triggers together,
below the current Free-plan account limit of five. The collector makes at most
one account analytics request per run and stores one cache row for its own
environment. It does not query application history, write learner/financial
data, or retry a failed provider request.

Configure these Worker secrets only after a read-only rollout review:

- `CLOUDFLARE_ANALYTICS_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ANALYTICS_WORKER_NAME`

The token must be restricted to the intended account with only **Account →
Account Analytics → Read**. It needs no D1 write, Worker edit, route, billing,
or account-administration permission. The current bounded query stores Worker
invocation and general-error sums for a rolling 24-hour window. Its warning
threshold applies only to that general-error sum; it is not a CPU-limit alert.
Cloudflare's documented Workers query exposes CPU percentiles rather than a
total CPU counter, so CPU-limit failures remain unavailable until a token-backed
schema probe identifies a distinct outcome field. D1 analytics does expose
`rowsRead` and `rowsWritten`, but its documented dataset is date-bucketed and
also requires the bound database ID; it is intentionally not mixed into the
rolling Worker window until the account schema validates the exact combined
query. The panel says these values are unavailable rather than estimating them
from elapsed time or query counts.

The policy cache is held for up to 60 seconds in a warm Worker isolate. A manual
pause therefore propagates before a later background unit begins, usually on
the next invocation; it never interrupts an in-flight transaction.

## Enforcement and Emergency Use

The initial policy is observation-only. Warning thresholds do not automatically
pause any work. An admin may separately pause reminders, waitlist recovery,
internal notification retries, or finalization recovery. Manual pauses are
checked before the selected background unit starts. They do not stop an
already-running operation, synchronous zero-minute payment confirmation,
registration capacity changes, or a payment that has already begun.

Application pauses do not prevent billable Worker invocation. For a Cloudflare
emergency, use the dashboard to review all of these independently: the
production custom domain (`naranerdem.com`), production/staging `workers.dev`
addresses, any version/preview URLs, and both Workers' Cron triggers. Disable
only the reviewed route or trigger, retain a timestamped record, and restore it
through a separate operational decision. These controls, alerts, and a payment
card do not guarantee a monthly spending maximum.

If analytics is unavailable or stale, existing manual pauses remain unchanged.
The panel reports that uncertainty; it does not fail open into automatic resume
or fail closed into whole-site shutdown.
