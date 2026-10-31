import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { traceScrollSpringProbe } from '../src/components/scroll-spring-probe.ts';

const moduleUrl = new URL('../src/components/scroll-spring-probe.ts', import.meta.url).href;
const metricKeys = ['epoch', 'alive', 'ready', 'enabled', 'canOwn', 'nativeActive',
  'active', 'pending', 'released', 'owner', 'offset', 'viewport', 'content',
  'touches', 'motionReady', 'reduced', 'foreground', 'extra', 'contentTag'];

function runProbe(flag, body) {
  const env = { ...process.env, TSX_DISABLE_CACHE: '1' };
  delete env.EXPO_PUBLIC_SCROLL_SPRING_DIAGNOSTICS;
  if (flag !== undefined) env.EXPO_PUBLIC_SCROLL_SPRING_DIAGNOSTICS = flag;
  const result = spawnSync(process.execPath, ['--max-old-space-size=96', '--import', 'tsx',
    '--input-type=module', '--eval', `
      import * as probe from ${JSON.stringify(moduleUrl)};
      const calls = [];
      console.log = (...args) => calls.push(args);
      ${body}
      process.stdout.write(JSON.stringify({ enabled: probe.isScrollSpringProbeEnabled,
        constant: probe.SCROLL_SPRING_PROBE_ENABLED, calls }));
    `], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('probe defaults off; only exact 1 enables it', () => {
  for (const flag of [undefined, '', '0', 'true', '01', ' 1', '1 ', '1']) {
    const result = runProbe(flag, "probe.traceScrollSpringProbe('up', 7, { offset: 274 });");
    assert.equal(result.enabled, flag === '1');
    assert.equal(result.constant, flag === '1');
    assert.equal(result.calls.length, flag === '1' ? 1 : 0);
  }
});

test('disabled probe never inspects metrics or reads the environment during calls', () => {
  const result = runProbe(undefined, `
    process.env.EXPO_PUBLIC_SCROLL_SPRING_DIAGNOSTICS = '1';
    const values = new Proxy({}, { get() { throw Error('read'); },
      getOwnPropertyDescriptor() { throw Error('descriptor'); }, ownKeys() { throw Error('keys'); } });
    probe.traceScrollSpringProbe('up', 7, values);
  `);
  assert.deepEqual(result.calls, []);
});

test('enabled probe logs the exact prefix and bounded numeric/boolean whitelist', () => {
  const result = runProbe('1', `
    const keys = ${JSON.stringify(metricKeys)};
    const values = Object.fromEntries(keys.map((key, i) => [key, i % 2 ? true : i]));
    Object.assign(values, { caption: 'PRIVATE', text: 'PRIVATE', path: 'PRIVATE', url: 'PRIVATE',
      event: 'PRIVATE', id: 999, unknownNumeric: 12 });
    process.env.EXPO_PUBLIC_SCROLL_SPRING_DIAGNOSTICS = '0';
    probe.traceScrollSpringProbe('up', 7, values);
  `);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].length, 2);
  assert.equal(result.calls[0][0], 'CAPTION_SPRING_DIAG');
  const payload = JSON.parse(result.calls[0][1]);
  assert.deepEqual(payload, { event: 'up', id: 7,
    ...Object.fromEntries(metricKeys.map((key, i) => [key, i % 2 ? true : i])) });
  assert.ok(!JSON.stringify(result.calls).includes('PRIVATE'));
});

test('malformed metric values, inherited fields, accessors and serialization hooks are excluded', () => {
  const result = runProbe('1', `
    const values = Object.assign(Object.create({ epoch: 99 }), {
      offset: 'PRIVATE', viewport: NaN, content: Infinity, owner: -Infinity,
      alive: null, ready: undefined, enabled: { toJSON() { throw Error('serialize'); } },
      pending: [], released: 1n, active: () => 'PRIVATE', touches: 0, extra: false,
      toJSON() { throw Error('serialize'); }
    });
    Object.defineProperty(values, 'contentTag', { get() { throw Error('getter'); } });
    probe.traceScrollSpringProbe('present', 8, values);
    for (const bad of [null, undefined, 'PRIVATE', 5, true, []]) {
      probe.traceScrollSpringProbe('present', 8, bad);
    }
  `);
  assert.deepEqual(JSON.parse(result.calls[0][1]), { event: 'present', id: 8, touches: 0, extra: false });
  for (const call of result.calls.slice(1)) {
    assert.deepEqual(JSON.parse(call[1]), { event: 'present', id: 8 });
  }
});

test('only predetermined event names and finite integer ids can log', () => {
  const result = runProbe('1', `
    const events = ['reset', 'down', 'start', 'move', 'up', 'cancel', 'finalize',
      'spring-before', 'spring-start', 'spring-complete', 'activate', 'deactivate',
      'content-ready', 'options', 'reduced', 'foreground', 'geometry', 'native-offset',
      'present', 'bind', 'public-ref', 'app-state'];
    for (const event of events) probe.traceScrollSpringProbe(event, 1, {});
    for (const event of ['PRIVATE caption', '', 'toString', null, 3, {}])
      probe.traceScrollSpringProbe(event, 1, {});
    for (const id of [NaN, Infinity, -Infinity, 1.5, 'PRIVATE', null, {}])
      probe.traceScrollSpringProbe('up', id, {});
  `);
  assert.equal(result.calls.length, 22);
  assert.ok(!JSON.stringify(result.calls).includes('PRIVATE'));
});

test('trace is declared as a worklet and never references process in its body (direct execution only)', () => {
  assert.match(traceScrollSpringProbe.toString(), /['"]worklet['"]/);
  assert.doesNotMatch(traceScrollSpringProbe.toString(), /\bprocess\b/);
});

test('workflow text scopes the boolean opt-in to dispatch and defaults every other event off', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const input = workflow.match(/      scroll_spring_diagnostics:\r?\n((?:        .*(?:\r?\n|$))*)/);
  assert.ok(input, 'dispatch input exists');
  assert.match(input[1], /^        type: boolean$/m);
  assert.match(input[1], /^        default: false$/m);
  assert.match(workflow, /  workflow_dispatch:\r?\n    inputs:[\s\S]*?      scroll_spring_diagnostics:/);
  assert.match(workflow, /  verify:\r?\n    runs-on: ubuntu-24\.04\r?\n    timeout-minutes: 75\r?\n    env:\r?\n      EXPO_PUBLIC_SCROLL_SPRING_DIAGNOSTICS: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.scroll_spring_diagnostics == true && '1' \|\| '0' \}\}/);
  assert.equal(workflow.match(/EXPO_PUBLIC_SCROLL_SPRING_DIAGNOSTICS:/g)?.length, 1);
});
