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
      translatedText: recoveredTranslationLooksCommitted(recoveredDraft)
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
    const translationEdited = recoveredTranslationLooksCommitted(recoveredDraft)
      && recoveredDraft.translatedText !== committedDraft.translatedText;
    return primaryEdited || translationEdited;
  });
}

function recoveredTranslationLooksCommitted(draft: DualCaptionDraft) {
  const translated = draft.translatedText.trim();
  return Boolean(translated) && translated !== draft.primaryText.trim();
}
