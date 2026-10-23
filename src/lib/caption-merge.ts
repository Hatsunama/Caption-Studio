import type { CaptionBlock, CaptionProject, TranslationCaptionCue } from '@/types/project';
import { captionCjkCharacterCount, captionLayoutText, captionSpokenTokenSpans, captionTextLength } from '@/lib/caption-text-breaks';
import { groupingOptionsForLanguage } from '@/lib/caption-grouping';

export const MAX_CAPTION_MERGE_FRAGMENTS = 32;
type Fragment = NonNullable<CaptionBlock['mergeProvenance']>['fragments'][number];

function equivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length
    && keys.every(key => equivalent(left[key], right[key]));
}

export function captionMergeFragments(caption: CaptionBlock): Fragment[] {
  if (caption.mergeProvenance) return caption.mergeProvenance.fragments;
  const { mergeProvenance: _history, ...primary } = caption;
  return [{ captionId: caption.id, primaryText: caption.text, translations: {}, primary }];
}

export function joinedCaptionProvenance(left: CaptionBlock, right: CaptionBlock) {
  const fragments = [...captionMergeFragments(left), ...captionMergeFragments(right)];
  const aliasesRetired = left.mergeProvenance?.aliasesRetired || right.mergeProvenance?.aliasesRetired;
  if (fragments.length > MAX_CAPTION_MERGE_FRAGMENTS
    || (!aliasesRetired && new Set(fragments.map(fragment => fragment.captionId)).size !== fragments.length)) {
    throw new Error('Caption merge history exceeds its 32-fragment bound or repeats an identity. Originals were preserved.');
  }
  const previousJoins = [...(left.mergeProvenance?.previousJoins ?? []), ...(right.mergeProvenance?.previousJoins ?? [])];
  if (previousJoins.length > 30) throw new Error('Caption merge history bound reached. Originals were preserved.');
  return { fragments, ...(aliasesRetired ? { aliasesRetired: true } : {}), ...(previousJoins.length ? { previousJoins } : {}) };
}

function inheritedTiming(cue: TranslationCaptionCue, caption: CaptionBlock) {
  return (cue.startMs === undefined || cue.startMs === caption.startMs)
    && (cue.endMs === undefined || cue.endMs === caption.endMs);
}

function automaticPairCompatible(project: CaptionProject, left: CaptionBlock, right: CaptionBlock) {
  if (left.mergeProvenance?.aliasesRetired || right.mergeProvenance?.aliasesRetired
    || !left.sourceAnchor || !right.sourceAnchor || left.sourceAnchor.clipId !== right.sourceAnchor.clipId
    || left.timingMode === 'timeline' || right.timingMode === 'timeline'
    || left.timelineVisible === false || right.timelineVisible === false
    || !equivalent(left.styleOverride ?? {}, right.styleOverride ?? {})) return false;
  return (project.captionTracks?.translations ?? []).every(track => {
    const a = track.cues.find(cue => cue.sourceCaptionId === left.id);
    const b = track.cues.find(cue => cue.sourceCaptionId === right.id);
    if (!a || !b) return !a && !b;
    return equivalent(a.styleOverride ?? {}, b.styleOverride ?? {})
      && project.captionTracks.independentTimingOrigins?.[a.id] === project.captionTracks.independentTimingOrigins?.[b.id]
      && (a.timelineVisible !== false) === (b.timelineVisible !== false)
      && Boolean(a.translationSkipped) === Boolean(b.translationSkipped)
      && !a.failureReason && !b.failureReason && a.status !== 'failed' && b.status !== 'failed'
      && inheritedTiming(a, left) && inheritedTiming(b, right);
  });
}

function fragmentsWithTracks(project: CaptionProject, caption: CaptionBlock): Fragment[] {
  const fragments = captionMergeFragments(caption).map(fragment => ({
    ...fragment, translations: { ...fragment.translations }, translationCues: { ...fragment.translationCues },
    ...(fragment.translationOrigins ? { translationOrigins: { ...fragment.translationOrigins } } : {}),
  }));
  for (const track of project.captionTracks?.translations ?? []) {
    const cue = track.cues.find(item => item.sourceCaptionId === caption.id);
    if (!cue) continue;
    if (!caption.mergeProvenance) {
      fragments[0].translations[track.id] = cue.text;
      fragments[0].translationCues[track.id] = cue;
      const origin = project.captionTracks.independentTimingOrigins?.[cue.id];
      if (origin !== undefined) (fragments[0].translationOrigins ??= {})[track.id] = origin;
    } else {
      // A track added after a merge has no old per-fragment text to recover.
      if (!fragments.some(fragment => Object.hasOwn(fragment.translations, track.id))) {
        fragments[0].translations[track.id] = cue.text;
      }
    }
  }
  return fragments;
}

/** Explicit joins combine metadata; automatic joins must be losslessly compatible. */
export function mergeProjectCaptionPair(project: CaptionProject, leftId: string, rightId: string, automatic = false): CaptionProject | null {
  const ordered = [...project.captions].filter(caption => caption.timelineVisible !== false)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const index = ordered.findIndex(caption => caption.id === leftId);
  const left = ordered[index], right = ordered[index + 1];
  if (!left || !right || right.id !== rightId) return null;
  if (automatic && !automaticPairCompatible(project, left, right)) return null;
  if (automatic) {
    const fragments = [...captionMergeFragments(left), ...captionMergeFragments(right)];
    if (fragments.length > MAX_CAPTION_MERGE_FRAGMENTS
      || new Set(fragments.map(fragment => fragment.captionId)).size !== fragments.length
      || (left.mergeProvenance?.previousJoins?.length ?? 0) + (right.mergeProvenance?.previousJoins?.length ?? 0) > 30) return null;
  }
  const provenance = joinedCaptionProvenance(left, right);
  provenance.fragments = [...fragmentsWithTracks(project, left), ...fragmentsWithTracks(project, right)];
  for (const caption of [left, right]) {
    if (!caption.mergeProvenance) continue;
    const { mergeProvenance: _history, ...primary } = caption;
    const original = { captionIds: caption.mergeProvenance.fragments.map(fragment => fragment.captionId), primary,
      translationCues: Object.fromEntries((project.captionTracks?.translations ?? []).flatMap(track => {
        const cue = track.cues.find(item => item.sourceCaptionId === caption.id);
        return cue ? [[track.id, cue]] : [];
      })),
      translationOrigins: Object.fromEntries((project.captionTracks?.translations ?? []).flatMap(track => {
        const cue = track.cues.find(item => item.sourceCaptionId === caption.id);
        const origin = cue && project.captionTracks.independentTimingOrigins?.[cue.id];
        return origin === undefined ? [] : [[track.id, origin]];
      })),
    };
    (provenance.previousJoins ??= []).push(original);
  }
  if ((provenance.previousJoins?.length ?? 0) > 30) {
    if (automatic) return null;
    throw new Error('Caption merge history bound reached. Originals were preserved.');
  }
  const wordIds = [...new Set([...left.wordIds, ...right.wordIds])];
  const sourceAnchor = left.sourceAnchor && right.sourceAnchor
    && left.sourceAnchor.clipId === right.sourceAnchor.clipId ? {
      clipId: left.sourceAnchor.clipId,
      sourceStartMs: Math.min(left.sourceAnchor.sourceStartMs, right.sourceAnchor.sourceStartMs),
      sourceEndMs: Math.max(left.sourceAnchor.sourceEndMs, right.sourceAnchor.sourceEndMs),
      wordIds: [...new Set([...left.sourceAnchor.wordIds, ...right.sourceAnchor.wordIds])],
    } : undefined;
  const merged: CaptionBlock = {
    ...left, text: captionLayoutText([left.text, right.text]),
    startMs: Math.min(left.startMs, right.startMs), endMs: Math.max(left.endMs, right.endMs), wordIds,
    sourceAnchor, timingMode: sourceAnchor ? 'source' : 'timeline',
    textMode: automatic && left.textMode === 'automatic' && right.textMode === 'automatic' ? 'automatic' : 'manual',
    mergeProvenance: provenance,
  };
  const tracks = project.captionTracks;
  const origins = { ...tracks?.independentTimingOrigins };
  const captionTracks = tracks && { ...tracks, translations: tracks.translations.map(track => {
    const a = track.cues.find(cue => cue.sourceCaptionId === left.id);
    const b = track.cues.find(cue => cue.sourceCaptionId === right.id);
    if (!a && !b) return track;
    const first = a ?? b!;
    const earlier = !a ? b! : !b ? a : (a.startMs ?? left.startMs) <= (b.startMs ?? right.startMs) ? a : b;
    const origin = tracks.independentTimingOrigins?.[earlier.id] ?? 0;
    const independent = (a && (tracks.independentTimingOrigins?.[a.id] !== undefined || !inheritedTiming(a, left)))
      || (b && (tracks.independentTimingOrigins?.[b.id] !== undefined || !inheritedTiming(b, right)));
    if (a) delete origins[a.id];
    if (b) delete origins[b.id];
    if (independent) origins[first.id] = origin;
    const cue: TranslationCaptionCue = {
      ...earlier, id: first.id, sourceCaptionId: left.id,
      text: captionLayoutText([a?.text ?? '', b?.text ?? '']),
      sourceTextSnapshot: captionLayoutText([a?.sourceTextSnapshot ?? left.text, b?.sourceTextSnapshot ?? right.text]),
      status: 'stale', reviewed: false, failureReason: undefined,
      startMs: Math.min(a?.startMs ?? left.startMs, b?.startMs ?? right.startMs),
      endMs: Math.max(a?.endMs ?? left.endMs, b?.endMs ?? right.endMs),
      timelineVisible: a?.timelineVisible !== false || b?.timelineVisible !== false,
      translationSkipped: Boolean(a?.translationSkipped && b?.translationSkipped),
    };
    return { ...track, cues: [...track.cues.filter(item => item.sourceCaptionId !== left.id && item.sourceCaptionId !== right.id), cue]
      .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0)) };
  }), ...(tracks.independentTimingOrigins || Object.keys(origins).length ? { independentTimingOrigins: origins } : {}) };
  return { ...project, captions: project.captions.filter(caption => caption.id !== right.id)
    .map(caption => caption.id === left.id ? merged : caption), ...(captionTracks ? { captionTracks } : {}) };
}

/** Only explicit fragment identities supplied by the script join authorize a merge. */
export function applyCaptionMergeDraft(project: CaptionProject, draft: CaptionBlock[]) {
  let staged = project;
  const retained = new Set(draft.map(caption => caption.id));
  const captions = draft.map(caption => {
    if (!caption.mergeProvenance) return caption;
    let existing = staged.captions.find(item => item.id === caption.id);
    if (!existing) return caption;
    let consumed = captionMergeFragments(existing).length;
    const fragments = caption.mergeProvenance.fragments;
    if (fragments.length <= consumed) return caption;
    while (consumed < fragments.length) {
      const member = staged.captions.find(item => item.id === fragments[consumed].captionId);
      if (!member || retained.has(member.id)) throw new Error('Caption join identities conflict with the draft. Originals were preserved.');
      const count = captionMergeFragments(member).length;
      const next = mergeProjectCaptionPair(staged, caption.id, member.id);
      if (!next) throw new Error('Caption join must combine adjacent visible captions. Originals were preserved.');
      staged = next;
      consumed += count;
    }
    return { ...caption, mergeProvenance: staged.captions.find(item => item.id === caption.id)!.mergeProvenance };
  });
  return { captions, captionTracks: staged.captionTracks };
}

export function minimumCaptionDisplayMs(text: string) {
  return Math.min(500, Math.max(80, captionTextLength(text) * 35));
}

/** Regroup only a short cue and one compatible neighbor; never regenerate words/text. */
export function absorbShortCaptionCues(project: CaptionProject): CaptionProject {
  let next = project;
  let ordered = [...next.captions].filter(caption => caption.timelineVisible !== false && caption.endMs > caption.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  for (let index = 0; index < ordered.length; index++) {
    const cue = ordered[index];
    if (cue.endMs - cue.startMs >= minimumCaptionDisplayMs(cue.text)) continue;
    const options = groupingOptionsForLanguage(next.transcription?.language);
    const candidates = [ordered[index - 1], ordered[index + 1]].filter((item): item is CaptionBlock => !!item)
      .map(neighbor => {
        const left = neighbor.startMs <= cue.startMs ? neighbor : cue;
        const right = left === cue ? neighbor : cue;
        return { left, right, pause: right.startMs - left.endMs, duration: right.endMs - left.startMs,
          text: captionLayoutText([left.text, right.text]) };
      }).filter(candidate => candidate.pause >= 0 && candidate.pause < options.pauseBreakMs
        && candidate.duration <= options.maxDurationMs
        && captionTextLength(candidate.text) <= options.maxCharacters
        && captionCjkCharacterCount(candidate.text) <= options.maxCjkCharacters
        && captionSpokenTokenSpans(candidate.text).filter(token => !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(token.text)).length <= options.maxWords)
      .sort((a, b) => a.pause - b.pause || a.duration - b.duration || a.left.startMs - b.left.startMs);
    for (const candidate of candidates) {
      if (captionMergeFragments(candidate.left).length + captionMergeFragments(candidate.right).length > MAX_CAPTION_MERGE_FRAGMENTS) continue;
      const merged = mergeProjectCaptionPair(next, candidate.left.id, candidate.right.id, true);
      if (!merged) continue;
      next = merged;
      ordered = [...next.captions].filter(caption => caption.timelineVisible !== false && caption.endMs > caption.startMs)
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
      index = Math.max(-1, index - 2);
      break;
    }
  }
  return next;
}
