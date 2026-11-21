import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixtures/video-caption-split.mjs';
import { splitVideoClip, reorderVideoClip } from '../src/lib/project-editor.ts';
import {
  createTranslationCaptionTrack, updatePairedCaptionTexts,
  setTranslationCueStyle, setTranslationCueTiming, setTranslationCueSkipped,
  resolveCaptionPairs,
} from '../src/lib/caption-tracks.ts';
import { serializeProjectSnapshot, decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import { buildClipTimeline } from '../src/lib/video-timeline.ts';

// Added against the parent's translation candidate, after its production edits.
// No pre-candidate RED result is claimed. Run with the existing register-hooks.mjs.
const targetStyle = { textColor: '#FEDCBA', italic: true };
const track = project => project.captionTracks.translations[0];
const cueFor = (project, id) => track(project).cues.find(cue => cue.sourceCaptionId === id);
const crossing = project => project.captions.filter(caption => caption.styleOverride?.textColor === '#123456');
const bounds = item => [item.startMs, item.endMs];
const roundTrip = project => decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
const persisted = value => JSON.parse(JSON.stringify(value));
const metadata = cue => {
  const { startMs, endMs, ...rest } = persisted(cue);
  return rest;
};

function translated(mode = 'automatic') {
  let project = fixture(mode);
  project = createTranslationCaptionTrack(project, {
    id: 'de', languageTag: 'de', displayName: 'German',
    translations: Object.fromEntries(project.captions.map(caption => [caption.id, `Saved target ${caption.id}`])),
  });
  project = updatePairedCaptionTexts(project, project.captions.map(caption => ({
    trackId: 'de', sourceCaptionId: caption.id,
    translatedText: `Saved target ${caption.id}`, translationStatus: 'reviewed',
  })));
  project = setTranslationCueStyle(project, 'de', 'c2', targetStyle);
  return roundTrip(project); // Verify fixture validity before exercising edits.
}

function split(project, clipId, cut, left, right) {
  const before = persisted(project);
  const result = splitVideoClip(project, clipId, cut, left, right);
  assert.ok(result, `split ${clipId} at ${cut} must succeed`);
  assert.deepEqual(persisted(project), before, 'split must not mutate persisted input state');
  return result.project;
}

function reorder(project, clipId, index) {
  const before = persisted(project);
  const result = reorderVideoClip(project, clipId, index);
  assert.ok(result, `reorder ${clipId} to ${index} must succeed`);
  assert.deepEqual(persisted(project), before, 'reorder must not mutate persisted input state');
  return result.project;
}

function assertOwnership(project) {
  const sources = new Map(project.captions.map(caption => [caption.id, caption]));
  assert.equal(sources.size, project.captions.length, 'primary IDs must be unique');
  const cues = track(project).cues;
  assert.equal(cues.length, sources.size, 'one target record per source fragment');
  assert.equal(new Set(cues.map(cue => cue.id)).size, cues.length, 'target IDs must be unique');
  assert.equal(new Set(cues.map(cue => cue.sourceCaptionId)).size, cues.length, 'source links must be unique');
  for (const cue of cues) assert.ok(sources.has(cue.sourceCaptionId), `orphan target ${cue.id}`);
  const targetIds = new Set(cues.map(cue => cue.id));
  for (const id of Object.keys(project.captionTracks.independentTimingOrigins ?? {})) {
    assert.ok(targetIds.has(id), `orphan independent timing origin ${id}`);
  }
  // Prove c2's exact partition in source coordinates, independent of caption IDs
  // and current timeline order; counts alone cannot establish ownership.
  const expected = project.clips.map(clip => ({
    clipId: clip.id,
    start: Math.max(1690, clip.sourceStartMs),
    end: Math.min(3230, clip.sourceEndMs),
  })).filter(piece => piece.end > piece.start).sort((a, b) => a.start - b.start);
  const actual = crossing(project).map(source => {
    assert.equal(source.timingMode, 'source');
    assert.ok(source.sourceAnchor);
    const anchor = source.sourceAnchor;
    const owner = buildClipTimeline(project.clips).find(entry => entry.clip.id === anchor.clipId);
    assert.ok(owner);
    assert.equal(owner.clip.sourceId, 'source');
    assert.deepEqual(bounds(source), [
      owner.startMs + (anchor.sourceStartMs - owner.clip.sourceStartMs) / owner.clip.playbackRate,
      owner.startMs + (anchor.sourceEndMs - owner.clip.sourceStartMs) / owner.clip.playbackRate,
    ], 'timeline bounds must project the anchored source interval');
    const support = project.transcription.words.filter(word => word.id.startsWith(`${anchor.clipId}-`)
      && word.startMs < source.endMs && word.endMs > source.startMs).map(word => word.id);
    assert.deepEqual(source.wordIds, support, 'word references must belong to this clip occurrence');
    assert.deepEqual(anchor.wordIds, support, 'anchor and primary must reference the same support');
    return { clipId: anchor.clipId, start: anchor.sourceStartMs, end: anchor.sourceEndMs };
  }).sort((a, b) => a.start - b.start);
  assert.deepEqual(actual, expected, 'c2 fragments must cover exactly their source intersections with the split clips');
}

function assertInherited(project, source) {
  const cue = cueFor(project, source.id);
  assert.ok(cue, `missing target for ${source.id}`);
  assert.deepEqual(bounds(cue), bounds(source), `inherited target bounds for ${source.id}`);
  assert.equal(project.captionTracks.independentTimingOrigins?.[cue.id], undefined);
  assert.equal(source.timingMode, 'source');
  assert.ok(source.sourceAnchor, 'fragment must retain source ownership');
  const owner = buildClipTimeline(project.clips).find(entry => entry.clip.id === source.sourceAnchor.clipId);
  assert.ok(owner, 'fragment owner must exist');
  assert.ok(cue.startMs >= owner.startMs && cue.endMs <= owner.endMs, 'target must stay inside its video piece');
  return cue;
}

function checkSaved(project, check) {
  check(project); // Decode must not be what repairs the operation result.
  const restored = roundTrip(project);
  check(restored);
  return restored;
}

for (const cut of [1749, 2784]) {
  test(`${cut}: full manual source edit and reviewed translation survive in both inherited fragments`, () => {
    const original = translated('manual');
    const oldSource = original.captions.find(caption => caption.id === 'c2');
    const oldTarget = cueFor(original, 'c2');
    assert.equal(oldSource.timingMode, 'source');
    assert.equal(oldSource.text, 'Edited words remain mine.');
    const check = project => {
      assertOwnership(project);
      const pieces = crossing(project);
      assert.equal(pieces.length, 2);
      for (const source of pieces) {
        assert.equal(source.text, oldSource.text, 'duplicate the complete manual edit, without invented alignment');
        assert.equal(source.textMode, oldSource.textMode);
        const cue = assertInherited(project, source);
        assert.equal(cue.text, oldTarget.text);
        assert.equal(cue.sourceTextSnapshot, oldTarget.sourceTextSnapshot);
        assert.equal(cue.status, 'reviewed', 'an unchanged source snapshot remains reviewed');
        assert.equal(cue.reviewed, true);
        assert.deepEqual(cue.styleOverride, targetStyle);
      }
    };
    const divided = checkSaved(split(original, 'original', cut, 'left', 'right'), check);
    checkSaved(reorder(divided, 'right', 0), check);
  });

  for (const text of ['', 'Saved text from the failed attempt']) {
    test(`${cut}: failed inherited fragments retain ${text ? 'saved' : 'empty'} text and failure provenance`, () => {
      let original = translated();
      // There is no failure mutation API in this mirror. Seed valid persisted state,
      // including reviewed:false (the decoder rejects failed+reviewed:true).
      Object.assign(cueFor(original, 'c2'), {
        text, status: 'failed', reviewed: false,
        failureReason: 'Model unavailable for this cue',
      });
      original = roundTrip(original);
      const oldTarget = structuredClone(cueFor(original, 'c2'));
      const check = project => {
        assertOwnership(project);
        assert.equal(crossing(project).length, 2);
        for (const source of crossing(project)) {
          const cue = assertInherited(project, source);
          assert.equal(cue.status, 'failed', 'a split/reorder must not masquerade as translation success');
          assert.equal(cue.reviewed, false);
          assert.equal(cue.text, oldTarget.text);
          assert.equal(cue.failureReason, oldTarget.failureReason);
          assert.equal(cue.sourceTextSnapshot, oldTarget.sourceTextSnapshot);
          assert.deepEqual(cue.styleOverride, targetStyle);
          const pair = resolveCaptionPairs(project, 'de').find(pair => pair.source.id === source.id);
          assert.equal(pair.displayProvenance, text ? 'translation' : 'source-fallback');
          assert.equal(pair.displayText, text || source.text);
        }
      };
      const divided = checkSaved(split(original, 'original', cut, 'left', 'right'), check);
      checkSaved(reorder(divided, 'right', 0), check);
    });
  }

  test(`${cut}: deliberately skipped and hidden target flags survive in both fragments`, () => {
    let original = setTranslationCueSkipped(translated(), 'de', 'c2', true);
    // Visibility is persisted cue state; this mirror exposes no cue visibility setter.
    cueFor(original, 'c2').timelineVisible = false;
    original = roundTrip(original);
    const saved = structuredClone(cueFor(original, 'c2'));
    const check = project => {
      assertOwnership(project);
      assert.equal(crossing(project).length, 2);
      for (const source of crossing(project)) {
        const cue = assertInherited(project, source);
        assert.equal(cue.translationSkipped, true);
        assert.equal(cue.timelineVisible, false);
        assert.equal(cue.text, saved.text);
        assert.equal(cue.sourceTextSnapshot, saved.sourceTextSnapshot);
        assert.equal(cue.status, source.text === saved.sourceTextSnapshot ? 'reviewed' : 'stale');
        assert.equal(cue.reviewed, true);
        assert.deepEqual(cue.styleOverride, targetStyle);
        assert.equal(resolveCaptionPairs(project, 'de').find(pair => pair.source.id === source.id).timelineVisible, false);
      }
    };
    const divided = checkSaved(split(original, 'original', cut, 'left', 'right'), check);
    checkSaved(reorder(divided, 'right', 0), check);
  });

  test(`${cut}: independently edited target and origin occur once; child is blank pending`, () => {
    let original = translated();
    original = updatePairedCaptionTexts(original, [{
      trackId: 'de', sourceCaptionId: 'c2', translatedText: 'My independently edited target', translationStatus: 'reviewed',
    }]);
    original = setTranslationCueTiming(original, 'de', 'c2', 'start', 1800, 3230);
    original = setTranslationCueTiming(original, 'de', 'c2', 'end', 1800, 3100);
    original = roundTrip(original);
    const saved = structuredClone(cueFor(original, 'c2'));
    assert.deepEqual(bounds(saved), [1800, 3100], 'establish the actual timing API result');
    assert.equal(original.captionTracks.independentTimingOrigins[saved.id], 0);
    const check = (project, afterSplit) => {
      assertOwnership(project);
      assert.equal(crossing(project).length, 2);
      const kept = cueFor(project, 'c2');
      assert.equal(track(project).cues.filter(cue => cue.text === saved.text).length, 1);
      const source = project.captions.find(caption => caption.id === 'c2');
      // The reviewed boolean records historical human acceptance. Status alone
      // becomes stale when the current source differs from the saved snapshot.
      assert.deepEqual(metadata(kept), {
        ...metadata(saved), status: source.text === saved.sourceTextSnapshot ? 'reviewed' : 'stale',
      });
      if (afterSplit) assert.deepEqual(bounds(kept), bounds(saved), 'split preserves independent bounds exactly');
      assert.deepEqual(project.captionTracks.independentTimingOrigins, { [saved.id]: 0 });
      const childSource = crossing(project).find(source => source.id !== 'c2');
      const child = assertInherited(project, childSource);
      assert.equal(child.text, '');
      assert.equal(child.status, 'pending');
      assert.equal(child.reviewed, false);
      assert.equal(child.sourceTextSnapshot, childSource.text);
      assert.equal(child.failureReason, undefined);
      assert.deepEqual(child.styleOverride, targetStyle);
    };
    const divided = checkSaved(split(original, 'original', cut, 'left', 'right'), project => check(project, true));
    checkSaved(reorder(divided, 'right', 0), project => check(project, false));
    assert.deepEqual(cueFor(original, 'c2'), saved, 'original edited target remains unchanged');
  });

  test(`${cut}: noncrossing cues preserve metadata and need no fetch during pure edits/save`, t => {
    const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected model/network request'); });
    let original = translated();
    original = setTranslationCueSkipped(original, 'de', 'c3', true);
    Object.assign(cueFor(original, 'c4'), { text: '', status: 'failed', reviewed: false, failureReason: 'Retained failure' });
    cueFor(original, 'c5').timelineVisible = false;
    original = roundTrip(original);
    const unaffected = track(original).cues.filter(cue => cue.sourceCaptionId !== 'c2').map(cue => structuredClone(cue));
    const check = project => {
      assertOwnership(project);
      for (const saved of unaffected) {
        const source = project.captions.find(caption => caption.id === saved.sourceCaptionId);
        const cue = assertInherited(project, source);
        assert.deepEqual(metadata(cue), metadata(saved), `noncrossing metadata for ${source.id}`);
      }
      assert.equal(track(project).cues.filter(cue => cue.status === 'pending').length, 0);
      assert.equal(fetchSpy.mock.callCount(), 0);
    };
    const divided = checkSaved(split(original, 'original', cut, 'left', 'right'), check);
    for (const saved of unaffected) assert.deepEqual(cueFor(divided, saved.sourceCaptionId), saved);
    checkSaved(reorder(divided, 'right', 0), check);
  });
}

for (const mode of ['automatic', 'manual']) {
  test(`${mode}: repeated split/reorder preserves accepted child text, snapshots and fragment ownership`, () => {
    const original = translated(mode);
    const oldTarget = structuredClone(cueFor(original, 'c2'));
    let project = split(original, 'original', 2784, 'left', 'right');
    const firstChild = crossing(project).find(source => source.id !== 'c2');
    assert.ok(firstChild);
    project = updatePairedCaptionTexts(project, [{
      trackId: 'de', sourceCaptionId: firstChild.id,
      translatedText: 'Accepted first child target', translationStatus: 'reviewed',
    }]);
    const acceptedChild = structuredClone(cueFor(project, firstChild.id));
    project = roundTrip(project);
    project = split(project, 'left', 1749, 'left-a', 'left-b');
    const check = current => {
      assertOwnership(current);
      assert.equal(current.captions.length, original.captions.length + 2);
      assert.equal(crossing(current).length, 3);
      for (const source of crossing(current)) {
        const saved = source.id === firstChild.id ? acceptedChild : oldTarget;
        const cue = assertInherited(current, source);
        assert.equal(cue.text, saved.text);
        assert.equal(cue.sourceTextSnapshot, saved.sourceTextSnapshot, 'retain snapshot belonging to the accepted target');
        assert.equal(cue.status, source.text === saved.sourceTextSnapshot ? 'reviewed' : 'stale');
        assert.equal(cue.reviewed, true);
        assert.deepEqual(cue.styleOverride, targetStyle);
      }
      assert.equal(track(current).cues.filter(cue => cue.text === acceptedChild.text).length, 1);
      for (const saved of track(original).cues.filter(cue => cue.sourceCaptionId !== 'c2')) {
        assert.deepEqual(metadata(cueFor(current, saved.sourceCaptionId)), metadata(saved));
      }
    };
    project = checkSaved(project, check);
    project = checkSaved(reorder(project, 'right', 0), check);
    project = checkSaved(reorder(project, 'left-b', 0), check);
    checkSaved(reorder(project, 'left-a', 0), check);
  });
}
