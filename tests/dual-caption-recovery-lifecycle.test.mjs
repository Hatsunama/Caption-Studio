import assert from 'node:assert/strict';
import test from 'node:test';
import { mountDual, pairs } from './keyboard-ui-repair-host.mjs';
import { dualCaptionDraftRevision, dualCaptionDraftsFromPairs } from '../src/lib/dual-caption-drafts.ts';

function journalFor(opening) {
  return {
    baseRevision: dualCaptionDraftRevision(dualCaptionDraftsFromPairs(opening)),
    payload: { 'cue-0': { primaryText: 'Recovered source', translatedText: '' } },
  };
}

test('pending recovery keeps its opening snapshot through same-session pair updates', async () => {
  const opening = pairs();
  const resolvers = [];
  const h = mountDual({ pairs: opening }, {
    read: () => new Promise(resolve => resolvers.push(resolve)),
  });
  await h.flush();
  const identity = h.input(0).identity;
  const next = structuredClone(opening);
  next[0].translation.text = 'Translation received during read';
  h.update({ pairs: next });
  await h.flush();
  assert.equal(h.calls.reads.length, 1, 'pair updates must not cancel and restart the opening read');
  resolvers[0](journalFor(opening));
  await h.flush();
  assert.equal(h.calls.alerts.length, 1);
  assert.doesNotMatch(h.calls.alerts[0][1], /Recovery conflict/);
  h.choose('Restore unsaved typing');
  await h.flush();
  assert.equal(h.input(0).props.value, 'Recovered source');
  assert.equal(h.input(0, 'Chinese').props.value, 'Translation received during read');
  assert.equal(h.input(0).identity, identity);
  assert.equal(h.input(0).props.editable, true);
});

for (const choice of ['Keep current translation', 'Restore unsaved typing']) {
  test(`unresolved ${choice} survives pair updates without another Alert`, async () => {
    const opening = pairs();
    const h = mountDual({ pairs: opening }, { journal: journalFor(opening) });
    await h.flush();
    const originalChoice = h.calls.alerts[0][2].find(button => button.text === choice);
    const identity = h.input(0).identity;
    for (let index = 0; index < 2; index++) {
      const next = structuredClone(h.props.pairs);
      next[0].translation.text = `Latest translation ${index}`;
      h.update({ pairs: next });
      await h.flush();
    }
    assert.equal(h.calls.reads.length, 1);
    assert.equal(h.calls.alerts.length, 1, 'an unresolved native Alert must not be duplicated');
    h.act(() => originalChoice.onPress());
    await h.flush();
    assert.equal(h.input(0).props.editable, true, 'the original Alert callback must remain active');
    assert.equal(h.input(0).props.value, choice === 'Restore unsaved typing' ? 'Recovered source' : 'Source 0');
    assert.equal(h.input(0, 'Chinese').props.value, 'Latest translation 1');
    assert.equal(h.input(0).identity, identity);
  });
}

test('resolved merge recovery retains typing, focused inputs and busy cancellation on pair updates', async () => {
  const original = pairs(2);
  const opening = [{ ...original[0],
    source: { ...original[0].source, text: 'Source 0 Source 1', mergeProvenance: {
      fragments: original.map(pair => ({ captionId: pair.source.id, primaryText: pair.source.text,
        translations: { zh: pair.translation.text } })),
    } },
    translation: { ...original[0].translation, text: 'Translation 0 Translation 1' },
  }];
  let requestBack;
  const h = mountDual({ pairs: opening, onBackRequestChange: request => { requestBack = request; } }, {
    journal: { baseRevision: dualCaptionDraftRevision(dualCaptionDraftsFromPairs(original)), payload: {
      'cue-1': { primaryText: 'Recovered second source', translatedText: 'Recovered second translation' },
    } },
  });
  await h.flush();
  h.choose('Restore unsaved typing');
  await h.flush();
  assert.equal(h.input(0).props.value, 'Source 0 Recovered second source');
  assert.equal(h.input(0, 'Chinese').props.value, 'Translation 0 Recovered second translation');
  const sourceIdentity = h.input(0).identity;
  const translationIdentity = h.input(0, 'Chinese').identity;
  h.act(() => h.input(0, 'Chinese').props.onFocus());
  const focusTarget = h.focusCalls.at(-1);
  h.edit(0, 'Typing after recovery', 'Chinese');
  h.update({ pairs: structuredClone(opening), busy: true });
  await h.flush();
  h.act(() => requestBack());
  assert.equal(h.calls.cancel, 1);
  assert.equal(h.calls.close, 0);
  h.update({ busy: false });
  await h.flush();
  assert.equal(h.calls.reads.length, 1);
  assert.equal(h.calls.alerts.length, 1);
  assert.equal(h.input(0).identity, sourceIdentity);
  assert.equal(h.input(0, 'Chinese').identity, translationIdentity);
  assert.equal(h.input(0, 'Chinese').props.value, 'Typing after recovery');
  h.act(() => h.input(0, 'Chinese').props.onContentSizeChange());
  assert.equal(h.focusCalls.at(-1), focusTarget);
  assert.equal(h.blurCalls.length, 0);
  await h.advance(600);
  assert.equal(h.calls.writes.at(-1)[3]['cue-0'].translatedText, 'Typing after recovery');
});

test('project, track and reopen lifetimes reject stale recovery reads and Alert callbacks', async () => {
  const resolvers = [];
  const h = mountDual({}, { read: () => new Promise(resolve => resolvers.push(resolve)) });
  await h.flush();
  h.update({ projectId: 'other-project' });
  await h.flush();
  resolvers[0](journalFor(pairs()));
  await h.flush();
  assert.equal(h.calls.alerts.length, 0);
  resolvers[1](journalFor(pairs()));
  await h.flush();
  const oldRestore = h.calls.alerts[0][2].find(button => button.text === 'Restore unsaved typing');
  h.update({ trackId: 'fr' });
  await h.flush();
  resolvers[2](null);
  await h.flush();
  h.act(() => oldRestore.onPress());
  assert.equal(h.input(0).props.value, 'Source 0');
  h.edit(0, 'Previous session typing');
  h.update({ visible: false });
  await h.advance(1000);
  assert.equal(h.calls.writes.length, 0);
  h.update({ visible: true });
  await h.flush();
  resolvers[3](null);
  await h.flush();
  assert.equal(h.input(0).props.value, 'Source 0');
  assert.equal(h.input(0).props.editable, true);
  assert.deepEqual(h.calls.reads.map(args => args.slice(0, 2)), [
    ['project', 'dual-captions-zh'], ['other-project', 'dual-captions-zh'],
    ['other-project', 'dual-captions-fr'], ['other-project', 'dual-captions-fr'],
  ]);
});
