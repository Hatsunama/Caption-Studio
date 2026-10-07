import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { Lexer, Parser, Evaluator, data } from '@actions/expressions';

const root = process.env.GATE_WORKSPACE || process.cwd();
const path = '.github/workflows/publish-sidecar.yml';
const workflow = parse(readFileSync(resolve(root, path), 'utf8'));
const baseline = parse(execFileSync('git', ['show', 'bbf61511b887d54f01111dcf15698a6c588e281b:' + path], { cwd: root, encoding: 'utf8' }));
const release = workflow.jobs.release;
const publish = release.steps.find(step => step.name === 'Publish prerelease without replacement');
const guard = release.steps.find(step => step.name === 'Enforce dispatch trust boundary');
const state = process.env.GATE_STATE || 'success';
assert.ok(['success', 'failure', 'cancelled', 'recovery'].includes(state));
const successful = state === 'success' || state === 'recovery';
const statuses = new Map([
  ['success', { name: 'success', minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(successful) }],
  ['failure', { name: 'failure', minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(state === 'failure') }],
  ['cancelled', { name: 'cancelled', minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(state === 'cancelled') }],
  ['always', { name: 'always', minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(true) }],
]);
function convert(value) {
  if (value == null) return new data.Null();
  if (typeof value === 'boolean') return new data.BooleanData(value);
  if (typeof value === 'number') return new data.NumberData(value);
  if (typeof value === 'string') return new data.StringData(value);
  return new data.Dictionary(...Object.entries(value).map(([key, item]) => ({ key, value: convert(item) })));
}
function evaluate(source, context, conditional = false) {
  let expression = String(source).trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  // GitHub implicitly adds success() only when no status function is present.
  if (conditional && !/\b(success|failure|cancelled|always)\s*\(/i.test(expression)) {
    expression = 'success() && (' + expression + ')';
  }
  const ast = new Parser(new Lexer(expression).lex().tokens, ['github', 'inputs'], [...statuses.values()]).parse();
  return new Evaluator(ast, convert(context), statuses).evaluate();
}
// Keep coercion in the official evaluator, rather than JavaScript truthiness.
function enabled(source, context) {
  const expression = String(source).trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  return evaluate('!!(' + expression + ')', context, true).coerceString() === 'true';
}

const refs = [
  'refs/heads/main', 'refs/heads/codex/preservation-runtime-contract',
  'refs/heads/codex/private-artifact-gate', 'refs/heads/feature',
  'refs/heads/codex/preservation-runtime-contract-extra',
  'refs/tags/main', 'refs/tags/codex/preservation-runtime-contract', 'refs/tags/v1.2.3',
  'refs/pull/1/merge', 'refs/pull/1/head',
  'refs/heads/MAIN', 'refs/heads/codex/Preservation-runtime-contract',
];
const cases = [
  ['true', true], ['false', false], ['default', workflow.on.workflow_dispatch.inputs.publish.default],
  ['missing', undefined], ['null', null], ['empty', ''], ['zero', 0],
  ['string-false', 'false'], ['string-true', 'true'], ['string-zero', '0'],
];
let assertions = 0;
const failures = [];
function check(actual, expected, label) {
  assertions++;
  try { assert.equal(actual, expected, label); }
  catch (error) { failures.push(error.message); }
}
for (const event of ['workflow_dispatch', 'push', 'pull_request']) {
  for (const ref of refs) {
    for (const [label, value] of cases) {
      const inputs = value === undefined ? {} : { publish: value };
      const context = { github: { ref, event_name: event }, inputs };
      const expectedGuard = event === 'workflow_dispatch' &&
        (ref === 'refs/heads/main' || (ref === 'refs/heads/codex/preservation-runtime-contract' && value === false));
      let guardAllows = true;
      if (guard) {
        const env = { PATH: process.env.PATH, GITHUB_REF: ref, GITHUB_EVENT_NAME: event };
        for (const [key, expression] of Object.entries(guard.env || {})) {
          env[key] = evaluate(expression, context).coerceString();
        }
        const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', guard.run], {
          env, encoding: 'utf8', timeout: 5000,
        });
        assert.ifError(result.error);
        guardAllows = result.status === 0;
        check(guardAllows, expectedGuard, 'guard ' + event + ' ' + ref + ' ' + label);
      }
      const admitted = enabled(release.if, context) && guardAllows;
      const shouldAdmit = successful && expectedGuard;
      check(admitted, shouldAdmit, 'job ' + state + ' ' + event + ' ' + ref + ' ' + label);
      const publishes = admitted && enabled(publish.if, context);
      check(publishes, successful && event === 'workflow_dispatch' && ref === 'refs/heads/main' && value === true,
        'publish ' + state + ' ' + event + ' ' + ref + ' ' + label);
    }
  }
}
check(Boolean(guard), true, 'trust guard exists');
if (guard) {
  check(release.steps[0] === guard, true, 'guard precedes checkout and credentials');
  check(guard.shell, 'bash', 'guard uses tested shell');
  check(Boolean(guard.if), false, 'guard cannot be skipped');
  check(Boolean(guard['continue-on-error']), false, 'guard cannot waive failure');
}
// Selective impact audit: everything except the two conditions and new guard
// must equal the pinned integration workflow, including secrets and retention.
const preserved = structuredClone(workflow);
preserved.jobs.release.if = baseline.jobs.release.if;
preserved.jobs.release.steps = preserved.jobs.release.steps.filter(step => step.name !== 'Enforce dispatch trust boundary');
preserved.jobs.release.steps.find(step => step.name === publish.name).if =
  baseline.jobs.release.steps.find(step => step.name === publish.name).if;
assert.deepEqual(preserved, baseline, 'release inputs, tags, checks, signing, APK verification, and retention preserved');
console.log('PASS preservation audit; state=' + state + '; assertions=' + assertions);
for (const failure of failures) console.error('FAIL ' + failure);
assert.equal(failures.length, 0, 'behavioral gate matrix failures');
