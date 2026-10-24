import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { captionLayoutText } from '../src/lib/caption-text-breaks.ts';
import { dualCaptionDraftRevision, dualCaptionDraftsFromPairs } from '../src/lib/dual-caption-drafts.ts';

// Reuse the existing complete component harness without changing its tests.
const harnessUrl = new URL('./dual-caption-editor-performance.test.mjs', import.meta.url);
const harnessSource = readFileSync(harnessUrl, 'utf8');
const ast = ts.createSourceFile('harness.mjs', harnessSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const firstTest = ast.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'test');
const modules = new Map();
for (const node of ast.statements.filter(ts.isImportDeclaration)) {
  const specifier = node.moduleSpecifier.text;
  modules.set(specifier, await import(specifier.startsWith('.') ? new URL(specifier, harnessUrl).href : specifier));
}
const harnessExports = {};
const prefix = harnessSource.slice(0, firstTest.getStart(ast)).replaceAll('import.meta.url', '__harnessUrl');
runInNewContext(ts.transpileModule(`${prefix}\nexports.mount = mount; exports.pairs = pairs;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: harnessExports, require: specifier => {
    assert.ok(modules.has(specifier), `Missing harness dependency: ${specifier}`);
    return modules.get(specifier);
  },
  __harnessUrl: harnessUrl.href, URL, process, setTimeout, clearTimeout });
const { mount, pairs } = harnessExports;

function joinedPairs() {
  const original = pairs(2);
  const [left, right] = original;
  return { original, combined: [{ ...left,
    source: { ...left.source, text: captionLayoutText(original.map(pair => pair.source.text)),
      mergeProvenance: { fragments: original.map(pair => ({ captionId: pair.source.id,
        primaryText: pair.source.text, translations: { zh: pair.translation.text } })) } },
    translation: { ...left.translation, text: captionLayoutText(original.map(pair => pair.translation.text)), status: 'stale' },
  }] };
}

test('core worker UI journal: old IDs restore both typed fields into the survivor and save under its ID', async () => {
  const { original, combined } = joinedPairs();
  const h = mount({ pairs: combined }, { journal: {
    baseRevision: dualCaptionDraftRevision(dualCaptionDraftsFromPairs(original)), payload: {
      'cue-0': { primaryText: 'Typed first', translatedText: 'Translation 0' },
      'cue-1': { primaryText: 'Source 1', translatedText: 'Typed second translation' },
    },
  } });
  await h.flush();
  h.choose('Restore unsaved typing');
  await h.flush();
  assert.equal(h.input(0).props.editable, true);
  assert.equal(h.input(0).props.value, 'Typed first Source 1');
  assert.equal(h.input(0, 'Chinese').props.value, 'Translation 0 Typed second translation');
  h.press('Save dual subtitle edits');
  await h.flush();
  assert.equal(h.calls.saves.length, 1);
  assert.equal(h.calls.saves[0][0].sourceCaptionId, 'cue-0');
  assert.equal(h.calls.saves[0][0].translatedText, 'Translation 0 Typed second translation');
});

test('core worker UI journal: blank retired fields keep their original committed fallback', async () => {
  const { original, combined } = joinedPairs();
  const h = mount({ pairs: combined }, { journal: {
    baseRevision: dualCaptionDraftRevision(dualCaptionDraftsFromPairs(original)), payload: {
      'cue-0': { primaryText: '   ', translatedText: '' },
      'cue-1': { primaryText: 'Typed second', translatedText: 'Typed translation' },
    },
  } });
  await h.flush(); h.choose('Restore unsaved typing'); await h.flush();
  assert.equal(h.input(0).props.value, 'Source 0 Typed second');
  assert.equal(h.input(0, 'Chinese').props.value, 'Translation 0 Typed translation');
});

test('core worker UI journal: current revision restores a right split ID that also occurs in a retired archive', async () => {
  const { original, combined } = joinedPairs();
  const split = original.map((pair, index) => ({ ...pair,
    source: index ? pair.source : { ...pair.source, mergeProvenance: { ...combined[0].source.mergeProvenance, aliasesRetired: true } },
    translation: index ? { ...pair.translation, text: '' } : combined[0].translation,
  }));
  const committed = dualCaptionDraftsFromPairs(split);
  const h = mount({ pairs: split }, { journal: { baseRevision: dualCaptionDraftRevision(committed), payload: {
    ...committed, 'cue-1': { primaryText: 'Typed right split', translatedText: 'Typed right split translation' },
  } } });
  await h.flush(); h.choose('Restore unsaved typing'); await h.flush();
  assert.equal(h.input(0).props.value, 'Source 0');
  assert.equal(h.input(1).props.value, 'Typed right split');
  assert.equal(h.input(1, 'Chinese').props.value, 'Typed right split translation');
  h.press('Save dual subtitle edits'); await h.flush();
  assert.equal(h.calls.saves[0][0].sourceCaptionId, 'cue-1');
});

for (const kind of ['unknown identity', 'changed joined text', 'ambiguous survivor identity']) {
  test(`core worker UI journal: ${kind} preserves recovery storage and permits current editing`, async () => {
    const { combined } = joinedPairs();
    if (kind === 'changed joined text') combined[0].source.text = 'Changed after join';
    const payload = { [kind === 'unknown identity' ? 'missing-cue' : kind === 'ambiguous survivor identity' ? 'cue-0' : 'cue-1']:
      { primaryText: 'Retain old typing', translatedText: 'Retain old translation' } };
    const h = mount({ pairs: combined }, { journal: { baseRevision: 'older', payload } });
    await h.flush();
    assert.equal(h.input(0).props.editable, true);
    assert.ok(h.all(node => node.props.accessibilityRole === 'alert' && /preserved/i.test(String(node.props.children))).length > 0);
    h.edit(0, 'Current usable edit');
    await h.advance(1000);
    assert.equal(h.calls.writes.length, 0);
    assert.equal(h.calls.clears.length, 0);
    h.press('Save dual subtitle edits');
    await h.flush();
    assert.equal(h.calls.saves[0][0].primaryText, 'Current usable edit');
    assert.equal(h.calls.clears.length, 0);
    assert.equal(payload[Object.keys(payload)[0]].translatedText, 'Retain old translation');
  });
}
