import { captionTextLength } from '@/lib/caption-text-breaks';
import { isLikelyUntranslatedCaption } from '@/lib/caption-languages';

export type AutomaticTranslationCueWrite = {
  sourceCaptionId: string;
  translatedText: string;
  translationStatus: 'translated' | 'stale';
};

export function usableAutomaticTranslation(
  sourceText: string,
  translatedText: string | undefined,
  needsReview = false,
  targetLanguage?: string,
) {
  const source = sourceText.normalize('NFC').trim();
  const translated = translatedText?.normalize('NFC').trim() ?? '';
  if (
    needsReview
    || !translated
    || translated === source
    || captionTextLength(translated) > 500
    || (targetLanguage ? isLikelyUntranslatedCaption(source, translated, targetLanguage) : false)
  ) return undefined;
  return translated;
}

export function translatedSliceReviewFlags(
  slices: ReadonlyMap<string, string>,
  sourceById: ReadonlyMap<string, string>,
  targetLanguage?: string,
) {
  const needsReview = new Set<string>();
  slices.forEach((text, id) => {
    if (!usableAutomaticTranslation(sourceById.get(id) ?? '', text, false, targetLanguage)) needsReview.add(id);
  });
  return needsReview;
}

export function automaticTranslationCueWrites(options: {
  captions: readonly { id: string; text: string }[];
  translatedById: ReadonlyMap<string, string>;
  previousById: ReadonlyMap<string, string>;
  needsReviewById?: ReadonlySet<string>;
  targetLanguage?: string;
}): AutomaticTranslationCueWrite[] {
  return options.captions.flatMap((caption): AutomaticTranslationCueWrite[] => {
    const applied = usableAutomaticTranslation(
      caption.text,
      options.translatedById.get(caption.id),
      options.needsReviewById?.has(caption.id) ?? false,
      options.targetLanguage,
    );
    if (applied) {
      return [{
        sourceCaptionId: caption.id,
        translatedText: applied,
        translationStatus: 'translated',
      }];
    }
    const previous = options.previousById.get(caption.id)?.trim() ?? '';
    if (!previous) return [];
    return [{
      sourceCaptionId: caption.id,
      translatedText: previous,
      translationStatus: 'stale',
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
