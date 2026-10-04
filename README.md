# dsh-approval-timeout

Server-side cordis plugin: auto-resolves pending approval prompts (`approval/request`)
as `rejected` after a timeout, so an AFK operator no longer pins an agent turn open
forever. Mirrors how `ask_user_question` already times out — approvals were the gap.

## Why

`dsh-user-approval` composes answerers as a Cordis waterfall with NO deadline
(`ctx.waterfall(target, "approval/request", req, default unavailable)` — verified in
lib/index.js:179, 2026-09-13). When the only live answerer is the GUI dialog and nobody
is at the keyboard, the escalation awaits forever. This plugin registers its own
waterfall listener at boot (ahead of the remote GUI answerer that attaches on client
connect — same ordering the ACP bridge relies on), calls `next()` to let humans answer,
and races that against a timer. Human answer wins if it arrives in time; otherwise the
timer returns `rejected` — the honest reading of "nobody said yes."

The `rejected` verdict is indistinguishable from a human "No" in the session log, which
is deliberate and also the accounting hazard: any retrospective "how often does the
operator refuse X" query is contaminated by our own timeouts unless it joins
`desktop.log` for the `auto-rejected` line.

## Version history (why v0.5 exists)

| version | seam | measured outcome |
|---|---|---|
| v0.1.0 | `approval/request` | correct shape; live test passed on a plain escalation (13.09) |
| v0.2.x | `tools/execute` + `exec.signal` swap | **two defects**, measured 2026-10-01 |
| v0.3 | `approval/request` | timer covers reviewer denials, long calls safe — **but the card stayed on screen** |
| v0.4 | `approval/request` + abort on expiry | reviewer denials covered **and** the card closes |
| v0.5 | + `tools/post-execute` | the denial tells the model **who decided, how long, and why** |
| v0.6 | + `tools/pre-execute` arming, block feedback as content blocks | v0.5 crashed the denial path and left every auto-review card on screen |

v0.2 moved the deadline onto `exec.signal`, copied from `dsh-ask-guard`, to close an
orphaned GUI card. Two things broke that the 13.09 test could not see, because that test
only exercised a plain escalation:

1. **The auto-review path was never covered.** The `auto` permission preset routes a
   reviewer denial back to the operator (`dsh-permission-presets`: `ask` routes reviewer
   denials to the user). That request still travels `approval/request` — the session log
   shows `approval/asked` with reason `Auto review denied tool "bash": …` — but the exec
   signal swap does not reach it. Measured: 182 `auto-rejected` lines in the host logs
   over ~5 weeks; 46 timer-signature approval pairs in the session logs (asked-to-decided
   gap ≈180 s), **none** of them a reviewer denial, while one auto denial sat open 594 s
   against a 180 s budget.
2. **It killed long-running calls that never asked for anything.** The timer covered
   every `bash`/`edit`/`write`/`read` execution. Probe on identical input (100 ms timer,
   300 ms body, no approval requested): v0.2.2 returned
   `Error: the user rejected escalating this command to "wider access" after 100ms` —
   a fabricated operator denial for an ordinary slow command. v0.3+ passes it through.

**v0.3 brought the orphaned card back.** Returning a verdict from an upstream waterfall
listener does not close the GUI card: the client answerer settles `PendingApproval.result`
only on a human answer, on `request.signal` abort, or on `delegate()` from its
registration disposer (`dsh-client-ui-approval/lib/client.js:186-235` and `:284-309`).
An earlier listener's verdict is none of those, so the pending interaction stayed
registered and the banner hung — the exact symptom v0.2 existed to fix. v0.4 keeps the
v0.3 seam and adds v0.2's abort back, fired **only at the instant of the denial** and
correlated by `callId`. A call that never asks for approval has no pending approval, so
no timer is armed and no signal is touched.

## v0.5 — the denial the model reads

v0.4 made the verdict *correct*; it did nothing for the verdict's *wording*. Measured over
the whole session corpus: `approval/asked` carries a reviewer reason on **223 of 406**
requests and on **none** is it absent — and `dsh-tools/lib/index.js:3468` discards it,
leaving the model the constant `the user rejected tool "<name>"`. Of the 87 rejections,
**40 were this timer** and 47 were real decisions; the model could not tell them apart,
and the phrase names a user who, on the timer path, never answered.

Two facts were being lost at once, and the fix has to restore both:

- **why** the request existed at all — the reviewer's reason, already sitting in the same
  function as a local (`ask.reason`, `:3459`), thrown away one screen later;
- **who actually decided** — nobody, this timer, or a real decision.

The outcome vocabulary is closed (`allowed-once | rejected | cancelled | unavailable`) and
carries no reason by design, so the only channel that reaches the model is the denial
text. v0.5 rides `tools/post-execute`: the denial is materialized in `prepareExecution`
(`:3243`) as a `post-result`, so post-execute is the last seam before the text lands, and
its `block` decision rewrites both `content` and `error.message` (`accept` + `content`
would leave the UI's error summary stale). Patching `dsh-tools` itself would be a
one-liner in the same place, but that tree is the app's and is wiped on reinstall.

Two guards keep it surgical: the error message must be one of the two approval-denial
templates dsh-tools builds, **and** we must hold a record for that exact `callId` from
this request. A tool that failed on its own, a denial we never saw asked, and a granted
call all pass through byte-identical. Downstream post-execute listeners run first and
their verdict is respected.

```
approval for tool "bash" timed out after 180000ms with no answer (waited 180.0s):
nobody decided, denied fail-closed. Approval reason on record: Auto review denied
tool "bash": Команда перезаписывает конфигурацию физических часов, …
```

versus a real decision:

```
approval for tool "edit" was refused (outcome: rejected, not a timeout) after 104.4s.
Approval reason on record: Auto review denied tool "bash": …
```

With `denyOnTimeout:false` both facts are true at once (our timer expired **and** the
fallback verdict is `unavailable`), and the text says both.

## v0.6 — two live defects, both found by running it

v0.5 was green in the smoke test and broken in the host. Both faults were the
same species as the v0.2 incident: a check that proved our own object was fine
instead of proving the host could use it.

1. **`block` feedback was a bare string.** `dsh-tools` consumes it through
   `failureMessageFromContent(decision.feedback)` (`lib/index.js:2601-2603`), which
   `map`s over the array. A string throws `content.map is not a function` from
   inside `postExecute`, so the denial surfaced as that error instead of our text.
   The v0.5 test asserted on `decision.feedback` and could not see it. The test now
   takes its verdict **through a verbatim replica of the host function**.
2. **The auto-review cards never closed** — the `card closed by abort: false`
   lines that had been sitting in `desktop.log`. `serviceAsk` lives in
   `prepareExecution` (`dsh-tools:3226`), on the `tools/pre-execute` side, so an
   auto-review denial happens *before dispatch*: v0.4 armed on `tools/execute`,
   the execution never ran, `armed` was empty and the abort had no target. v0.6
   arms on `tools/pre-execute` instead, fusing our controller into `exec.signal`
   **before** `approval.request()` reads it (`:3461`) — that is the signal the
   client card waits on. The prepare arm is released once the question settles,
   and a TTL sweep is the backstop.

A card still on screen after the deadline has no answer and no effect: the click
cannot change a decision that was already taken, so the honest fix is to close it
at the deadline rather than make the stale card interactive again.

smoke: 38 assertions. The same test on v0.5 reports `FAIL (13)`, including the
live symptom `host consumes our feedback: got "content.map is not a function"`.

## Config

Set via the patch entry `config:` map, or env overrides (env wins):

| key | env | default | meaning |
|---|---|---|---|
| `timeoutMs` | `DSH_APPROVAL_TIMEOUT_MS` | 180000 | auto-reject deadline |
| `denyOnTimeout` | `DSH_APPROVAL_DENY_ON_TIMEOUT` | true | false → `unavailable` instead of `rejected` |
| `graceFirstMs` | `DSH_APPROVAL_GRACE_MS` | 3000 | floor before the timer can fire |

## Install

Install from a clone (reinstall after an app update, per the official profile doc):

```bash
dsh plugin --profile web add <path-to-this-repo>
```

For live-edit development, symlink `$DSH_HOME/plugins/dsh-approval-timeout` to the clone
instead of copying, and the profile's `link:` spec picks up edits after a host restart.
Activation needs a host restart; the boot banner is
`dsh-approval-timeout: active (v0.6, approval/request seam + pre-dispatch abort + explained denials), timeout=180000ms`.

## Test

```bash
node smoke.mjs   # exit code is the verdict
```

Thirty assertions over a three-seam harness that drives a real tool execution: the
auto-review denial shape and a plain escalation — **both must abort the execution
signal**, since that abort is what closes the card; a slow call that never asks for
approval must pass through *and* stay un-aborted; a human answer inside the budget wins
without aborting; a throwing answerer; a non-vocabulary return; the `denyOnTimeout=false`
variant; and no unhandled rejection after expiry settles first.

The v0.5 half feeds the post-execute hook the exact result object dsh-tools builds and
asserts on the wording: a timeout denial must say it timed out, must say nobody decided,
must **not** say the user rejected, and must carry the reviewer's reason; a real decision
must read as `not a timeout`; `denyOnTimeout=false` must keep both facts; an unrelated
tool failure, a denial with no record, and a granted call must come back untouched; and
a downstream `block` verdict must be respected.

The whole v0.5 block is discriminating: run this file against v0.4 and it reports
`FAIL (14)` with exit 1, while all sixteen earlier assertions still pass on both.

## Audit trail

Timeout decisions log with `approval-timeout: auto-rejected "<tool>" after <N>ms` and land
in the session as a normal `approval/decided outcome=rejected` pair.

**There is no distinct session-level outcome.** Nothing in the session log distinguishes a
timeout from a human "No" — the host-log line is the only discriminator, and it ends with
`card closed by abort: true|false`. `false` means no execution was armed for that request's
`callId` (a request with no correlated tool execution, or a call that already finished);
the card of such a request cannot be closed by us.