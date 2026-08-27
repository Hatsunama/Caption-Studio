import {
  captionLanguageFamily,
  normalizeEnglishChineseCaptionLanguage,
} from '@/lib/caption-languages';
import { captionTextLength } from '@/lib/caption-text-breaks';
import {
  createEnglishChineseCaptionTrack,
  projectEnglishChineseCaptionLanguage,
  resolveCaptionPairs,
  setTranslationTrackProvider,
  setTranslationTrackVisibility,
  updatePairedCaptionTexts,
} from '@/lib/caption-tracks';
import { visibleTimelineCaptions } from '@/lib/video-timeline';
import {
  translateNaturalCaptionBatch,
  translateNaturalCaptionOperations,
  type CaptionTranslationProgress,
} from '@/services/caption-translation';
import type { CaptionProject, TranslationCaptionTrack } from '@/types/project';

export type DualCaptionTextEdit = {
  sourceCaptionId: string;
  primaryText: string;
  translatedText: string;
  primaryChanged: boolean;
  translatedChanged: boolean;
};

export function prepareOptionalDualCaptionTrack(
  project: CaptionProject,
  targetLanguage: 'en' | 'zh-Hans' | 'zh-Hant',
) {
  const sourceLanguage = projectEnglishChineseCaptionLanguage(project);
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
  } else {
    next = createEnglishChineseCaptionTrack(next, {}, {
      sourceLanguageTag: sourceLanguage,
      languageTag: targetLanguage,
      origin: 'manual',
      provider: { id: 'manual' },
      visible: true,
      updatedAt,
    });
    track = next.captionTracks.translations.at(-1);
  }
  if (!track) throw new Error('The second-language caption track could not be created.');
  return { project: next, trackId: track.id };
}

export async function refreshProjectCaptionTranslation(options: {
  project: CaptionProject;
  trackId: string;
  sourceCaptionIds: readonly string[];
  onProgress?: (progress: CaptionTranslationProgress) => void;
}) {
  const track = requiredTrack(options.project, options.trackId);
  const sourceLanguage = projectEnglishChineseCaptionLanguage(options.project);
  assertTrackMatchesSource(track, sourceLanguage);
  const selectedIds = new Set(options.sourceCaptionIds);
  const allCaptions = visibleTimelineCaptions(options.project.captions);
  const captions = allCaptions.filter((caption) => selectedIds.has(caption.id));
  if (captions.length === 0) return options.project;
  const translated = await translateNaturalCaptionBatch({
    sourceLanguage,
    targetLanguage: track.languageTag,
    captions: captions.map(({ id, text }) => ({ id, text })),
    allCaptions: allCaptions.map(({ id, text }) => ({ id, text })),
    onProgress: options.onProgress,
  });
  const updatedAt = new Date().toISOString();
  const providerProject = setTranslationTrackProvider(
    options.project,
    track.id,
    translated.provider,
    sourceLanguage,
    updatedAt,
  );
  return updatePairedCaptionTexts(providerProject, captions.map((caption) => ({
    trackId: track.id,
    sourceCaptionId: caption.id,
    translatedText: translated.captions.get(caption.id) ?? '',
    translationStatus: 'translated' as const,
  })), updatedAt);
}

export async function synchronizeProjectDualCaptionEdits(options: {
  project: CaptionProject;
  trackId: string;
  edits: readonly DualCaptionTextEdit[];
  onProgress?: (progress: CaptionTranslationProgress) => void;
}) {
  const track = requiredTrack(options.project, options.trackId);
  const sourceLanguage = projectEnglishChineseCaptionLanguage(options.project);
  assertTrackMatchesSource(track, sourceLanguage);
  const edits = validateEdits(options.project, track, options.edits);
  if (edits.length === 0) return options.project;

  const allCaptions = visibleTimelineCaptions(options.project.captions);
  const primaryDrafts = new Map(edits.map((edit) => [edit.sourceCaptionId, edit.primaryText]));
  const translatedDrafts = new Map(edits.map((edit) => [edit.sourceCaptionId, edit.translatedText]));
  const primaryContext = allCaptions.map((caption) => ({
    id: caption.id,
    text: primaryDrafts.get(caption.id) ?? caption.text,
  }));
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
      captions: forward.map((edit) => ({ id: edit.sourceCaptionId, text: edit.primaryText })),
      allCaptions: primaryContext,
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
  const forwardResults = session?.operations.get('forward') ?? new Map<string, string>();
  const reverseResults = session?.operations.get('reverse') ?? new Map<string, string>();
  const updates = edits.map((edit) => ({
    trackId: track.id,
    sourceCaptionId: edit.sourceCaptionId,
    primaryText: edit.translatedChanged && !edit.primaryChanged
      ? reverseResults.get(edit.sourceCaptionId)
      : edit.primaryText,
    translatedText: edit.primaryChanged && !edit.translatedChanged
      ? forwardResults.get(edit.sourceCaptionId)
      : edit.translatedText,
    translationStatus: edit.translatedChanged ? 'reviewed' as const : 'translated' as const,
  }));
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

function assertTrackMatchesSource(track: TranslationCaptionTrack, sourceLanguage: string) {
  const normalizedSource = normalizeEnglishChineseCaptionLanguage(sourceLanguage);
  const storedSource = normalizeEnglishChineseCaptionLanguage(track.sourceLanguageTag);
  const target = normalizeEnglishChineseCaptionLanguage(track.languageTag);
  if (captionLanguageFamily(storedSource) !== captionLanguageFamily(normalizedSource) || captionLanguageFamily(target) === captionLanguageFamily(normalizedSource)) {
    throw new Error(`${track.displayName} no longer matches the primary caption language. Remove it and add dual subtitles again.`);
  }
}
