import {
  canAutomaticallyTranslatePair,
  captionLanguageFamily,
  captionLanguageLabel,
  type CaptionLanguageTag,
} from '@/lib/caption-languages';
import { captionTextLength } from '@/lib/caption-text-breaks';
import {
  assertAutomaticTranslationWroteText,
  automaticTranslationCueWrites,
  translatedSliceReviewFlags,
} from '@/lib/caption-translation-commit';
import {
  cutTranslatedDocument,
  packCaptionDocuments,
} from '@/lib/caption-translation-cut';
import {
  createTranslationCaptionTrack,
  projectPrimaryCaptionLanguage,
  setTranslationTrackProvider,
  setTranslationTrackVisibility,
  translationTrackDisplayName,
  translationTrackIdForLanguage,
  updatePairedCaptionTexts,
} from '@/lib/caption-tracks';
import { visibleTimelineCaptions } from '@/lib/video-timeline';
import {
  translateNaturalCaptionBatch,
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
  let track = next.captionTracks.translations.find(
    (candidate) => candidate.languageTag.toLowerCase() === targetLanguage.toLowerCase(),
  );
  if (track) {
    assertTrackMatchesSource(track, sourceLanguage);
    next = setTranslationTrackVisibility(next, track.id, true, updatedAt);
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
  const qwenSource = sourceLanguage;
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
  const previousById = new Map(track.cues.map((cue) => [cue.sourceCaptionId, cue.text]));
  const writes = automaticTranslationCueWrites({
    captions,
    translatedById: translated.captions,
    previousById,
    needsReviewById: translated.needsReview,
    targetLanguage: track.languageTag,
  });
  assertAutomaticTranslationWroteText(captions, previousById, writes);
  const updatedAt = new Date().toISOString();
  const providerProject = setTranslationTrackProvider(
    options.project,
    track.id,
    translated.provider,
    qwenSource,
    updatedAt,
  );
  return updatePairedCaptionTexts(providerProject, writes.map((write) => ({
    trackId: track.id,
    sourceCaptionId: write.sourceCaptionId,
    translatedText: write.translatedText,
    translationStatus: write.translationStatus,
  })), updatedAt);
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
  const updates = edits.map((edit) => ({
    trackId: track.id,
    sourceCaptionId: edit.sourceCaptionId,
    ...(edit.primaryChanged ? { primaryText: edit.primaryText } : {}),
    ...(edit.translatedChanged ? {
      translatedText: edit.translatedText,
      translationStatus: 'reviewed' as const,
    } : {}),
  }));
  const updatedAt = new Date().toISOString();
  return updatePairedCaptionTexts(options.project, updates, updatedAt);
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
    const sourceById = new Map(sources.map((source) => [source.id, source.text]));
    translatedSliceReviewFlags(cut, sourceById, options.targetLanguage).forEach((id) => needsReview.add(id));
    cut.forEach((text, id) => captions.set(id, text));
  }
  return { captions, needsReview, provider: translated.provider };
}
