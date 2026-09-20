# Account quota sharing

In **Providers > account > Edit**, enable **Automatically share account quota**
and select the participating API keys. Only those currently active key IDs can
use that account. Disabling sharing restores ordinary routing. Configuration
is stored on the connection; changing it does not clear the usage ledger.

## Policy

Claude divides its main weekly allowance into 45% Fable, 45% other models and
10% reserve. Each selected key receives an equal part of each pool. For four
keys this is 11.25% weekly Fable and 1.607% per day for other models. Daily
release follows the provider's weekly reset, not calendar midnight. Unused
released allowance accumulates until that reset; no borrowing from future days
or other keys. Session limits apply independently and are split equally with
a 10% reserve. Fable's scoped quota has its own denominator: 90% of a scoped
cap equal to 50% of the main week means 45% of the main weekly allowance.

Other providers use measurable percentage/session/weekly windows with a 10%
reserve. Weekly budgets release daily. Missing usable windows or unknown
model pricing deny requests; dollar/credit limits are not treated as percentages.
Currently only chat has quota accounting; other inference routes cannot use
a shared account. Unconfigured accounts remain usable through those routes.

## Estimation and safety limits

Anthropic does not publish a subscription-token conversion. API list prices
provide relative weights, not an exact subscription allowance. Weights include
input, output, cache reads and 5-minute/1-hour cache writes; Claude reasoning
already included in output is not charged twice. Provider measurements calibrate
percentage points per weighted dollar for each quota window independently.

An atomic SQLite lease permits one in-flight request per shared account.
Before calibration, each request reserves an estimated 0.25 percentage points;
at most 1 point of unobserved bootstrap liability is admitted. Quota sharing
does not impose a fixed input/context or output-token cap; the upstream model
enforces its own limits. After calibration, admission reserves the estimated
input plus requested maximum output at the highest observed rate, applying
long-context pricing when applicable. If the client omits an output limit,
64k tokens are used only as a reservation estimate; the request is not modified.
Reduce the requested output limit if this exceeds the released share.
These estimates cannot guarantee that a single request stays within its reservation.

Actual usage settles the lease. Unknown usage, disconnects and crashes retain
liability; stale leases become unknown pending usage after 15 minutes, not a
refund. Zero-change quota reads do not erase that debt. Provider reads are
throttled to once per minute and unavailable readings pause access. Learning
can pause if small requests do not produce a measurable provider change.

Observed batch usage is allocated by actual weighted tokens. External activity
during that batch cannot be distinguished and may conservatively overcharge
it; idle external activity only reduces account headroom. Avoid using the same
subscription outside this gateway when fair attribution matters. Admin tests
and automatic pings are also outside the per-key ledger. Separate connections
for the same upstream subscription do not share a ledger; configure one
connection per subscription and keep dashboard administration private.

## Verification

`tests/unit/quota-sharing-*.test.js` covers membership, independent pools,
calibration, stale data, concurrency, crash debt, reset windows, proxy policy,
and JSON/stream settlement. `tests/unit/claude-pricing.test.js` covers list
prices and cache lifetimes through both passthrough and translated streams.
