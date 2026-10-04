// Smoke test for dsh-approval-timeout v0.6.
// Self-locating: run it from anywhere with `node smoke.mjs`.
// Exit code is the verdict — no eyeballing of JSON.
import { apply, name } from './lib/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT = 120;
let passed = 0;

const failures = [];
// Objects need structural comparison: two literals are never `===`, and a
// silently-wrong expectation would turn a real regression into a green run.
const same = (a, b) => (typeof a === 'object' && a !== null ? JSON.stringify(a) === JSON.stringify(b) : a === b);
const check = (label, actual, expected) => {
  if (same(actual, expected)) passed += 1;
  else failures.push(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
};

// One host with both seams registered, like a real profile.
function host(config) {
  const listeners = new Map();
  apply({ on: (event, fn) => listeners.set(event, fn) }, config);
  return listeners;
}

// One tool execution whose body raises an escalation, like dsh-sandbox does.
async function approvalScenario(config, { toolName = 'bash', answerAfter = null } = {}) {
  const listeners = host(config);
  const seam = listeners.get('approval/request');
  const exec = { name: toolName, callId: 'call_1', signal: new AbortController().signal };
  let aborted = false;
  let outcome;
  const body = async () => {
    // The body observes exec.signal as the tools listener left it — the fused
    // signal, exactly like dsh-tools hands it to a real tool body. Watching the
    // original signal instead would miss the abort and fake a defect.
    exec.signal.addEventListener('abort', () => {
      aborted = true;
    });
    outcome = await seam(
      { toolName, callId: exec.callId, displayReason: 'Auto review denied tool "bash"' },
      answerAfter === null ? () => new Promise(() => {}) : async () => {
        await sleep(answerAfter);
        return 'allowed-once';
      }
    );
    return 'tool body finished';
  };
  const toolResult = await listeners.get('tools/execute')(exec, body);
  return { outcome, aborted, toolResult };
}

const base = { timeoutMs: TIMEOUT };

// The regression that motivated v0.4: the reviewer denial times out AND the card
// closes — the abort is what settles the client-side pending approval.
{
  const { outcome, aborted } = await approvalScenario(base);
  check('auto-review denial times out', outcome, 'rejected');
  check('card closed by abort', aborted, true);
}

// A plain escalation behaves identically — the seam is not auto-specific.
{
  const { outcome, aborted } = await approvalScenario(base, { toolName: 'edit' });
  check('escalation times out', outcome, 'rejected');
  check('edit card closed by abort', aborted, true);
}

// v0.2.2's second defect: a slow call that never asks for approval must survive,
// and must not have its signal aborted at all.
{
  const listeners = host(base);
  const exec = { name: 'bash', callId: 'call_slow', signal: new AbortController().signal };
  let aborted = false;
  const result = await listeners.get('tools/execute')(exec, async () => {
    exec.signal.addEventListener('abort', () => {
      aborted = true;
    });
    await sleep(TIMEOUT * 3);
    return 'command finished';
  });
  check('long call passes through', result, 'command finished');
  check('long call not aborted', aborted, false);
}

// A human answer inside the budget wins verbatim, and nothing is aborted.
{
  const { outcome, aborted } = await approvalScenario(base, { answerAfter: 20 });
  check('human answer wins', outcome, 'allowed-once');
  check('human answer does not abort', aborted, false);
}

// An answerer that dies while nobody is watching must not crash the turn.
{
  const seam = host(base).get('approval/request');
  check('answerer failure normalizes', await seam({ toolName: 'bash', callId: 'x' }, async () => {
    throw new Error('gui gone');
  }), 'unavailable');
}

// A non-vocabulary return is not policy; fail closed.
{
  const seam = host(base).get('approval/request');
  check('rogue return normalizes', await seam({ toolName: 'bash', callId: 'y' }, async () => 'yes-please'), 'unavailable');
}

// denyOnTimeout:false swaps the verdict to the core's fail-closed vocabulary.
{
  const seam = host({ timeoutMs: TIMEOUT, denyOnTimeout: false }).get('approval/request');
  check('denyOnTimeout=false', await seam({ toolName: 'bash', callId: 'z' }, () => new Promise(() => {})), 'unavailable');
}

// ---------------------------------------------------------------------------
// v0.5: the denial text the model actually reads.
// ---------------------------------------------------------------------------

// The exact result shape dsh-tools builds for an approval denial
// (prepareExecution :3243-3257, reason from serviceAsk :3468-3488).
function denialResult(toolName, outcome) {
  const reason = outcome === 'rejected'
    ? `the user rejected tool "${toolName}"`
    : outcome === 'cancelled'
      ? `approval for tool "${toolName}" was cancelled`
      : `tool "${toolName}" requires approval, but no approval channel is available`;
  return {
    content: [{ type: 'text', text: `Error: ${reason}` }],
    isError: true,
    error: { message: reason },
  };
}

// Verbatim replica of dsh-tools/lib/index.js:2601 — the ONLY consumer of the
// block decision we return. A string feedback throws here ("content.map is not a
// function") and the model never sees our text at all, so the verdict has to be
// taken through this function, not from our own object.
function failureMessageFromContent(content) {
  const text = content.map((block) => block.type === 'text' ? block.text : `[${block.type} content]`).join('\n');
  return text.length > 0 ? text : 'tool result blocked by post-execute policy';
}
function hostSees(decision) {
  if (decision?.kind !== 'block') return { message: null, error: null };
  try { return { message: failureMessageFromContent(decision.feedback), error: null }; }
  catch (error) { return { message: null, error: String(error && error.message || error) }; }
}

const REVIEWER_REASON = 'Auto review denied tool "bash": серийник указан неверно';

// The pre-dispatch arm settles the question `cancelled` before our verdict wins,
// so the card closes (good) but the model would read the stock "was cancelled"
// phrase (bad). The note must say it was our deadline, not a withdrawal.
{
  const listeners = host(base);
  const pre = listeners.get('tools/pre-execute') ?? (() => Promise.resolve());
  const exec = { name: 'bash', callId: 'call_v6_cancel', signal: new AbortController().signal };
  await pre(exec, () => listeners.get('approval/request')(
    { toolName: 'bash', callId: exec.callId, reason: REVIEWER_REASON, signal: exec.signal },
    () => new Promise(() => {}),
  ));
  const decision = await postHook(listeners)({ name: 'bash', callId: exec.callId }, denialResult('bash', 'cancelled'));
  const seen = hostSees(decision);
  check('cancelled denial is rewritten', decision?.kind, 'block');
  check('host consumes cancelled feedback', seen.error, null);
  check('cancelled reads as a timeout', (seen.message ?? '').includes('nobody decided'), true);
  check('cancelled carries the reason', (seen.message ?? '').includes(REVIEWER_REASON), true);
  check('cancelled never blames a withdrawal', (seen.message ?? '').includes('withdrawn'), false);
}

// The live v0.5 defect: our block reached the model as "content.map is not a
// function" because we asserted on our own decision object and never on the host
// consuming it. This assertion is the one that would have caught it.
{
  const listeners = host(base);
  await listeners.get('approval/request')(
    { toolName: 'bash', callId: 'call_v6_shape', reason: REVIEWER_REASON },
    () => new Promise(() => {}),
  );
  const decision = await postHook(listeners)({ name: 'bash', callId: 'call_v6_shape' }, denialResult('bash', 'rejected'));
  const seen = hostSees(decision);
  check('host consumes our feedback', seen.error, null);
  check('feedback is content blocks', Array.isArray(decision.feedback), true);
  check('host sees the timeout text', (seen.message ?? '').includes('nobody decided'), true);
  check('host sees the reviewer reason', (seen.message ?? '').includes(REVIEWER_REASON), true);
}

// The auto-review path: serviceAsk runs in prepareExecution, so the card waits on
// a signal armed BEFORE dispatch. v0.4 armed on tools/execute and therefore never
// closed these cards (`card closed by abort: false`). Prove the prepare arm's
// abort reaches the signal the approval request reads.
{
  const listeners = host(base);
  // No pre-execute listener = this build never arms before dispatch, which is
  // the v0.4/v0.5 defect. A no-op keeps the verdict a readable FAIL instead of a
  // stack trace, so the assertion that actually moved is visible.
  const pre = listeners.get('tools/pre-execute') ?? (() => Promise.resolve());
  const exec = { name: 'bash', callId: 'call_v6_card', signal: new AbortController().signal };
  const upstream = exec.signal;
  let cardAborted = false;
  check('pre-execute listener exists', listeners.get('tools/pre-execute') !== undefined, true);
  await pre(exec, () => {
    // serviceAsk reads exec.signal AFTER our fusion (dsh-tools :3461), so the
    // card waits on the FUSED signal — listening on the pre-fusion one would
    // miss the abort and fake a green run.
    const requestSignal = exec.signal;
    check('prepare arm fused the signal', requestSignal !== upstream, true);
    requestSignal.addEventListener('abort', () => { cardAborted = true; });
    return listeners.get('approval/request')(
      { toolName: 'bash', callId: exec.callId, reason: REVIEWER_REASON, signal: requestSignal },
      () => new Promise(() => {}),
    );
  });
  check('expired card is aborted', cardAborted, true);
  check('prepare arm released after settle', exec.signal === upstream, true);
}

// Nothing may leak after our expiry settles the waterfall first., so we prove we run the chain and only then
// override — and that we hand back its decision untouched when it is not ours.
function postHook(listeners, downstream) {
  const hook = listeners.get('tools/post-execute');
  // No listener = this build cannot rewrite anything. Return that plainly so the
  // verdict is a readable FAIL instead of a crash: the pre-v0.5 run of this file
  // must fail, and a stack trace would hide which assertion actually moved.
  if (typeof hook !== 'function') return () => undefined;
  return (exec, result) => hook(exec, result, downstream ?? (() => ({ kind: 'accept' })));
}

// The regression that motivated v0.5: a timeout denial used to reach the model as
// `the user rejected tool "bash"` — a user who never answered, with no reason.
{
  const listeners = host(base);
  const outcome = await listeners.get('approval/request')(
    { toolName: 'bash', callId: 'call_v5_timeout', reason: REVIEWER_REASON },
    () => new Promise(() => {}),
  );
  check('timeout still rejects', outcome, 'rejected');
  const decision = await postHook(listeners)({ name: 'bash', callId: 'call_v5_timeout' }, denialResult('bash', 'rejected'));
  check('timeout denial is rewritten', decision?.kind, 'block');
  check('timeout denial says timeout', (hostSees(decision).message ?? '').includes('timed out'), true);
  check('timeout denial says nobody decided', (hostSees(decision).message ?? '').includes('nobody decided'), true);
  check('timeout denial never blames the user', (hostSees(decision).message ?? '').includes('the user rejected'), false);
  check('timeout denial carries the reason', (hostSees(decision).message ?? '').includes(REVIEWER_REASON), true);
}

// A real decision must read as a real decision, not as our timer — the two are
// indistinguishable to the model today, which is the whole point.
{
  const listeners = host(base);
  const outcome = await listeners.get('approval/request')(
    { toolName: 'bash', callId: 'call_v5_decided', reason: REVIEWER_REASON },
    async () => { await sleep(20); return 'rejected'; },
  );
  check('real rejection unchanged', outcome, 'rejected');
  const decision = await postHook(listeners)({ name: 'bash', callId: 'call_v5_decided' }, denialResult('bash', 'rejected'));
  check('real rejection is rewritten', decision?.kind, 'block');
  check('real rejection denies the timeout reading', (hostSees(decision).message ?? '').includes('not a timeout'), true);
  check('real rejection carries the reason', (hostSees(decision).message ?? '').includes(REVIEWER_REASON), true);
}

// denyOnTimeout:false lands on the other dsh-tools template and gets its own words.
{
  const listeners = host({ timeoutMs: TIMEOUT, denyOnTimeout: false });
  await listeners.get('approval/request')(
    { toolName: 'edit', callId: 'call_v5_unavail' },
    () => new Promise(() => {}),
  );
  const decision = await postHook(listeners)({ name: 'edit', callId: 'call_v5_unavail' }, denialResult('edit', 'unavailable'));
  check('unavailable denial is rewritten', decision?.kind, 'block');
  check('unavailable denial keeps the timeout', (hostSees(decision).message ?? '').includes('timed out'), true);
  check('unavailable denial names the outcome', (hostSees(decision).message ?? '').includes('outcome: unavailable'), true);
}

// A tool that failed on its own is NOT ours: identical result object out.
{
  const listeners = host(base);
  const result = { content: [{ type: 'text', text: 'Error: exit status 1' }], isError: true, error: { message: 'exit status 1' } };
  const decision = await postHook(listeners)({ name: 'bash', callId: 'call_v5_foreign' }, result);
  check('own tool failure untouched', decision, { kind: 'accept' });
}

// A denial we never saw asked is NOT ours either — no record, no rewrite.
{
  const listeners = host(base);
  await listeners.get('approval/request')({ toolName: 'bash', callId: 'call_v5_seen' }, async () => 'rejected');
  const decision = await postHook(listeners)({ name: 'bash', callId: 'call_v5_unseen' }, denialResult('bash', 'rejected'));
  check('denial without a record untouched', decision, { kind: 'accept' });
}

// A successful call after an approval is not a denial and must survive intact.
{
  const listeners = host(base);
  const outcome = await listeners.get('approval/request')(
    { toolName: 'bash', callId: 'call_v5_ok', reason: REVIEWER_REASON },
    async () => { await sleep(10); return 'allowed-once'; },
  );
  check('approval still grants', outcome, 'allowed-once');
  const decision = await postHook(listeners)({ name: 'bash', callId: 'call_v5_ok' }, { content: [{ type: 'text', text: 'done' }], isError: false });
  check('granted call untouched', decision, { kind: 'accept' });
}

// We run the downstream chain first and respect a verdict we did not make.
{
  const listeners = host(base);
  const downstream = () => ({ kind: 'block', feedback: [{ type: 'text', text: 'downstream said no' }] });
  await listeners.get('approval/request')({ toolName: 'bash', callId: 'call_v5_ds' }, async () => 'rejected');
  const decision = await postHook(listeners, downstream)({ name: 'bash', callId: 'call_v5_ds' }, denialResult('bash', 'rejected'));
  check('downstream block respected', hostSees(decision).message, 'downstream said no');
}

// Nothing may leak after our expiry settles the waterfall first.
const leaked = await new Promise((resolve) => {
  const onLeak = (err) => resolve(String((err && err.message) || err));
  process.on('unhandledRejection', onLeak);
  setTimeout(() => {
    process.off('unhandledRejection', onLeak);
    resolve(null);
  }, 250);
});
check('no unhandled rejection', leaked, null);

console.log(`plugin: ${name}`);
if (failures.length > 0) {
  console.error(`FAIL (${failures.length})\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`PASS — ${passed} assertions, timer=${TIMEOUT}ms`);
process.exit(0);