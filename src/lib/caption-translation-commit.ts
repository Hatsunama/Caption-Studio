import { captionTextLength } from '@/lib/caption-text-breaks';

export type AutomaticTranslationCueWrite = {
  sourceCaptionId: string;
  translatedText: string;
  translationStatus: 'translated' | 'stale';
};

export function usableAutomaticTranslation(sourceText: string, translatedText: string | undefined) {
  const source = sourceText.normalize('NFC').trim();
  const translated = translatedText?.normalize('NFC').trim() ?? '';
  if (!translated || translated === source || captionTextLength(translated) > 500) return undefined;
  return translated;
}

export function translatedSliceReviewFlags(
  slices: ReadonlyMap<string, string>,
  sourceById: ReadonlyMap<string, string>,
) {
  const needsReview = new Set<string>();
  slices.forEach((text, id) => {
    if (!usableAutomaticTranslation(sourceById.get(id) ?? '', text)) needsReview.add(id);
  });
  return needsReview;
}

export function automaticTranslationCueWrites(options: {
  captions: readonly { id: string; text: string }[];
  translatedById: ReadonlyMap<string, string>;
  previousById: ReadonlyMap<string, string>;
}): AutomaticTranslationCueWrite[] {
  return options.captions.flatMap((caption) => {
    const applied = usableAutomaticTranslation(caption.text, options.translatedById.get(caption.id));
    if (applied) {
      return [{
        sourceCaptionId: caption.id,
        translatedText: applied,
        translationStatus: 'translated' as const,
      }];
    }
    const previous = options.previousById.get(caption.id)?.trim() ?? '';
    if (!previous) return [];
    return [{
      sourceCaptionId: caption.id,
      translatedText: previous,
      translationStatus: 'stale' as const,
    }];
  });
}

export function assertAutomaticTranslationWroteText(
  captions: readonly { id: string }[],
  previousById: ReadonlyMap<string, string>,
  writes: readonly AutomaticTranslationCueWrite[],
) {
  const wroteTranslated = new Set(
    writes
      .filter((write) => write.translationStatus === 'translated' && write.translatedText.trim())
      .map((write) => write.sourceCaptionId),
  );
  const emptyUnfilled = captions.some((caption) => {
    const previous = previousById.get(caption.id)?.trim() ?? '';
    return !previous && !wroteTranslated.has(caption.id);
  });
  if (emptyUnfilled && wroteTranslated.size === 0) {
    throw new Error('Automatic translation did not write translated subtitle text. The second language is still empty.');
  }
}
