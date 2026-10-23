import type { CaptionBlock } from '@/types/project';
import { captionLayoutText } from '@/lib/caption-text-breaks';

export type DualCaptionDraft = {
  primaryText: string;
  translatedText: string;
};

type DualCaptionPairLike = {
  source: { id: string; text: string; mergeProvenance?: CaptionBlock['mergeProvenance'] };
  translation: { text: string };
};

export function dualCaptionDraftsFromPairs(
  pairs: readonly DualCaptionPairLike[],
): Record<string, DualCaptionDraft> {
  return Object.fromEntries(pairs.map((pair) => [pair.source.id, {
    primaryText: pair.source.text,
    translatedText: pair.translation.text,
  }]));
}

export function dualCaptionDraftsMatch(
  left: Record<string, DualCaptionDraft>,
  right: Record<string, DualCaptionDraft>,
) {
  const ids = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const id of ids) {
    const current = left[id];
    const next = right[id];
    if (!current || !next) return false;
    if (current.primaryText !== next.primaryText || current.translatedText !== next.translatedText) return false;
  }
  return true;
}

// A timestamp can be shared by distinct edits in the same millisecond. Bind
// recovery to the exact committed text and cue set seen when the editor opened.
export function dualCaptionDraftRevision(drafts: Record<string, DualCaptionDraft>) {
  const content = JSON.stringify(Object.entries(drafts).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `dual-v2:${content.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

export function adoptCommittedDualCaptionDrafts(
  previousCommitted: Record<string, DualCaptionDraft>,
  nextCommitted: Record<string, DualCaptionDraft>,
  drafts: Record<string, DualCaptionDraft>,
): Record<string, DualCaptionDraft> {
  return Object.fromEntries(Object.entries(nextCommitted).map(([id, committed]) => {
    const previous = previousCommitted[id];
    const draft = drafts[id] ?? committed;
    const primaryUnedited = !previous || draft.primaryText === previous.primaryText;
    const translatedUnedited = !previous || draft.translatedText === previous.translatedText;
    return [id, {
      primaryText: primaryUnedited ? committed.primaryText : draft.primaryText,
      translatedText: translatedUnedited ? committed.translatedText : draft.translatedText,
    }];
  }));
}

export function mergeRecoveredDualCaptionDrafts(
  recovered: Record<string, DualCaptionDraft>,
  committed: Record<string, DualCaptionDraft>,
): Record<string, DualCaptionDraft> {
  return Object.fromEntries(Object.entries(committed).map(([id, committedDraft]) => {
    const recoveredDraft = recovered[id];
    if (!recoveredDraft) return [id, committedDraft];
    return [id, {
      primaryText: recoveredDraft.primaryText,
      translatedText: recoveredTranslationLooksCommitted(recoveredDraft, committedDraft)
        ? recoveredDraft.translatedText
        : committedDraft.translatedText,
    }];
  }));
}

export function committedDualCaptionText(draftText: string, committedText: string) {
  return draftText.trim() || committedText.trim();
}

export function shouldRestoreDualCaptionJournal(
  recovered: Record<string, DualCaptionDraft>,
  committed: Record<string, DualCaptionDraft>,
) {
  const merged = mergeRecoveredDualCaptionDrafts(recovered, committed);
  if (dualCaptionDraftsMatch(merged, committed)) return false;
  return Object.entries(merged).some(([id, draft]) => {
    const committedDraft = committed[id];
    if (!committedDraft) return false;
    const recoveredDraft = recovered[id];
    if (!recoveredDraft) return false;
    const primaryEdited = recoveredDraft.primaryText !== committedDraft.primaryText;
    const translationEdited = recoveredTranslationLooksCommitted(recoveredDraft, committedDraft)
      && recoveredDraft.translatedText !== committedDraft.translatedText;
    return primaryEdited || translationEdited;
  });
}

function recoveredTranslationLooksCommitted(draft: DualCaptionDraft, committed: DualCaptionDraft) {
  const comparable = (text: string) => text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const translated = comparable(draft.translatedText);
  // A journal can contain the old source in the second field after primary typing.
  // Neither source version is evidence of a recovered translation.
  if (!translated) return false;
  const committedTranslation = comparable(committed.translatedText);
  if (translated === comparable(committed.primaryText)) return false;
  if (translated === comparable(draft.primaryText)) return Boolean(committedTranslation) && committedTranslation !== translated;
  return true;
}

/** Reconcile retired identities before strict validation; failure never consumes the journal. */
export function recoverMergedDualCaptionDrafts(
  value: unknown, pairs: readonly DualCaptionPairLike[], trackId: string, baseRevision?: string,
): { drafts: Record<string, DualCaptionDraft>; remapped: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Recovery draft data is invalid and has been preserved.');
  const entries = Object.entries(value);
  if (entries.length > 100_000 || entries.some(([, draft]) => !draft || typeof draft !== 'object'
    || typeof draft.primaryText !== 'string' || typeof draft.translatedText !== 'string'
    || draft.primaryText.length > 100_000 || draft.translatedText.length > 100_000)) {
    throw new Error('Recovery draft text is invalid and has been preserved.');
  }
  const payload = Object.fromEntries(entries) as Record<string, DualCaptionDraft>;
  const committed = dualCaptionDraftsFromPairs(pairs);
  const aliases = new Map<string, string>();
  for (const pair of pairs) for (const fragment of pair.source.mergeProvenance?.aliasesRetired ? [] : pair.source.mergeProvenance?.fragments ?? []) {
    const owner = aliases.get(fragment.captionId);
    if (owner && owner !== pair.source.id) throw new Error('Recovery identity conflict. The original draft is preserved.');
    aliases.set(fragment.captionId, pair.source.id);
  }
  for (const [id] of entries) if (!Object.hasOwn(committed, id) && !aliases.has(id)) {
    throw new Error(`Recovery identity conflict: unknown caption identity ${id}. The original draft is preserved.`);
  }
  const result = { ...committed };
  let remapped = false;
  const consumed = new Set<string>();
  for (const pair of pairs) {
    const history = pair.source.mergeProvenance;
    if (!history) continue;
    if (history.aliasesRetired) {
      if (baseRevision !== dualCaptionDraftRevision(committed)) {
        throw new Error('Recovery identity conflict: a split retired the old caption aliases. The original draft is preserved.');
      }
      continue;
    }
    const fragments = history.fragments;
    const oldIdsPresent = fragments.some(fragment => fragment.captionId !== pair.source.id && Object.hasOwn(payload, fragment.captionId));
    const originalBaseline = { ...committed };
    delete originalBaseline[pair.source.id];
    for (const fragment of fragments) originalBaseline[fragment.captionId] = {
      primaryText: fragment.primaryText, translatedText: fragment.translations[trackId] ?? '',
    };
    const oldRevision = baseRevision !== undefined && baseRevision === dualCaptionDraftRevision(originalBaseline);
    if (!oldIdsPresent && !oldRevision) {
      if (baseRevision !== undefined && baseRevision !== dualCaptionDraftRevision(committed)
        && Object.hasOwn(payload, pair.source.id)) {
        throw new Error('Recovery identity conflict: this survivor-only draft may predate the join. The original draft is preserved.');
      }
      continue;
    }
    const chunks: { ids: string[]; primaryText: string; translatedText: string }[] = [];
    for (let index = 0; index < fragments.length;) {
      const fragment = fragments[index];
      const previous = [...(history.previousJoins ?? [])].reverse().find(join => join.captionIds[0] === fragment.captionId
        && join.captionIds.length > 1
        && join.captionIds.every((id, offset) => fragments[index + offset]?.captionId === id)
        && join.captionIds.slice(1).every(id => !Object.hasOwn(payload, id)));
      const ids = previous?.captionIds ?? [fragment.captionId];
      chunks.push({ ids, primaryText: previous?.primary.text ?? fragment.primaryText,
        translatedText: previous?.translationCues[trackId]?.text ?? fragment.translations[trackId] ?? '' });
      index += ids.length;
    }
    const expectedPrimary = captionLayoutText(chunks.map(chunk => chunk.primaryText));
    const expectedTranslation = captionLayoutText(chunks.map(chunk => chunk.translatedText));
    if (pair.source.text !== expectedPrimary || pair.translation.text !== expectedTranslation) {
      throw new Error('Recovery conflict: joined caption text changed after the saved fragments. The original draft is preserved.');
    }
    result[pair.source.id] = {
      primaryText: captionLayoutText(chunks.map(chunk => committedDualCaptionText(payload[chunk.ids[0]]?.primaryText ?? chunk.primaryText, chunk.primaryText))),
      translatedText: captionLayoutText(chunks.map(chunk => committedDualCaptionText(payload[chunk.ids[0]]?.translatedText ?? chunk.translatedText, chunk.translatedText))),
    };
    fragments.forEach(fragment => consumed.add(fragment.captionId));
    remapped = true;
  }
  for (const [id, draft] of entries) if (!consumed.has(id)) result[id] = draft as DualCaptionDraft;
  return { drafts: result, remapped };
}
