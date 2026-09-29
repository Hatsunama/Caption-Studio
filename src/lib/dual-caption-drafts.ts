export type DualCaptionDraft = {
  primaryText: string;
  translatedText: string;
};

type DualCaptionPairLike = {
  source: { id: string; text: string };
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
