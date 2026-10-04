// dsh-approval-timeout v0.5 — deadline on the approval seam, card closed by abort,
// and a denial the model can actually read.
//
// v0.2.2 armed the deadline on `tools/execute` via an `exec.signal` swap (copied
// from dsh-ask-guard). v0.3 moved it back onto `approval/request`, which fixed the
// auto-review path but reintroduced the orphaned card. Full measured history:
//
// v0.2.2 (tools/execute + signal swap)
//   1. The auto-review path was never covered. The `auto` preset routes a reviewer
//      denial back to the operator, and that request still travels
//      `approval/request` — but the exec signal swap does not reach it. Measured:
//      182 auto-rejected lines over ~5 weeks; 46 timer-signature approval pairs in
//      the session logs, none of them a reviewer denial, while one auto denial sat
//      open 594 s against a 180 s budget.
//   2. It killed long-running calls that never requested approval. Same input
//      (100 ms timer, 300 ms body, no approval) returned a fabricated
//      "the user rejected escalating" error; a plain slow command was destroyed.
//
// v0.3 (approval/request only)
//   The timer finally covers reviewer denials, and long calls stay untouched —
//   but returning a verdict upstream does NOT close the GUI card. The client
//   answerer settles `PendingApproval.result` only on a human answer, on
//      `request.signal` abort, or on `delegate()` from its registration disposer
//      (dsh-client-ui-approval/lib/client.js:186-235, 284-309). An earlier listener's
//      verdict is not one of those, so the card stayed on screen — the exact symptom
//      v0.2 was written to kill.
//
// v0.4 = v0.3's seam + v0.2's abort, with the abort fired ONLY at the moment we
// deny, correlated by callId. A call that never asks for approval has no pending
// approval, so no timer is armed and no signal is touched.
//
// v0.5 = the denial is finally EXPLAINED. Measured over the session corpus:
// `approval/asked` carries a reviewer reason on 223 of 406 requests and on NONE
// of them is it absent, and `dsh-tools/lib/index.js:3468` throws it away, leaving
// the model the constant `the user rejected tool "<name>"` — which names a user
// who never answered and carries no reason. Of 87 rejections, 40 were this timer
// and 47 were real decisions; the model could not tell them apart.
//
// The rewrite rides `tools/post-execute` instead of patching dsh-tools: the denial
// is materialized in `prepareExecution` (:3243) as a `post-result`, so post-execute
// is the last seam before the text reaches the model, and its `block` decision
// rewrites both `content` and `error.message`. Two guards keep it surgical — the
// error message must be one of the two approval-denial templates, and we must hold
// a record for that exact callId. A tool that failed on its own, or a denial we
// never saw asked, passes through untouched.
export const name = 'approval-timeout';
export const inject = ['tools'];
const OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];
const APPROVAL_TIMEOUT = 'APPROVAL_TIMEOUT';
// The two denial texts dsh-tools builds from an approval outcome
// (lib/index.js:3468-3488). Anything else is not ours to rewrite.
const REJECTED_DENIAL = 'the user rejected tool "';
const UNAVAILABLE_DENIAL = 'requires approval, but no approval channel is available';
// The pre-dispatch arm has a side effect we must own: aborting the request signal
// is what closes the card, and `decide()` reacts to that abort by settling the
// question `cancelled` — which beats our own verdict, because the abort lands
// before our listener returns. So the model sees "approval for tool X was
// cancelled", a third stock phrase that nobody cancelled. We rewrite it too, and
// our note says whether the abort was our deadline or a real withdrawal.
const CANCELLED_DENIAL = 'approval for tool "';
const CANCELLED_SUFFIX = ' was cancelled';
// A record older than this never reaches post-execute (cancelled, aborted, or a
// turn that ended) and must not accumulate.
const RECORD_TTL_MS = 1_800_000;

class TimeoutReason extends Error {
  constructor(ms) {
    super(`approval timeout after ${ms}ms`);
    this.name = 'TimeoutReason';
    this.code = APPROVAL_TIMEOUT;
  }
}
function num(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function resolveConfig(config) {
  const env = (key) => {
    const raw = process.env[key];
    return raw === undefined || raw === '' ? undefined : raw;
  };
  const timeoutMs = num(env('DSH_APPROVAL_TIMEOUT_MS') ?? config?.timeoutMs, 180000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('dsh-approval-timeout: timeoutMs must be a positive integer');
  }
  return {
    timeoutMs,
    denyOnTimeout: (env('DSH_APPROVAL_DENY_ON_TIMEOUT') ?? config?.denyOnTimeout ?? true) !== false,
  };
}
function denialOutcome(result) {
  if (result?.isError !== true) return null;
  const message = result.error?.message;
  if (typeof message !== 'string') return null;
  if (message.startsWith(REJECTED_DENIAL)) return 'rejected';
  if (message.includes(UNAVAILABLE_DENIAL)) return 'unavailable';
  if (message.startsWith(CANCELLED_DENIAL) && message.endsWith(CANCELLED_SUFFIX)) return 'cancelled';
  return null;
}
function seconds(ms) {
  return (ms / 1000).toFixed(1);
}
// One sentence a model can act on: WHO decided, HOW LONG it took, and WHY the
// request was made at all. The timeout case says outright that nobody decided,
// because "the user rejected tool X" on a timeout is a lie the model then repeats.
function composeDenial(note, outcome, timeoutMs) {
  const verdict = note.timedOut
    ? `timed out after ${timeoutMs}ms with no answer (waited ${seconds(note.elapsedMs)}s): nobody decided, denied fail-closed`
    : outcome === 'unavailable'
      ? `could not be decided: no approval channel answered (waited ${seconds(note.elapsedMs)}s)`
      : outcome === 'cancelled'
        ? `was withdrawn before an answer arrived (outcome: cancelled, not a timeout) after ${seconds(note.elapsedMs)}s: nobody decided`
        : `was refused (outcome: rejected, not a timeout) after ${seconds(note.elapsedMs)}s`;
  // denyOnTimeout:false is both facts at once: our timer expired AND the fallback
  // verdict is the core's `unavailable`. Dropping either half re-creates the lie.
  const tail = note.timedOut && outcome === 'unavailable' ? ' (outcome: unavailable)' : '';
  const head = `approval for tool "${note.toolName}" ${verdict}${tail}`;
  return note.reason ? `${head}. Approval reason on record: ${note.reason}` : `${head}.`;
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  // callId -> controller for executions that can still be denied. Populated by the
  // tools listener on every execution, consumed by the approval listener at the
  // instant of expiry so the abort reaches the client card for that exact call.
  const armed = new Map();
  // callId -> controller armed BEFORE dispatch. serviceAsk() lives in
  // prepareExecution (:3226), i.e. on the `tools/pre-execute` side, so the
  // v0.4 tools/execute arming never covered an auto-review denial: the execution
  // was never dispatched, `armed` was empty, and the abort had no target —
  // exactly the `card closed by abort: false` lines. Arming here fuses our signal
  // into exec.signal BEFORE approval.request() reads it (:3461), so the request
  // signal we abort is the one the client card is waiting on.
  const preArmed = new Map();
  function release(callId) {
    const entry = preArmed.get(callId);
    if (entry === undefined) return;
    preArmed.delete(callId);
    if (entry.upstream !== undefined && entry.exec.signal !== entry.upstream) {
      entry.exec.signal = entry.upstream;
    }
  }
  // callId -> what the approval request carried, so the post-execute hook can say
  // WHY the call never ran. Populated by the approval listener for every request
  // we see, consumed once by the post-execute hook, TTL-swept if never reached.
  const notes = new Map();
  const sweep = (now) => {
    for (const [callId, note] of notes) {
      if (now - note.startedAt > RECORD_TTL_MS) notes.delete(callId);
    }
  };

  ctx.on('tools/execute', async (exec, next) => {
    const callId = exec?.callId;
    const upstream = exec?.signal;
    const controller = new AbortController();
    armed.set(callId, { controller, upstream });
    if (upstream) exec.signal = AbortSignal.any([upstream, controller.signal]);
    try {
      return await next();
    } finally {
      if (callId !== undefined) armed.delete(callId);
      if (upstream) exec.signal = upstream;
    }
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const callId = exec?.callId;
    if (callId === undefined) return next();
    sweep(Date.now());
    const upstream = exec.signal;
    const controller = new AbortController();
    preArmed.set(callId, { controller, upstream, exec });
    if (upstream) exec.signal = AbortSignal.any([upstream, controller.signal]);
    return next();
  });

  // Registered at boot, ahead of the GUI answerer that attaches on client connect,
  // so `next()` runs the human path and we race it rather than short-circuit it.
  // Sibling order is not a policy mechanism (user-approval README) — a verdict is
  // returned only on our own expiry.
  ctx.on('approval/request', async (req, next) => {
    const toolName = req?.toolName ?? 'unknown';
    const callId = req?.callId;
    const startedAt = Date.now();
    const note = callId === undefined ? undefined : {
      toolName,
      reason: typeof req?.reason === 'string' && req.reason !== '' ? req.reason : null,
      timedOut: false,
      elapsedMs: 0,
      startedAt,
    };
    if (note !== undefined) {
      sweep(startedAt);
      notes.set(callId, note);
    }
    let timer;
    let expired = false;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve(undefined);
      }, cfg.timeoutMs);
    });
    try {
      const downstream = Promise.resolve().then(() => next());
      // A throwing listener fails the question closed to `unavailable`, as the
      // core's own waterfall contract requires. Normalizing here also covers the
      // case where our timer settled first: the late rejection already has a
      // handler, so nothing leaks as an unhandled rejection.
      const answered = downstream
        .then((outcome) => ({ outcome }))
        .catch(() => ({ outcome: 'unavailable' }));
      const winner = await Promise.race([
        answered,
        deadline.then(() => ({ expired: true })),
      ]);
      if (note !== undefined) note.elapsedMs = Date.now() - startedAt;
      if (winner.expired || expired) {
        // Closing the card: the client answerer only settles on a human answer,
        // on request-signal abort, or on its registration disposer. Aborting the
        // execution signal is the one lever we own; the request signal is derived
        // from it. Scoped to this expiry, so non-approval calls are never touched.
        const reason = new TimeoutReason(cfg.timeoutMs);
        const dispatchArm = callId === undefined ? undefined : armed.get(callId);
        const prepareArm = callId === undefined ? undefined : preArmed.get(callId);
        dispatchArm?.controller.abort(reason);
        prepareArm?.controller.abort(reason);
        if (note !== undefined) note.timedOut = true;
        const outcome = cfg.denyOnTimeout ? 'rejected' : 'unavailable';
        console.log(
          `dsh-approval-timeout: auto-rejected "${toolName}" after ${cfg.timeoutMs}ms` +
            ` (no approval answer, card closed by abort: ${dispatchArm !== undefined || prepareArm !== undefined})`
        );
        return outcome;
      }
      return OUTCOMES.includes(winner.outcome) ? winner.outcome : 'unavailable';
    } finally {
      clearTimeout(timer);
      // The question is settled either way: the card is closed (human answer or
      // our abort), so the prepare arm must not outlive it on exec.signal.
      if (callId !== undefined) release(callId);
    }
  });

  // v0.5. Downstream listeners still run; we only override a verdict we recognise
  // and only with our own record. `block` is the decision that rewrites BOTH the
  // model-visible content and error.message, which `accept`+content would not.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    const callId = exec?.callId;
    const note = callId === undefined ? undefined : notes.get(callId);
    if (note === undefined || decision?.kind !== 'accept') return decision;
    const outcome = denialOutcome(result);
    if (outcome === null) return decision;
    notes.delete(callId);
    // `feedback` is content BLOCKS, not a string: dsh-tools runs
    // `failureMessageFromContent(decision.feedback)` (:2601-2603), which maps over
    // the array and puts it straight into `content`. A bare string there throws
    // "content.map is not a function" from inside postExecute — measured live on
    // the first run after install. Shape is contract, not cosmetics.
    return {
      kind: 'block',
      feedback: [{ type: 'text', text: composeDenial(note, outcome, cfg.timeoutMs) }],
    };
  });

  console.log(
    `dsh-approval-timeout: active (v0.6, approval/request seam + pre-dispatch abort + explained denials), timeout=${cfg.timeoutMs}ms`
  );
}