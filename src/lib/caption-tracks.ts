import { mergePatch, mergeStyle } from '@/lib/style-resolver';
import { isProjectIdentifier, isTranslationCueIdentifier } from '@/lib/project-identifiers';
import {
  canonicalCaptionLanguageTag,
  captionLanguageFamily,
  captionLanguageLabel,
  normalizeEnglishChineseCaptionLanguage,
  sameCaptionLanguageFamily,
  type CaptionLanguageTag,
  type EnglishChineseCaptionLanguage,
} from '@/lib/caption-languages';
import type {
  CaptionBlock,
  CaptionProject,
  CaptionStyle,
  CaptionStylePatch,
  CaptionTrackCollection,
  TranslationCaptionCue,
  TranslationCaptionStatus,
  TranslationCaptionTrack,
} from '@/types/project';

export const CHINESE_SIMPLIFIED_TRACK_ID = 'translation-zh-Hans';
export const CHINESE_TRADITIONAL_TRACK_ID = 'translation-zh-Hant';
export const ENGLISH_TRACK_ID = 'translation-en';

const DEFAULT_TRANSLATION_TRACK_STYLE = {
  font: { id: 'system-sans', family: 'sans-serif', source: 'system' as const },
  fontSize: 34,
  fontWeight: '700' as const,
  textColor: '#FFFFFF',
  box: { width: 0.9, height: 0.12 },
  maxLines: 2,
  animation: { id: 'none' as const, intensity: 1, durationMs: 220 },
} satisfies CaptionStylePatch;

export const DEFAULT_TRANSLATION_STACK_GAP = 0.028;
export const MIN_TRANSLATION_STACK_GAP = 0.008;
export const MAX_TRANSLATION_STACK_GAP = 0.18;

export type CaptionPair = {
  trackId: string;
  languageTag: string;
  visible: boolean;
  startMs: number;
  endMs: number;
  timelineVisible: boolean;
  source: CaptionBlock;
  translation: TranslationCaptionCue;
  style: CaptionStyle;
};

export type TranslationTrackOptions = {
  id: string;
  sourceLanguageTag?: string;
  languageTag: string;
  displayName: string;
  origin?: TranslationCaptionTrack['origin'];
  provider?: TranslationCaptionTrack['provider'];
  visible?: boolean;
  stackGap?: number;
  styleOverride?: CaptionStylePatch;
  translations?: Readonly<Record<string, string>>;
  updatedAt?: string;
};

export type PairedCaptionTextUpdate = {
  trackId: string;
  sourceCaptionId: string;
  primaryText?: string;
  translatedText?: string;
  translationStatus?: Extract<TranslationCaptionStatus, 'pending' | 'translated' | 'reviewed' | 'stale'>;
  updatedAt?: string;
};

export type { EnglishChineseCaptionLanguage } from '@/lib/caption-languages';

export function emptyCaptionTrackCollection(): CaptionTrackCollection {
  return { schemaVersion: 1, primaryTrackId: 'captions', translations: [] };
}

export function createEnglishChineseCaptionTrack(
  project: CaptionProject,
  translations: Readonly<Record<string, string>> = {},
  options: Partial<Omit<TranslationTrackOptions, 'translations'>> = {},
) {
  const source = projectEnglishChineseCaptionLanguage(project);
  const languageTag = options.languageTag
    ? normalizeEnglishChineseCaptionLanguage(options.languageTag)
    : source === 'en' ? 'zh-Hans' : 'en';
  if (source === 'en' && languageTag === 'en') {
    throw new Error('An English primary track can pair with Simplified or Traditional Chinese.');
  }
  if (source !== 'en' && languageTag !== 'en') {
    throw new Error('A Chinese primary track can pair with English.');
  }
  const target = englishChineseTarget(languageTag);
  return createTranslationCaptionTrack(project, {
    id: options.id ?? target.id,
    sourceLanguageTag: options.sourceLanguageTag ?? projectPrimaryCaptionLanguage(project),
    languageTag,
    displayName: options.displayName ?? target.displayName,
    origin: options.origin ?? 'manual',
    provider: options.provider,
    visible: options.visible,
    styleOverride: translationTargetStyle(options.styleOverride),
    updatedAt: options.updatedAt,
    translations,
  });
}

export function createTranslationCaptionTrack(project: CaptionProject, options: TranslationTrackOptions) {
  requiredIdentifier(options.id, 'Caption track');
  requiredLanguageTag(options.languageTag);
  const sourceLanguageTag = options.sourceLanguageTag ?? projectPrimaryCaptionLanguage(project);
  requiredLanguageTag(sourceLanguageTag);
  if (sameLanguage(sourceLanguageTag, options.languageTag)) {
    throw new Error('A translation track must use a different language from the primary captions.');
  }
  requiredDisplayName(options.displayName);
  const tracks = currentCaptionTracks(project);
  if (tracks.translations.some((track) => track.id === options.id)) {
    throw new Error(`Caption track ${options.id} already exists.`);
  }
  if (tracks.translations.some((track) => track.languageTag.toLowerCase() === options.languageTag.toLowerCase())) {
    throw new Error(`A ${options.languageTag} caption track already exists.`);
  }
  const sourceCaptionIds = new Set(project.captions.map((caption) => caption.id));
  Object.keys(options.translations ?? {}).forEach((sourceCaptionId) => {
    if (!sourceCaptionIds.has(sourceCaptionId)) {
      throw new Error(`Primary caption ${sourceCaptionId} does not exist.`);
    }
  });
  const provider = options.provider ?? { id: 'manual' as const };
  validateTranslationProvider(provider);
  if (options.origin && (options.origin === 'automatic') !== (provider.id === 'litertlm')) {
    throw new Error('Caption translation origin and provider are inconsistent.');
  }
  const track: TranslationCaptionTrack = {
    id: options.id,
    kind: 'translation',
    sourceTrackId: 'captions',
    sourceLanguageTag,
    languageTag: options.languageTag,
    displayName: options.displayName,
    visible: options.visible ?? true,
    origin: provider.id === 'litertlm' ? 'automatic' : 'manual',
    provider,
    stackGap: clampStackGap(options.stackGap ?? DEFAULT_TRANSLATION_STACK_GAP),
    styleOverride: options.styleOverride,
    cues: project.captions.map((caption) => createCue(
      options.id,
      caption,
      translationValue(options.translations, caption.id),
    )),
  };
  return withCaptionTracks(project, {
    ...tracks,
    translations: [
      ...tracks.translations,
      track,
    ],
  }, options.updatedAt);
}

export function updatePairedCaptionText(project: CaptionProject, update: PairedCaptionTextUpdate) {
  if (update.primaryText === undefined && update.translatedText === undefined) return project;
  return updatePairedCaptionTexts(project, [update], update.updatedAt);
}

export function updatePairedCaptionTexts(
  project: CaptionProject,
  updates: readonly PairedCaptionTextUpdate[],
  updatedAt = project.updatedAt,
) {
  if (updates.length === 0) return project;
  const tracks = currentCaptionTracks(project);
  const captionIds = new Set(project.captions.map((caption) => caption.id));
  const trackIds = new Set(tracks.translations.map((track) => track.id));
  const pairKeys = new Set<string>();
  const primaryTexts = new Map<string, string>();
  const translatedUpdates = new Map<string, PairedCaptionTextUpdate>();
  updates.forEach((update) => {
    if (!captionIds.has(update.sourceCaptionId)) {
      throw new Error(`Primary caption ${update.sourceCaptionId} does not exist.`);
    }
    if (!trackIds.has(update.trackId)) {
      throw new Error(`Caption track ${update.trackId} does not exist.`);
    }
    if (update.primaryText === undefined && update.translatedText === undefined) return;
    const pairKey = `${update.trackId}:${update.sourceCaptionId}`;
    if (pairKeys.has(pairKey)) {
      throw new Error(`Caption ${update.sourceCaptionId} has more than one update for track ${update.trackId}.`);
    }
    pairKeys.add(pairKey);
    if (update.primaryText !== undefined) {
      const primaryText = requiredText(update.primaryText, 'Primary caption');
      const previous = primaryTexts.get(update.sourceCaptionId);
      if (previous !== undefined && previous !== primaryText) {
        throw new Error(`Caption ${update.sourceCaptionId} has conflicting primary text updates.`);
      }
      primaryTexts.set(update.sourceCaptionId, primaryText);
    }
    if (update.translatedText !== undefined) {
      requiredText(update.translatedText, 'Translated caption');
      translatedUpdates.set(pairKey, update);
    }
  });
  const captions = project.captions.map((caption) => {
    const text = primaryTexts.get(caption.id);
    return text === undefined ? caption : { ...caption, text, textMode: 'manual' as const };
  });
  const synchronized = synchronizeCaptionTracks({ ...project, captionTracks: tracks, captions }, captions);
  const primaryById = new Map(captions.map((caption) => [caption.id, caption]));
  const translations = synchronized.translations.map((track) => ({
    ...track,
    cues: track.cues.map((cue) => {
      const update = translatedUpdates.get(`${track.id}:${cue.sourceCaptionId}`);
      if (!update?.translatedText) return cue;
      const source = primaryById.get(cue.sourceCaptionId);
      if (!source) throw new Error(`Primary caption ${cue.sourceCaptionId} does not exist.`);
      return {
        ...cue,
        sourceTextSnapshot: source.text,
        text: update.translatedText.trim(),
        status: update.translationStatus ?? 'translated',
        reviewed: update.translationStatus === 'reviewed',
      };
    }),
  }));
  return withCaptionTracks(
    { ...project, captions },
    { ...synchronized, translations },
    updatedAt,
  );
}

export function setTranslationTrackStyle(
  project: CaptionProject,
  trackId: string,
  patch: CaptionStylePatch,
  updatedAt = project.updatedAt,
) {
  return mapTranslationTrack(project, trackId, (track) => ({
    ...track,
    styleOverride: mergePatch(track.styleOverride, patch),
  }), updatedAt);
}

export function setTranslationCueStyle(
  project: CaptionProject,
  trackId: string,
  sourceCaptionId: string,
  patch: CaptionStylePatch,
  updatedAt = project.updatedAt,
) {
  return mapTranslationTrack(project, trackId, (track) => {
    if (!track.cues.some((cue) => cue.sourceCaptionId === sourceCaptionId)) {
      throw new Error(`Translation for caption ${sourceCaptionId} does not exist.`);
    }
    return {
      ...track,
      cues: track.cues.map((cue) => cue.sourceCaptionId === sourceCaptionId
        ? { ...cue, styleOverride: mergePatch(cue.styleOverride, patch) }
        : cue),
    };
  }, updatedAt);
}

export function setTranslationCueTiming(
  project: CaptionProject,
  trackId: string,
  sourceCaptionId: string,
  edge: 'start' | 'end' | 'move',
  startMs: number,
  endMs: number,
  updatedAt = project.updatedAt,
) {
  const timelineEndMs = Math.max(80, project.clips.reduce(
    (total, clip) => total + clip.gapBeforeMs + (clip.sourceEndMs - clip.sourceStartMs) / clip.playbackRate,
    0,
  ));
  return mapTranslationTrack(project, trackId, (track) => ({
    ...track,
    cues: track.cues.map((cue) => {
      if (cue.sourceCaptionId !== sourceCaptionId) return cue;
      const source = project.captions.find((caption) => caption.id === sourceCaptionId);
      const currentStart = cue.startMs ?? source?.startMs ?? 0;
      const currentEnd = cue.endMs ?? source?.endMs ?? currentStart + 80;
      const currentDuration = Math.max(80, currentEnd - currentStart);
      const safeStart = edge === 'start'
        ? Math.max(0, Math.min(startMs, currentEnd - 80))
        : edge === 'move'
          ? Math.max(0, Math.min(startMs, timelineEndMs - currentDuration))
          : currentStart;
      const safeEnd = edge === 'start'
        ? currentEnd
        : edge === 'move'
          ? safeStart + currentDuration
          : Math.min(timelineEndMs, Math.max(endMs, currentStart + 80));
      return { ...cue, startMs: safeStart, endMs: safeEnd, timelineVisible: true };
    }),
  }), updatedAt);
}

export function setTranslationTrackVisibility(
  project: CaptionProject,
  trackId: string,
  visible: boolean,
  updatedAt = project.updatedAt,
) {
  if (typeof visible !== 'boolean') throw new Error('Caption track visibility is invalid.');
  const tracks = currentCaptionTracks(project);
  if (!tracks.translations.some((track) => track.id === trackId)) {
    throw new Error(`Caption track ${trackId} does not exist.`);
  }
  return withCaptionTracks(project, {
    ...tracks,
    translations: tracks.translations.map((track) => track.id === trackId ? { ...track, visible } : track),
  }, updatedAt);
}

export function setTranslationTrackProvider(
  project: CaptionProject,
  trackId: string,
  provider: TranslationCaptionTrack['provider'],
  sourceLanguageTag = projectPrimaryCaptionLanguage(project),
  updatedAt = project.updatedAt,
) {
  if (provider.id !== 'manual' && provider.id !== 'litertlm') {
    throw new Error('Caption translation provider is invalid.');
  }
  requiredLanguageTag(sourceLanguageTag);
  validateTranslationProvider(provider);
  return mapTranslationTrack(project, trackId, (track) => {
    if (sameLanguage(track.languageTag, sourceLanguageTag)) {
      throw new Error('A translation track cannot duplicate the primary caption language.');
    }
    return {
      ...track,
      sourceLanguageTag,
      origin: provider.id === 'manual' ? 'manual' : 'automatic',
      provider: { ...provider },
    };
  }, updatedAt);
}

export function projectPrimaryCaptionLanguage(project: CaptionProject): string {
  const sourceIds = [...new Set(project.clips.map((clip) => clip.sourceId))];
  const detected = sourceIds.flatMap((sourceId) => {
    const language = project.transcription.sourceResults[sourceId]?.language;
    return language ? [canonicalCaptionLanguageTag(language)] : [];
  });
  if (detected.length > 0 && detected.length !== sourceIds.length) {
    throw new Error('Generate captions for every video before adding dual subtitles.');
  }
  const languages = detected.length > 0
    ? detected
    : [canonicalCaptionLanguageTag(project.transcription.language)];
  const families = new Set(languages.map(captionLanguageFamily));
  if (families.size !== 1) {
    throw new Error('Dual subtitles currently require every video clip to use the same source language.');
  }
  return languages[0];
}

export function projectEnglishChineseCaptionLanguage(project: CaptionProject): EnglishChineseCaptionLanguage {
  return normalizeEnglishChineseCaptionLanguage(projectPrimaryCaptionLanguage(project));
}

export function resolvedProjectCaptionLanguage(project: CaptionProject): string {
  try {
    return projectPrimaryCaptionLanguage(project);
  } catch {
    return canonicalCaptionLanguageTag(project.transcription.language);
  }
}

export function assertVisibleTranslationTracksCompatible(project: CaptionProject) {
  const visible = (project.captionTracks?.translations ?? []).filter((track) => track.visible);
  if (visible.length === 0) return;
  const sourceLanguage = projectPrimaryCaptionLanguage(project);
  for (const track of visible) {
    if (
      !sameCaptionLanguageFamily(track.sourceLanguageTag, sourceLanguage)
      || sameCaptionLanguageFamily(track.languageTag, sourceLanguage)
    ) {
      throw new Error(`${track.displayName} no longer matches the primary caption language. Remove it and add dual subtitles again.`);
    }
  }
}

export function synchronizeCaptionTracksAfterTranscription(
  previous: CaptionProject,
  generated: CaptionProject,
): CaptionTrackCollection {
  if (previous.captionTracks.translations.length === 0) {
    return synchronizeCaptionTracks(generated, generated.captions);
  }
  try {
    const previousLanguage = projectPrimaryCaptionLanguage(previous);
    const generatedLanguage = projectPrimaryCaptionLanguage(generated);
    if (!sameCaptionLanguageFamily(previousLanguage, generatedLanguage)) {
      return emptyCaptionTrackCollection();
    }
  } catch {
    return emptyCaptionTrackCollection();
  }
  return synchronizeCaptionTracks(generated, generated.captions);
}

export function translationTrackIdForLanguage(languageTag: CaptionLanguageTag | string) {
  if (languageTag === 'zh-Hans') return CHINESE_SIMPLIFIED_TRACK_ID;
  if (languageTag === 'zh-Hant') return CHINESE_TRADITIONAL_TRACK_ID;
  if (languageTag === 'en') return ENGLISH_TRACK_ID;
  return `translation-${languageTag}`;
}

export function translationTrackDisplayName(languageTag: string) {
  return captionLanguageLabel(languageTag);
}

export function resolveCaptionPairs(project: CaptionProject, trackId: string): CaptionPair[] {
  const track = translationTrack(project, trackId);
  const cues = new Map(track.cues.map((cue) => [cue.sourceCaptionId, cue]));
  return project.captions.map((source) => {
    const translation = cues.get(source.id) ?? createCue(track.id, source, '');
    const primaryStyle = mergeStyle(project.projectStyle, source.styleOverride);
    const translationStyle = mergeStyle(
      mergeStyle(mergeStyle(primaryStyle, DEFAULT_TRANSLATION_TRACK_STYLE), track.styleOverride),
      translation.styleOverride,
    );
    const stacked = !track.styleOverride?.position && !translation.styleOverride?.position;
    const stackedLayout = stacked
      ? stackedTranslationLayout(primaryStyle, translationStyle, track.stackGap)
      : undefined;
    const style = stackedLayout
      ? {
          ...translationStyle,
          position: stackedLayout.position,
          box: stackedLayout.box,
        }
      : translationStyle;
    return {
      trackId: track.id,
      languageTag: track.languageTag,
      visible: track.visible,
      startMs: translation.startMs ?? source.startMs,
      endMs: translation.endMs ?? source.endMs,
      timelineVisible: translation.timelineVisible ?? source.timelineVisible !== false,
      source,
      translation,
      style,
    };
  });
}

export function synchronizeCaptionTracks(
  project: Pick<CaptionProject, 'captions' | 'captionTracks'> & Partial<Pick<CaptionProject, 'transcription'>>,
  captions = project.captions,
): CaptionTrackCollection {
  const tracks = project.captionTracks ?? emptyCaptionTrackCollection();
  return {
    schemaVersion: 1,
    primaryTrackId: 'captions',
    translations: tracks.translations.map((track) => {
      const existing = new Map(track.cues.map((cue) => [cue.sourceCaptionId, cue]));
      const sourceLanguageChanged = Boolean(
        project.transcription?.language
        && !sameLanguage(track.sourceLanguageTag, project.transcription.language),
      );
      return {
        ...track,
        cues: captions.map((caption) => {
          const cue = synchronizeCue(track.id, caption, existing.get(caption.id));
          return sourceLanguageChanged && cue.text.trim() ? { ...cue, status: 'stale' as const } : cue;
        }),
      };
    }),
  };
}

export function remapTranslationTrackTimings(
  captionTracks: CaptionTrackCollection | undefined,
  beforeCaptions: readonly CaptionBlock[],
  afterCaptions: readonly CaptionBlock[],
) {
  const tracks = captionTracks ?? emptyCaptionTrackCollection();
  const beforeById = new Map(beforeCaptions.map((caption) => [caption.id, caption]));
  const afterById = new Map(afterCaptions.map((caption) => [caption.id, caption]));
  return {
    ...tracks,
    translations: tracks.translations.map((track) => ({
      ...track,
      cues: track.cues.map((cue) => {
        const before = beforeById.get(cue.sourceCaptionId);
        const after = afterById.get(cue.sourceCaptionId);
        if (!before || !after) return cue;
        return {
          ...cue,
          startMs: (cue.startMs ?? before.startMs) + after.startMs - before.startMs,
          endMs: (cue.endMs ?? before.endMs) + after.endMs - before.endMs,
        };
      }),
    })),
  };
}

export function removeTranslationCaptionTrack(
  project: CaptionProject,
  trackId: string,
  updatedAt = project.updatedAt,
) {
  const tracks = currentCaptionTracks(project);
  if (!tracks.translations.some((track) => track.id === trackId)) return project;
  return withCaptionTracks(project, {
    ...tracks,
    translations: tracks.translations.filter((track) => track.id !== trackId),
  }, updatedAt);
}

function currentCaptionTracks(
  project: Pick<CaptionProject, 'captions' | 'captionTracks'> & Partial<Pick<CaptionProject, 'transcription'>>,
) {
  return synchronizeCaptionTracks(project);
}

function translationTrack(project: CaptionProject, trackId: string) {
  const track = currentCaptionTracks(project).translations.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`Caption track ${trackId} does not exist.`);
  return track;
}

function mapTranslationTrack(
  project: CaptionProject,
  trackId: string,
  update: (track: TranslationCaptionTrack) => TranslationCaptionTrack,
  updatedAt: string,
) {
  const tracks = currentCaptionTracks(project);
  let found = false;
  const translations = tracks.translations.map((track) => {
    if (track.id !== trackId) return track;
    found = true;
    return update(track);
  });
  if (!found) throw new Error(`Caption track ${trackId} does not exist.`);
  return withCaptionTracks(project, { ...tracks, translations }, updatedAt);
}

function withCaptionTracks(
  project: CaptionProject,
  captionTracks: CaptionTrackCollection,
  updatedAt = project.updatedAt,
): CaptionProject {
  return { ...project, updatedAt, captionTracks };
}

function createCue(trackId: string, source: CaptionBlock, translatedText: string): TranslationCaptionCue {
  const text = translatedText.trim();
  requiredIdentifier(trackId, 'Caption track');
  requiredIdentifier(source.id, 'Primary caption');
  const id = `${trackId}:${source.id}`;
  if (!isTranslationCueIdentifier(id)) throw new Error('Translation cue identifier is invalid.');
  return {
    id,
    sourceCaptionId: source.id,
    sourceTextSnapshot: source.text,
    text,
    status: text ? 'translated' : 'pending',
    reviewed: false,
    startMs: source.startMs,
    endMs: source.endMs,
    timelineVisible: source.timelineVisible !== false,
  };
}

function synchronizeCue(trackId: string, source: CaptionBlock, cue: TranslationCaptionCue | undefined) {
  if (!cue) return createCue(trackId, source, '');
  if (cue.sourceTextSnapshot === source.text) {
    if (cue.status !== 'stale') return cue;
    return { ...cue, status: cue.reviewed ? 'reviewed' as const : 'translated' as const };
  }
  if (!cue.text.trim()) {
    return { ...cue, sourceTextSnapshot: source.text, status: 'pending' as const, reviewed: false };
  }
  return { ...cue, status: 'stale' as const };
}

function requiredText(value: string, label: string) {
  const text = value.trim();
  if (!text) throw new Error(`${label} text cannot be empty.`);
  if (text.length > 100_000) throw new Error(`${label} text exceeds the supported project limit.`);
  return text;
}

function requiredIdentifier(value: string, label: string) {
  if (!isProjectIdentifier(value)) throw new Error(`${label} identifier is invalid.`);
  return value;
}

function requiredLanguageTag(value: string) {
  if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(value)) throw new Error('Caption track language is invalid.');
  return value;
}

function englishChineseTarget(languageTag: EnglishChineseCaptionLanguage) {
  if (languageTag === 'zh-Hans') {
    return { id: CHINESE_SIMPLIFIED_TRACK_ID, displayName: captionLanguageLabel('zh-Hans') };
  }
  if (languageTag === 'zh-Hant') {
    return { id: CHINESE_TRADITIONAL_TRACK_ID, displayName: captionLanguageLabel('zh-Hant') };
  }
  return { id: ENGLISH_TRACK_ID, displayName: captionLanguageLabel('en') };
}

function translationTargetStyle(custom: CaptionStylePatch | undefined) {
  if (custom) return mergePatch(DEFAULT_TRANSLATION_TRACK_STYLE, custom);
  return {
    ...DEFAULT_TRANSLATION_TRACK_STYLE,
    font: { ...DEFAULT_TRANSLATION_TRACK_STYLE.font },
    box: { ...DEFAULT_TRANSLATION_TRACK_STYLE.box },
    animation: { ...DEFAULT_TRANSLATION_TRACK_STYLE.animation },
  };
}

export function setTranslationStackGap(
  project: CaptionProject,
  trackId: string,
  stackGap: number,
  updatedAt = project.updatedAt,
) {
  const nextGap = clampStackGap(stackGap);
  return mapTranslationTrack(project, trackId, (track) => ({
    ...track,
    stackGap: nextGap,
    styleOverride: omitStylePosition(track.styleOverride),
    cues: track.cues.map((cue) => ({
      ...cue,
      styleOverride: omitStylePosition(cue.styleOverride),
    })),
  }), updatedAt);
}

export function stackedTranslationPosition(
  primary: CaptionStyle,
  translation: CaptionStyle,
  stackGap = DEFAULT_TRANSLATION_STACK_GAP,
) {
  return stackedTranslationLayout(primary, translation, stackGap).position;
}

export function stackedTranslationLayout(
  primary: CaptionStyle,
  translation: CaptionStyle,
  stackGap = DEFAULT_TRANSLATION_STACK_GAP,
) {
  const gap = clampStackGap(stackGap);
  const width = clamp(translation.box.width, 0.2, 1);
  const minHeight = 0.06;
  const desiredHeight = clamp(translation.box.height, minHeight, 0.4);
  const primaryBottom = primary.position.y + Math.max(0.04, primary.box.height / 2);
  const canvasBottom = 0.98;
  let top = primaryBottom + gap;
  let height = desiredHeight;
  if (top + height > canvasBottom) {
    height = Math.max(minHeight, canvasBottom - top);
  }
  if (top + minHeight > canvasBottom) {
    height = minHeight;
    top = Math.max(primaryBottom + MIN_TRANSLATION_STACK_GAP, canvasBottom - height);
  }
  const y = top + height / 2;
  const horizontalLimit = Math.max(0.05, (1 - width) / 2);
  return {
    position: {
      x: clamp(primary.position.x, horizontalLimit, 1 - horizontalLimit),
      y: Math.max(primary.position.y + 0.02, y),
    },
    box: { width, height },
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampStackGap(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TRANSLATION_STACK_GAP;
  return clamp(value, MIN_TRANSLATION_STACK_GAP, MAX_TRANSLATION_STACK_GAP);
}

function omitStylePosition(patch: CaptionStylePatch | undefined) {
  if (!patch) return undefined;
  const { position: _position, ...rest } = patch;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function requiredDisplayName(value: string) {
  const displayName = value.trim();
  if (!displayName) throw new Error('Caption track name cannot be empty.');
  if (displayName.length > 16_384) throw new Error('Caption track name exceeds the supported project limit.');
  return displayName;
}

function translationValue(translations: Readonly<Record<string, string>> | undefined, sourceCaptionId: string) {
  if (!translations || !Object.prototype.hasOwnProperty.call(translations, sourceCaptionId)) return '';
  const value = translations[sourceCaptionId];
  if (typeof value !== 'string') throw new Error(`Translation for caption ${sourceCaptionId} is invalid.`);
  if (value.length > 100_000) throw new Error(`Translation for caption ${sourceCaptionId} exceeds the supported project limit.`);
  return value;
}

function sameLanguage(left: string, right: string) {
  return sameCaptionLanguageFamily(left, right);
}

function validateTranslationProvider(provider: TranslationCaptionTrack['provider']) {
  if (provider.id === 'litertlm' && (!provider.modelId || !provider.modelRevision || !Number.isInteger(provider.promptVersion))) {
    throw new Error('Local caption translation provenance is incomplete.');
  }
  if (provider.id === 'manual' && (provider.modelId || provider.modelRevision || provider.promptVersion !== undefined)) {
    throw new Error('Manual caption translation cannot claim local-model provenance.');
  }
}
