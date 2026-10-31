import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute production AST slices, never a copy of the scroll algorithm. Each
// imperative native command queues a distinct later onScroll ACK. This models
// one asynchronous FIFO schedule; it does not prove native coalescing/gestures.
const filename = new URL('../src/components/editor/layer-timeline.tsx', import.meta.url);
const source = readFileSync(filename, 'utf8');
const tree = ts.createSourceFile(filename.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const linkedRuntime = {};
runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/editor/timeline-linked-scroll.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: linkedRuntime });
function findAll(predicate, root = tree) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}
function only(nodes, label) {
  assert.equal(nodes.length, 1, `expected one actual ${label}`);
  return nodes[0];
}
function initializer(name) {
  return only(findAll(n => ts.isVariableDeclaration(n) && n.name.getText(tree) === name), name).initializer;
}
function evaluate(node, globals) {
  assert.ok(node, 'production expression must exist');
  const code = ts.transpileModule(`(${node.getText(tree)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(code, globals, { filename: filename.pathname, timeout: 1000 });
}
function column(ref) {
  return only(findAll(n => ts.isJsxOpeningElement(n)
    && n.tagName.getText(tree) === 'TimelineNativeScrollView'
    && n.attributes.properties.some(p => p.name?.text === 'ref'
      && p.initializer?.expression?.getText(tree) === ref)), ref);
}
function attribute(node, name) {
  return only(node.attributes.properties.filter(p => p.name?.text === name), name).initializer.expression;
}

function fixture() {
  const queue = [], commands = [], trace = [];
  const positions = { labels: 0, items: 0 };
  const verticalOffsetRef = { current: 0 };
  const handlers = {}, lifecycleHandlers = {};
  let turn = 0;
  function nativeRef(target) {
    return { current: { scrollTo(options) {
      assert.equal(options.animated, false);
      assert.ok(Number.isFinite(options.y));
      const event = { target, y: options.y, issuedTurn: turn };
      commands.push(event);
      trace.push(`T${turn} command ${target}:${event.y}`);
      queue.push(event); // No synchronous handler, deduplication, or coalescing.
    } } };
  }
  const globals = {
    useCallback: fn => fn,
    useMemo: fn => fn(),
    ...linkedRuntime,
    PixelRatio: { roundToNearestPixel: y => y },
    verticalOffsetRef,
    verticalRef: nativeRef('items'),
    labelScrollRef: nativeRef('labels'),
    selectedRowTop: 40,
  };
  globals.linkedScroll = evaluate(initializer('linkedScroll'), globals);
  globals.syncVerticalScroll = evaluate(initializer('syncVerticalScroll'), globals);
  const revealCue = evaluate(initializer('revealCue'), globals);
  handlers.items = evaluate(attribute(column('verticalRef'), 'onScroll'), globals);
  handlers.labels = evaluate(attribute(column('labelScrollRef'), 'onScroll'), globals);
  for (const [side, ref] of [['items', 'verticalRef'], ['labels', 'labelScrollRef']]) {
    lifecycleHandlers[side] = Object.fromEntries(['onLayout', 'onContentSizeChange', 'onScrollBeginDrag', 'onScrollEndDrag', 'onTouchCancel']
      .map(name => [name, evaluate(attribute(column(ref), name), globals)]));
  }
  function deliver(target, y, kind, metadata = {}) {
    turn++;
    positions[target] = y;
    trace.push(`T${turn} ${kind} ${target}:${y}`);
    handlers[target]({ nativeEvent: { contentOffset: { x: 0, y }, ...metadata } });
  }
  return {
    queue, commands, trace, positions, verticalOffsetRef, lifecycleHandlers,
    input(target, y, metadata) { deliver(target, y, 'input', metadata); },
    reveal() { turn++; trace.push(`T${turn} reveal:40`); revealCue(0); },
    ack() {
      const event = queue.shift();
      assert.ok(event, 'ACK must originate in an observed scrollTo');
      assert.ok(event.issuedTurn <= turn);
      deliver(event.target, event.y, 'ACK');
    },
    drain(limit = 100) {
      let delivered = 0;
      while (queue.length && delivered < limit) { this.ack(); delivered++; }
      return delivered;
    },
    evidence() {
      return `pending=${queue.length}; offset=${verticalOffsetRef.current}; positions=${JSON.stringify(positions)}\n`
        + trace.slice(0, 24).join('\n');
    },
  };
}
function interleaved(origin) {
  const f = fixture();
  f.input(origin, 10);
  f.input(origin, 20);
  return f;
}

test('source graph: both native columns call the actual sync callback with their own source', () => {
  const sync = initializer('syncVerticalScroll');
  assert.ok(ts.isCallExpression(sync));
  assert.equal(sync.expression.getText(tree), 'useCallback');
  assert.ok(ts.isArrowFunction(sync.arguments[0]));
  for (const [ref, sourceName] of [['verticalRef', 'items'], ['labelScrollRef', 'labels']]) {
    const handler = attribute(column(ref), 'onScroll');
    const call = only(findAll(n => ts.isCallExpression(n)
      && n.expression.getText(tree) === 'syncVerticalScroll', handler), `${sourceName} sync call`);
    assert.equal(call.arguments[0].getText(tree), 'event.nativeEvent.contentOffset.y');
    assert.equal(call.arguments[1].text, sourceName);
  }
  const revealCalls = findAll(n => ts.isCallExpression(n)
    && n.expression.getText(tree) === 'syncVerticalScroll'
    && n.arguments[1]?.text === 'reveal');
  assert.ok(revealCalls.some(call => call.arguments[0].getText(tree) === 'next'), 'track auto-scroll stays connected');
  assert.ok(revealCalls.some(call => call.arguments[0].getText(tree) === 'selectedRowTop'), 'cue reveal uses the same ACK owner');
  assert.ok(revealCalls.some(call => call.arguments[0].getText(tree) === '0'), 'project/reset reveal uses the same ACK owner');
});

for (const origin of ['labels', 'items']) {
  const peer = origin === 'labels' ? 'items' : 'labels';
  test(`${origin}: a single scroll synchronizes the peer and consumes one later ACK`, () => {
    const f = fixture();
    f.input(origin, 20);
    assert.deepEqual(f.queue.map(e => [e.target, e.y]), [[peer, 20]]);
    assert.equal(f.commands.length, 1);
    assert.equal(f.drain(), 1);
    assert.equal(f.queue.length, 0);
    assert.equal(f.verticalOffsetRef.current, 20);
    assert.deepEqual(f.positions, { labels: 20, items: 20 });
  });

  test(`${origin}: 10 then 20 queues distinct FIFO ACKs on later turns`, () => {
    const f = interleaved(origin);
    assert.deepEqual(f.queue.map(e => [e.target, e.y, e.issuedTurn]), [[peer, 10, 1], [peer, 20, 2]]);
    assert.equal(f.verticalOffsetRef.current, 20);
    assert.equal(f.commands.length, 2, 'neither scrollTo invokes onScroll synchronously');
  });

  test(`${origin}: interleaved peer ACKs settle within 100 deliveries`, () => {
    const f = interleaved(origin);
    f.drain(100);
    assert.equal(f.queue.length, 0, `linked-scroll feedback did not settle\n${f.evidence()}`);
    assert.equal(f.verticalOffsetRef.current, 20, f.evidence());
    assert.deepEqual(f.positions, { labels: 20, items: 20 }, f.evidence());
  });

  test(`${origin}: an old peer ACK never bounces 10 back into the source`, () => {
    const f = interleaved(origin);
    f.ack();
    const bounced = f.commands.filter(e => e.target === origin && e.y === 10);
    assert.equal(bounced.length, 0, `stale native ACK reflected into source\n${f.evidence()}`);
  });

  test(`${origin}: ACK10 then ACK20 retain the latest offset 20`, () => {
    const f = interleaved(origin);
    f.ack();
    assert.equal(f.verticalOffsetRef.current, 20, `ACK10 replaced latest offset\n${f.evidence()}`);
    f.ack();
    assert.equal(f.verticalOffsetRef.current, 20, f.evidence());
    f.drain(98);
    assert.equal(f.verticalOffsetRef.current, 20, `old ACKs replaced latest offset\n${f.evidence()}`);
  });
}

test('actual revealCue: pre-reveal native ACKs cannot scroll either column back to old offsets', () => {
  const f = interleaved('labels');
  f.reveal();
  assert.equal(f.verticalOffsetRef.current, 40);
  assert.deepEqual(f.queue.map(e => [e.target, e.y]), [['items', 10], ['items', 20], ['items', 40], ['labels', 40]]);
  const boundary = f.commands.length;
  f.ack();
  assert.equal(f.commands.slice(boundary).filter(e => e.y === 10 || e.y === 20).length, 0,
    `pre-reveal ACK issued a stale command\n${f.evidence()}`);
  assert.equal(f.verticalOffsetRef.current, 40, f.evidence());
});

test('actual revealCue: asynchronous old ACKs settle at the selected row', () => {
  const f = interleaved('labels');
  f.reveal();
  f.drain(100);
  assert.equal(f.queue.length, 0, `reveal feedback did not settle\n${f.evidence()}`);
  assert.equal(f.verticalOffsetRef.current, 40, f.evidence());
  assert.deepEqual(f.positions, { labels: 40, items: 40 }, f.evidence());
});

function coordinator({ density = 1, receiver = () => true } = {}) {
  const commands = [], offsets = [];
  const api = linkedRuntime.createTimelineLinkedScroll({
    round: y => Math.round(y * density) / density,
    offset: y => offsets.push(y),
    scroll: (side, y) => { const accepted = receiver(side, y); if (accepted) commands.push([side, y]); return accepted; },
  });
  return { api, commands, offsets };
}

test('coalesced latest ACK retires skipped values instead of swallowing a later native scroll', () => {
  const h = coordinator();
  for (let y = 1; y <= 60; y++) h.api.sync(y, 'labels');
  assert.equal(h.commands.length, 60);
  h.api.sync(60, 'items'); // Native may coalesce the preceding 59 ACKs.
  h.api.sync(10, 'items'); // A later idle accessibility/native scroll is new input.
  assert.equal(h.offsets.at(-1), 10);
  assert.deepEqual(h.commands.at(-1), ['labels', 10]);
});

test('native pixel rounding acknowledges fractional dp offsets without a feedback command', () => {
  const h = coordinator({ density: 3 });
  h.api.sync(1.2, 'labels');
  assert.deepEqual(h.commands, [['items', 4 / 3]]);
  h.api.sync(1.333333373, 'items');
  assert.equal(h.commands.length, 1);
  assert.equal(h.offsets.at(-1), 4 / 3);
});

test('a clamped mirror ACK does not pull the originating native scroll backward', () => {
  const h = coordinator();
  h.api.layout('items', { viewport: 100, content: 200 });
  h.api.layout('labels', { viewport: 100, content: 300 });
  h.api.begin('labels', 0, 1);
  h.api.sync(150, 'labels', { timestamp: 2 });
  assert.deepEqual(h.commands, [['items', 100]]);
  h.api.sync(100, 'items', { timestamp: 3 });
  assert.equal(h.offsets.at(-1), 150);
  assert.equal(h.commands.length, 1);
});

test('an explicit reveal uses measured native limits immediately and retains its logical request for later layout', () => {
  const h = coordinator();
  for (const side of ['items', 'labels']) h.api.layout(side, { viewport: 100, content: 200 });
  h.api.sync(150, 'reveal');
  assert.equal(h.offsets.at(-1), 100, 'publish the reachable offset, not an impossible drag origin');
  h.api.sync(100, 'items');h.api.sync(100, 'labels');
  for (const side of ['items', 'labels']) h.api.layout(side, { content: 300 });
  assert.equal(h.offsets.at(-1), 150, 'finish the explicit request when native content is ready');
});

test('a physical drag revokes delayed reveal work across reflow', () => {
  const h = coordinator();h.api.sync(300, 'reveal');
  h.api.begin('labels', 10, 100);h.api.sync(20, 'labels', { timestamp: 101 });
  for (const side of ['items', 'labels']) h.api.layout(side, { viewport: 100, content: 600 });
  assert.equal(h.offsets.at(-1), 20);
  assert.ok(h.commands.at(-1)[1] !== 300);
});

test('a temporarily missing receiver leaves no false ACK and can synchronize when attached', () => {
  let ready = false;const h = coordinator({ receiver: () => ready });
  h.api.sync(20, 'labels');assert.equal(h.commands.length, 0);
  ready = true;h.api.layout('items', { viewport: 100, content: 300 });
  assert.deepEqual(h.commands, [['items', 20]]);
  h.api.sync(20, 'items');assert.equal(h.commands.length, 1);
});

test('a throwing native command remains an error and does not poison a later retry', () => {
  let fail = true;const h = coordinator({ receiver: () => { if (fail) throw Error('native failure');return true; } });
  assert.throws(() => h.api.sync(20, 'labels'), /native failure/);
  fail = false;h.api.layout('items', { viewport: 100, content: 300 });
  assert.deepEqual(h.commands, [['items', 20]]);
  h.api.sync(20, 'items');assert.equal(h.commands.length, 1);
});

test('a new gesture rejects earlier native timestamps and accepts deliberate reversals', () => {
  const h = coordinator();h.api.sync(20, 'labels');
  h.api.begin('items', 20, 100);
  h.api.sync(5, 'items', { timestamp: 99 });assert.equal(h.offsets.at(-1), 20);
  h.api.sync(5, 'items', { timestamp: 101 });assert.equal(h.offsets.at(-1), 5);
  assert.deepEqual(h.commands.at(-1), ['labels', 5]);
});

test('replacement native targets synchronize and reject old-host events', () => {
  const h = coordinator();h.api.layout('items', { viewport: 100, content: 300, target: 1 });
  h.api.sync(20, 'labels');h.api.sync(20, 'items', { target: 1 });
  h.api.layout('items', { target: 2 });assert.deepEqual(h.commands.at(-1), ['items', 20]);
  const writes = h.offsets.length;
  h.api.sync(40, 'items', { target: 1 });h.api.begin('items', 40, 100, 1);
  assert.equal(h.offsets.length, writes);
  h.api.sync(20, 'items', { target: 2 });assert.equal(h.offsets.at(-1), 20);
});

test('a replacement native target receives an unchanged explicit reveal', () => {
  const h = coordinator();
  h.api.layout('items', { viewport: 100, content: 300, target: 1 });
  h.api.sync(40, 'reveal');
  h.api.sync(40, 'items', { target: 1 });h.api.sync(40, 'labels');
  const boundary = h.commands.length;
  h.api.layout('items', { target: 2 });
  assert.deepEqual(h.commands.slice(boundary), [['items', 40]], 'the new host starts at zero even when the canonical reveal has not changed');
});

test('native metadata rejects nonnumeric fields without changing valid target identity', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(linkedRuntime.timelineScrollMetadata({ target: 4, timestamp: 100 }))), { target: 4, timestamp: 100 });
  assert.deepEqual(JSON.parse(JSON.stringify(linkedRuntime.timelineScrollMetadata({ target: '4', timestamp: NaN }))), {});
});

test('actual layout and content callbacks clamp a reveal and finish it when the rows become available', () => {
  const f = fixture();
  for (const [side, target] of [['items', 4], ['labels', 8]]) {
    f.lifecycleHandlers[side].onLayout({ nativeEvent: { target, layout: { height: 100 } } });
    f.lifecycleHandlers[side].onContentSizeChange(200, 110);
  }
  f.reveal();f.drain();
  assert.equal(f.verticalOffsetRef.current, 10);
  for (const side of ['items', 'labels']) f.lifecycleHandlers[side].onContentSizeChange(200, 200);
  f.drain();
  assert.equal(f.verticalOffsetRef.current, 40);
  assert.deepEqual(f.positions, { items: 40, labels: 40 });
});

test('actual drag callbacks hand ownership to current native input and reject old target events', () => {
  const f = fixture(), handlers = f.lifecycleHandlers.items;
  handlers.onLayout({ nativeEvent: { target: 4, layout: { height: 100 } } });
  f.input('labels', 20);
  handlers.onScrollBeginDrag({ nativeEvent: { target: 4, timestamp: 100, contentOffset: { y: 20 } } });
  f.input('items', 5, { target: 4, timestamp: 99 });
  assert.equal(f.verticalOffsetRef.current, 20);
  f.input('items', 5, { target: 4, timestamp: 101 });
  assert.equal(f.verticalOffsetRef.current, 5);
  handlers.onScrollEndDrag({ nativeEvent: { target: 4 } });
  handlers.onTouchCancel();
  handlers.onLayout({ nativeEvent: { target: 12, layout: { height: 100 } } });
  f.input('items', 30, { target: 4, timestamp: 102 });
  assert.equal(f.verticalOffsetRef.current, 5);
  f.input('items', 30, { target: 12, timestamp: 103 });
  assert.equal(f.verticalOffsetRef.current, 30);
});
