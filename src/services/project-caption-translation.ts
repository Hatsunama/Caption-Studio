import {
  canAutomaticallyTranslatePair,
  captionLanguageFamily,
  captionLanguageLabel,
  type CaptionLanguageTag,
} from '@/lib/caption-languages';
import { captionTextLength } from '@/lib/caption-text-breaks';
import {
  cutTranslatedDocument,
  packCaptionDocuments,
} from '@/lib/caption-translation-cut';
import {
  createEnglishChineseCaptionTrack,
  createTranslationCaptionTrack,
  projectEnglishChineseCaptionLanguage,
  projectPrimaryCaptionLanguage,
  resolveCaptionPairs,
  setTranslationTrackProvider,
  setTranslationTrackVisibility,
  translationTrackDisplayName,
  translationTrackIdForLanguage,
  updatePairedCaptionTexts,
  type PairedCaptionTextUpdate,
} from '@/lib/caption-tracks';
import { visibleTimelineCaptions } from '@/lib/video-timeline';
import {
  translateNaturalCaptionBatch,
  translateNaturalCaptionOperations,
  type CaptionTranslationProgress,
  type NaturalCaptionTranslation,
} from '@/services/caption-translation';
import type { CaptionBlock, CaptionProject, TranslationCaptionTrack } from '@/types/project';

export type DualCaptionTextEdit = {
  sourceCaptionId: string;
  primaryText: string;
  translatedText: string;
  primaryChanged: boolean;
  translatedChanged: boolean;
};

export function prepareOptionalDualCaptionTrack(
  project: CaptionProject,
  targetLanguage: CaptionLanguageTag,
) {
  const sourceLanguage = projectPrimaryCaptionLanguage(project);
  if (captionLanguageFamily(sourceLanguage) === captionLanguageFamily(targetLanguage)) {
    throw new Error('Choose a second subtitle language that differs from the primary captions.');
  }
  const updatedAt = new Date().toISOString();
  let next = project;
  for (const track of next.captionTracks.translations) {
    if (track.visible) next = setTranslationTrackVisibility(next, track.id, false, updatedAt);
  }
  let track = next.captionTracks.translations.find(
    (candidate) => candidate.languageTag.toLowerCase() === targetLanguage.toLowerCase(),
  );
  if (track) {
    assertTrackMatchesSource(track, sourceLanguage);
    next = setTranslationTrackVisibility(next, track.id, true, updatedAt);
  } else if (canAutomaticallyTranslatePair(sourceLanguage, targetLanguage)) {
    next = createEnglishChineseCaptionTrack(next, {}, {
      sourceLanguageTag: sourceLanguage,
      languageTag: targetLanguage,
      origin: 'manual',
      provider: { id: 'manual' },
      visible: true,
      updatedAt,
    });
    track = next.captionTracks.translations.at(-1);
  } else {
    next = createTranslationCaptionTrack(next, {
      id: translationTrackIdForLanguage(targetLanguage),
      sourceLanguageTag: sourceLanguage,
      languageTag: targetLanguage,
      displayName: translationTrackDisplayName(targetLanguage),
      origin: 'manual',
      provider: { id: 'manual' },
      visible: true,
      updatedAt,
    });
    track = next.captionTracks.translations.at(-1);
  }
  if (!track) throw new Error('The second-language caption track could not be created.');
  return {
    project: next,
    trackId: track.id,
    automatic: canAutomaticallyTranslatePair(sourceLanguage, targetLanguage),
  };
}

export async function refreshProjectCaptionTranslation(options: {
  project: CaptionProject;
  trackId: string;
  sourceCaptionIds: readonly string[];
  onProgress?: (progress: CaptionTranslationProgress) => void;
}) {
  const track = requiredTrack(options.project, options.trackId);
  const sourceLanguage = projectPrimaryCaptionLanguage(options.project);
  assertTrackMatchesSource(track, sourceLanguage);
  if (!canAutomaticallyTranslatePair(sourceLanguage, track.languageTag)) {
    throw new Error(`${captionLanguageLabel(track.languageTag)} is not covered by on-device translation yet. Type the second language yourself.`);
  }
  const qwenSource = projectEnglishChineseCaptionLanguage(options.project);
  const selectedIds = new Set(options.sourceCaptionIds);
  const allCaptions = visibleTimelineCaptions(options.project.captions);
  const captions = allCaptions.filter((caption) => selectedIds.has(caption.id));
  if (captions.length === 0) return options.project;
  const translated = await translateCaptionDocument({
    sourceLanguage: qwenSource,
    targetLanguage: track.languageTag,
    captions,
    onProgress: options.onProgress,
  });
  const updatedAt = new Date().toISOString();
  const providerProject = setTranslationTrackProvider(
    options.project,
    track.id,
    translated.provider,
    qwenSource,
    updatedAt,
  );
  const previousById = new Map(track.cues.map((cue) => [cue.sourceCaptionId, cue]));
  return updatePairedCaptionTexts(providerProject, captions.flatMap((caption): PairedCaptionTextUpdate[] => {
    const applied = usableAutomaticTranslation(
      caption.text,
      translated.captions.get(caption.id),
      translated.needsReview.has(caption.id),
    );
    if (applied) {
      return [{
        trackId: track.id,
        sourceCaptionId: caption.id,
        translatedText: applied,
        translationStatus: 'translated' as const,
      }];
    }
    const previous = previousById.get(caption.id)?.text.trim() ?? '';
    if (!previous) return [];
    return [{
      trackId: track.id,
      sourceCaptionId: caption.id,
      translatedText: previous,
      translationStatus: 'stale' as const,
    }];
  }), updatedAt);
}

export async function synchronizeProjectDualCaptionEdits(options: {
  project: CaptionProject;
  trackId: string;
  edits: readonly DualCaptionTextEdit[];
  onProgress?: (progress: CaptionTranslationProgress) => void;
}) {
  const track = requiredTrack(options.project, options.trackId);
  const sourceLanguage = projectPrimaryCaptionLanguage(options.project);
  assertTrackMatchesSource(track, sourceLanguage);
  const edits = validateEdits(options.project, track, options.edits);
  if (edits.length === 0) return options.project;
  if (!canAutomaticallyTranslatePair(sourceLanguage, track.languageTag)) {
    const updatedAt = new Date().toISOString();
    return updatePairedCaptionTexts(options.project, edits.map((edit) => ({
      trackId: track.id,
      sourceCaptionId: edit.sourceCaptionId,
      primaryText: edit.primaryText,
      translatedText: edit.translatedText,
      translationStatus: 'reviewed' as const,
    })), updatedAt);
  }

  const allCaptions = visibleTimelineCaptions(options.project.captions);
  const translatedDrafts = new Map(edits.map((edit) => [edit.sourceCaptionId, edit.translatedText]));
  const pairById = new Map(resolveCaptionPairs(options.project, track.id).map((pair) => [pair.source.id, pair]));
  const translatedContext = allCaptions.flatMap((caption) => {
    const text = translatedDrafts.get(caption.id) ?? pairById.get(caption.id)?.translation.text;
    return text?.trim() ? [{ id: caption.id, text: text.trim() }] : [];
  });
  const forward = edits.filter((edit) => edit.primaryChanged && !edit.translatedChanged);
  const reverse = edits.filter((edit) => edit.translatedChanged && !edit.primaryChanged);
  const operations = [
    ...(forward.length > 0 ? [{
      id: 'forward',
      sourceLanguage,
      targetLanguage: track.languageTag,
      captions: packCaptionDocuments(forward.map((edit) => ({
        id: edit.sourceCaptionId,
        text: edit.primaryText,
      }))).map((chunk) => ({
        id: chunk.id,
        text: chunk.text,
      })),
    }] : []),
    ...(reverse.length > 0 ? [{
      id: 'reverse',
      sourceLanguage: track.languageTag,
      targetLanguage: sourceLanguage,
      captions: reverse.map((edit) => ({ id: edit.sourceCaptionId, text: edit.translatedText })),
      allCaptions: translatedContext,
    }] : []),
  ];
  const session = operations.length > 0
    ? await translateNaturalCaptionOperations({ operations, onProgress: options.onProgress })
    : undefined;
  const forwardResults = cutForwardDocumentResults(
    edits,
    options.project.captions,
    session?.operations.get('forward'),
    session?.needsReviewByOperation.get('forward'),
    track.languageTag,
  );
  const reverseResults = session?.operations.get('reverse') ?? new Map<string, string>();
  const reverseReview = session?.needsReviewByOperation.get('reverse') ?? new Set<string>();
  const updates = edits.map((edit) => {
    const automaticPrimary = edit.translatedChanged && !edit.primaryChanged
      ? usableAutomaticTranslation(
        edit.translatedText,
        reverseResults.get(edit.sourceCaptionId),
        reverseReview.has(edit.sourceCaptionId),
      )
      : undefined;
    const automaticTranslation = edit.primaryChanged && !edit.translatedChanged
      ? usableAutomaticTranslation(
        edit.primaryText,
        forwardResults.captions.get(edit.sourceCaptionId),
        forwardResults.needsReview.has(edit.sourceCaptionId),
      )
      : undefined;
    return {
      trackId: track.id,
      sourceCaptionId: edit.sourceCaptionId,
      primaryText: automaticPrimary ?? edit.primaryText,
      translatedText: automaticTranslation ?? edit.translatedText,
      translationStatus: edit.translatedChanged
        ? 'reviewed' as const
        : automaticTranslation
          ? 'translated' as const
          : 'stale' as const,
    };
  });
  if (updates.some((update) => !update.primaryText || !update.translatedText)) {
    throw new Error('The local model returned an incomplete synchronized script. No captions were changed.');
  }
  const updatedAt = new Date().toISOString();
  const providerProject = session
    ? setTranslationTrackProvider(options.project, track.id, session.provider, sourceLanguage, updatedAt)
    : options.project;
  return updatePairedCaptionTexts(providerProject, updates, updatedAt);
}

export function changedPrimaryCaptionTextIds(before: CaptionProject, after: CaptionProject) {
  const previous = new Map(before.captions.map((caption) => [caption.id, caption.text.trim()]));
  return after.captions
    .filter((caption) => caption.timelineVisible !== false && previous.get(caption.id) !== caption.text.trim())
    .map((caption) => caption.id);
}

function validateEdits(
  project: CaptionProject,
  track: TranslationCaptionTrack,
  edits: readonly DualCaptionTextEdit[],
) {
  const captionIds = new Set(project.captions.map((caption) => caption.id));
  const cueIds = new Set(track.cues.map((cue) => cue.sourceCaptionId));
  const seen = new Set<string>();
  return edits.map((edit) => {
    if (!captionIds.has(edit.sourceCaptionId) || !cueIds.has(edit.sourceCaptionId) || seen.has(edit.sourceCaptionId)) {
      throw new Error('A dual-subtitle edit no longer matches this project. Reopen the script and try again.');
    }
    seen.add(edit.sourceCaptionId);
    const primaryText = edit.primaryText.normalize('NFC').trim();
    const translatedText = edit.translatedText.normalize('NFC').trim();
    if (!primaryText || !translatedText) throw new Error('Both subtitle lines need text before they can be synchronized.');
    if (captionTextLength(primaryText) > 500 || captionTextLength(translatedText) > 500) {
      throw new Error('A subtitle is too long. Split it before synchronizing both languages.');
    }
    if (!edit.primaryChanged && !edit.translatedChanged) {
      throw new Error('A dual-subtitle edit must change at least one language.');
    }
    return { ...edit, primaryText, translatedText };
  });
}

function requiredTrack(project: CaptionProject, trackId: string) {
  const track = project.captionTracks.translations.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error('The second-language caption track no longer exists.');
  return track;
}

function usableAutomaticTranslation(sourceText: string, translatedText: string | undefined, needsReview: boolean) {
  const source = sourceText.normalize('NFC').trim();
  const translated = translatedText?.normalize('NFC').trim() ?? '';
  if (needsReview || !translated || translated === source || captionTextLength(translated) > 500) return undefined;
  return translated;
}

function assertTrackMatchesSource(track: TranslationCaptionTrack, sourceLanguage: string) {
  if (
    captionLanguageFamily(track.sourceLanguageTag) !== captionLanguageFamily(sourceLanguage)
    || captionLanguageFamily(track.languageTag) === captionLanguageFamily(sourceLanguage)
  ) {
    throw new Error(`${track.displayName} no longer matches the primary caption language. Remove it and add dual subtitles again.`);
  }
}

async function translateCaptionDocument(options: {
  sourceLanguage: string;
  targetLanguage: string;
  captions: CaptionBlock[];
  onProgress?: (progress: CaptionTranslationProgress) => void;
}): Promise<NaturalCaptionTranslation> {
  const chunks = packCaptionDocuments(options.captions.map((caption) => ({ id: caption.id, text: caption.text })));
  const translated = await translateNaturalCaptionBatch({
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    captions: chunks.map((chunk) => ({ id: chunk.id, text: chunk.text })),
    onProgress: options.onProgress,
  });
  const captions = new Map<string, string>();
  const needsReview = new Set<string>();
  const byId = new Map(options.captions.map((caption) => [caption.id, caption]));
  for (const chunk of chunks) {
    const sources = chunk.sourceIds.flatMap((id) => {
      const caption = byId.get(id);
      return caption ? [{ id: caption.id, text: caption.text, startMs: caption.startMs, endMs: caption.endMs }] : [];
    });
    const cut = cutTranslatedDocument(
      translated.captions.get(chunk.id) ?? '',
      sources,
      options.targetLanguage,
    );
    const documentNeedsReview = translated.needsReview.has(chunk.id) || !translated.captions.get(chunk.id)?.trim();
    cut.forEach((text, id) => {
      captions.set(id, text);
      if (documentNeedsReview) needsReview.add(id);
    });
  }
  return { captions, needsReview, provider: translated.provider };
}

function cutForwardDocumentResults(
  edits: readonly DualCaptionTextEdit[],
  captions: CaptionBlock[],
  documents: ReadonlyMap<string, string> | undefined,
  documentReview: ReadonlySet<string> | undefined,
  targetLanguage: string,
) {
  const result = new Map<string, string>();
  const needsReview = new Set<string>();
  if (!documents || documents.size === 0) return { captions: result, needsReview };
  const byId = new Map(captions.map((caption) => [caption.id, caption]));
  const sources = edits.flatMap((edit) => {
    if (!edit.primaryChanged || edit.translatedChanged) return [];
    const caption = byId.get(edit.sourceCaptionId);
    return caption
      ? [{ id: edit.sourceCaptionId, text: edit.primaryText, startMs: caption.startMs, endMs: caption.endMs }]
      : [];
  });
  for (const chunk of packCaptionDocuments(sources.map((source) => ({ id: source.id, text: source.text })))) {
    const translated = documents.get(chunk.id);
    const cut = cutTranslatedDocument(
      translated ?? '',
      sources.filter((source) => chunk.sourceIds.includes(source.id)),
      targetLanguage,
    );
    const documentNeedsReview = Boolean(documentReview?.has(chunk.id) || !translated?.trim());
    cut.forEach((text, id) => {
      result.set(id, text);
      if (documentNeedsReview) needsReview.add(id);
    });
  }
  return { captions: result, needsReview };
}
