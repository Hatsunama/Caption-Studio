import { ANIMATION_PRESETS } from '@/lib/animation-presets';
import { emptyCaptionTrackCollection, synchronizeCaptionTracks } from '@/lib/caption-tracks';
import { sameCaptionLanguageFamily } from '@/lib/caption-languages';
import { hydrateVideoTransition } from '@/lib/video-transitions';
import { DEFAULT_VIDEO_FRAME_RATE } from '@/lib/video-source-metadata';
import {
  DEFAULT_CAPTION_STYLE,
  DEFAULT_VIDEO_TRANSFORM,
  type AudioClip,
  type BackgroundReplacement,
  type CaptionBlock,
  type CaptionProject,
  type CaptionStyle,
  type CaptionStylePatch,
  type CaptionTrackCollection,
  type FontReference,
  type ImageVisualLayer,
  type LayerSourceAnchor,
  type ProjectAudioSource,
  type ProjectVideoSource,
  type SourceTranscription,
  type TextVisualLayer,
  type VisualLayer,
  type VideoClip,
  type VideoTransform,
  type WordToken,
} from '@/types/project';

const ANIMATION_IDS = new Set(ANIMATION_PRESETS.map((preset) => preset.id));
const COLOR_PATTERN = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

export function decodeVersionTwoProject(candidate: Record<string, unknown>): CaptionProject {
  if (candidate.schemaVersion !== 2) throw new Error('Project data uses an unsupported version');
  const createdAt = dateString(candidate.createdAt, 'project creation date');
  const updatedAt = dateString(candidate.updatedAt, 'project update date');
  const sources = decodeArray(candidate.sources, 'project sources', 500, decodeVideoSource);
  if (sources.length === 0) throw new Error('A project requires at least one video source');
  const sourceIds = uniqueIds(sources, 'project video sources');
  const legacyVideoTransform = decodeVideoTransform(candidate.videoTransform, 'project video transform');
  const decodedClips = decodeArray(candidate.clips, 'project video clips', 5_000, decodeVideoClip);
  decodedClips.forEach((clip) => {
    if (!sourceIds.has(clip.sourceId)) throw new Error('A project video clip references an unknown source');
  });
  uniqueIds(decodedClips, 'project video clips');
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const clips: VideoClip[] = decodedClips.map((clip, index) => {
    const source = sourceById.get(clip.sourceId)!;
    const previous = decodedClips[index - 1];
    const next = decodedClips[index + 1];
    return {
      ...clip,
      availableSourceStartMs: clip.availableSourceStartMs
        ?? (previous?.sourceId === clip.sourceId ? (previous.sourceEndMs + clip.sourceStartMs) / 2 : 0),
      availableSourceEndMs: clip.availableSourceEndMs
        ?? (next?.sourceId === clip.sourceId ? (clip.sourceEndMs + next.sourceStartMs) / 2 : source.durationMs),
      transitionAfter: hydrateVideoTransition(clip.transitionAfter),
      transform: decodeVideoTransform(
        clip.transform,
        `video clip ${index + 1} transform`,
        legacyVideoTransform,
      ),
    };
  });
  const audioSources = candidate.audioSources === undefined
    ? []
    : decodeArray(candidate.audioSources, 'project audio sources', 5_000, decodeAudioSource);
  const audioSourceIds = uniqueIds(audioSources, 'project audio sources');
  const audioClips = candidate.audioClips === undefined
    ? []
    : decodeArray(candidate.audioClips, 'project audio clips', 10_000, decodeAudioClip);
  audioClips.forEach((clip) => {
    if (!audioSourceIds.has(clip.sourceId)) throw new Error('A project audio clip references an unknown source');
  });
  const projectStyle = decodeCaptionStyle(candidate.projectStyle, DEFAULT_CAPTION_STYLE, 'project caption style');
  const layers = decodeLayers(candidate.layers, projectStyle);
  const transcription = decodeTranscription(candidate.transcription, updatedAt);
  const captions = decodeArray(candidate.captions, 'project captions', 100_000, decodeCaption);
  uniqueIds(captions, 'project captions');
  const captionTracks = decodeCaptionTracks(candidate.captionTracks, captions, transcription.language);
  const clipIds = new Set(clips.map((clip) => clip.id));
  captions.forEach((caption) => {
    if (caption.sourceAnchor && !clipIds.has(caption.sourceAnchor.clipId)) {
      throw new Error('A project caption references an unknown video clip');
    }
  });
  layers.forEach((layer) => {
    if (layer.kind === 'captions') return;
    layer.sourceAnchors?.forEach((anchor) => {
      if (!clipIds.has(anchor.clipId)) throw new Error('A project visual layer references an unknown video clip');
    });
  });
  return {
    schemaVersion: 2,
    id: identifierValue(candidate.id, 'project identifier'),
    name: nonEmptyString(candidate.name, 'project name'),
    createdAt,
    updatedAt,
    lifecycle: decodeLifecycle(candidate.lifecycle),
    sources,
    transcription,
    captions,
    captionTracks,
    projectStyle,
    layers,
    clips,
    audioSources,
    audioClips,
    canvas: decodeCanvas(candidate.canvas, sources[0]),
    videoTransform: legacyVideoTransform,
    backgroundReplacement: decodeBackgroundReplacement(candidate.backgroundReplacement),
    export: decodeExport(candidate.export),
  };
}

function decodeVideoSource(value: unknown, index: number): ProjectVideoSource {
  const source = record(value, `video source ${index + 1}`);
  const uri = localMediaUri(source.uri, `video source ${index + 1} URI`);
  const storageMode = optionalEnum(source.storageMode, ['linked', 'copied'] as const, `video source ${index + 1} storage mode`)
    ?? (uri.startsWith('content:') ? 'linked' : 'copied');
  if (storageMode === 'linked' && !uri.startsWith('content:')) {
    throw new Error(`Video source ${index + 1} has an invalid linked URI`);
  }
  return {
    id: identifierValue(source.id, `video source ${index + 1} identifier`),
    uri,
    storageMode,
    sizeBytes: optionalFiniteNumber(source.sizeBytes, `video source ${index + 1} size`, 0, Number.MAX_SAFE_INTEGER),
    mimeType: optionalNonEmptyString(source.mimeType, `video source ${index + 1} MIME type`),
    thumbnailUri: optionalLocalFileUri(source.thumbnailUri, `video source ${index + 1} thumbnail URI`),
    displayName: nonEmptyString(source.displayName, `video source ${index + 1} name`),
    durationMs: finiteNumber(source.durationMs, `video source ${index + 1} duration`, 1, Number.MAX_SAFE_INTEGER),
    width: source.width === undefined ? 1 : finiteNumber(source.width, `video source ${index + 1} width`, 1, 65_535),
    height: source.height === undefined ? 1 : finiteNumber(source.height, `video source ${index + 1} height`, 1, 65_535),
    rotation: source.rotation === undefined ? 0 : finiteNumber(source.rotation, `video source ${index + 1} rotation`, -360_000, 360_000),
    frameRate: optionalNumber(
      source.frameRate,
      DEFAULT_VIDEO_FRAME_RATE,
      `video source ${index + 1} frame rate`,
      1,
      240,
    ),
  };
}

function decodeVideoClip(value: unknown, index: number): Omit<VideoClip, 'availableSourceStartMs' | 'availableSourceEndMs' | 'transitionAfter' | 'transform'> & {
  availableSourceStartMs?: number;
  availableSourceEndMs?: number;
  transitionAfter: unknown;
  transform?: unknown;
} {
  const clip = record(value, `video clip ${index + 1}`);
  return {
    id: identifierValue(clip.id, `video clip ${index + 1} identifier`),
    sourceId: identifierValue(clip.sourceId, `video clip ${index + 1} source identifier`),
    availableSourceStartMs: optionalFiniteNumber(clip.availableSourceStartMs, `video clip ${index + 1} available start`, 0, Number.MAX_SAFE_INTEGER),
    availableSourceEndMs: optionalFiniteNumber(clip.availableSourceEndMs, `video clip ${index + 1} available end`, 0, Number.MAX_SAFE_INTEGER),
    sourceStartMs: finiteNumber(clip.sourceStartMs, `video clip ${index + 1} source start`, 0, Number.MAX_SAFE_INTEGER),
    sourceEndMs: finiteNumber(clip.sourceEndMs, `video clip ${index + 1} source end`, 0, Number.MAX_SAFE_INTEGER),
    gapBeforeMs: clip.gapBeforeMs === undefined ? 0 : finiteNumber(clip.gapBeforeMs, `video clip ${index + 1} leading gap`, 0, Number.MAX_SAFE_INTEGER),
    gapAfterMs: clip.gapAfterMs === undefined ? 0 : finiteNumber(clip.gapAfterMs, `video clip ${index + 1} trailing gap`, 0, Number.MAX_SAFE_INTEGER),
    playbackRate: clip.playbackRate === undefined ? 1 : finiteNumber(clip.playbackRate, `video clip ${index + 1} playback rate`, 0.25, 4),
    volume: clip.volume === undefined ? 1 : finiteNumber(clip.volume, `video clip ${index + 1} volume`, 0, 1),
    muted: clip.muted === undefined ? false : booleanValue(clip.muted, `video clip ${index + 1} mute state`),
    fadeInMs: clip.fadeInMs === undefined ? 0 : finiteNumber(clip.fadeInMs, `video clip ${index + 1} fade in`, 0, Number.MAX_SAFE_INTEGER),
    fadeOutMs: clip.fadeOutMs === undefined ? 0 : finiteNumber(clip.fadeOutMs, `video clip ${index + 1} fade out`, 0, Number.MAX_SAFE_INTEGER),
    transitionAfter: clip.transitionAfter,
    transform: clip.transform,
  };
}

function decodeAudioSource(value: unknown, index: number): ProjectAudioSource {
  const source = record(value, `audio source ${index + 1}`);
  const storageMode = source.storageMode === undefined
    ? 'copied'
    : enumValue(source.storageMode, ['copied'] as const, `audio source ${index + 1} storage mode`);
  return {
    id: identifierValue(source.id, `audio source ${index + 1} identifier`),
    uri: localFileUri(source.uri, `audio source ${index + 1} URI`),
    storageMode,
    displayName: nonEmptyString(source.displayName, `audio source ${index + 1} name`),
    durationMs: finiteNumber(source.durationMs, `audio source ${index + 1} duration`, 80, Number.MAX_SAFE_INTEGER),
    mimeType: optionalNonEmptyString(source.mimeType, `audio source ${index + 1} MIME type`),
    origin: source.origin === undefined
      ? 'audio-file'
      : enumValue(source.origin, ['audio-file', 'video-audio'] as const, `audio source ${index + 1} origin`),
  };
}

function decodeAudioClip(value: unknown, index: number): AudioClip {
  const clip = record(value, `audio clip ${index + 1}`);
  return {
    id: identifierValue(clip.id, `audio clip ${index + 1} identifier`),
    sourceId: identifierValue(clip.sourceId, `audio clip ${index + 1} source identifier`),
    anchor: clip.anchor === undefined ? 'timeline' : enumValue(clip.anchor, ['timeline'] as const, `audio clip ${index + 1} anchor`),
    startMs: finiteNumber(clip.startMs, `audio clip ${index + 1} timeline start`, 0, Number.MAX_SAFE_INTEGER),
    sourceStartMs: finiteNumber(clip.sourceStartMs, `audio clip ${index + 1} source start`, 0, Number.MAX_SAFE_INTEGER),
    sourceEndMs: finiteNumber(clip.sourceEndMs, `audio clip ${index + 1} source end`, 0, Number.MAX_SAFE_INTEGER),
    volume: clip.volume === undefined ? 1 : finiteNumber(clip.volume, `audio clip ${index + 1} volume`, 0, 1),
    muted: clip.muted === undefined ? false : booleanValue(clip.muted, `audio clip ${index + 1} mute state`),
    fadeInMs: clip.fadeInMs === undefined ? 0 : finiteNumber(clip.fadeInMs, `audio clip ${index + 1} fade in`, 0, Number.MAX_SAFE_INTEGER),
    fadeOutMs: clip.fadeOutMs === undefined ? 0 : finiteNumber(clip.fadeOutMs, `audio clip ${index + 1} fade out`, 0, Number.MAX_SAFE_INTEGER),
  };
}

function decodeTranscription(value: unknown, fallbackGeneratedAt: string): CaptionProject['transcription'] {
  const transcription = record(value, 'project transcription');
  const words = transcription.words === undefined
    ? []
    : decodeArray(transcription.words, 'project transcription words', 500_000, decodeWord);
  uniqueIds(words, 'project transcription words');
  const rawResults = transcription.sourceResults === undefined
    ? {}
    : record(transcription.sourceResults, 'source transcription results');
  const sourceResults = Object.create(null) as Record<string, SourceTranscription>;
  for (const [sourceId, rawResult] of Object.entries(rawResults)) {
    identifierValue(sourceId, 'source transcription identifier');
    const result = record(rawResult, `source transcription ${sourceId}`);
    const sourceWords = decodeArray(result.words, `source transcription ${sourceId} words`, 500_000, decodeWord);
    uniqueIds(sourceWords, `source transcription ${sourceId} words`);
    sourceResults[sourceId] = {
      language: nonEmptyString(result.language, `source transcription ${sourceId} language`),
      modelId: nonEmptyString(result.modelId, `source transcription ${sourceId} model`),
      generatedAt: result.generatedAt === undefined
        ? fallbackGeneratedAt
        : dateString(result.generatedAt, `source transcription ${sourceId} generation date`),
      sourceFingerprint: decodeSourceTranscriptionFingerprint(
        result.sourceFingerprint,
        `source transcription ${sourceId} fingerprint`,
      ),
      words: sourceWords,
    };
  }
  return {
    language: optionalNonEmptyString(transcription.language, 'transcription language') ?? 'en',
    modelId: optionalNonEmptyString(transcription.modelId, 'transcription model') ?? 'balanced',
    generatedAt: optionalDateString(transcription.generatedAt, 'transcription generation date'),
    words,
    sourceResults,
  };
}

function decodeSourceTranscriptionFingerprint(
  value: unknown,
  label: string,
): SourceTranscription['sourceFingerprint'] {
  if (value === undefined) return undefined;
  const fingerprint = record(value, label);
  const algorithm = enumValue(fingerprint.algorithm, ['sha256'] as const, `${label} algorithm`);
  const digest = nonEmptyString(fingerprint.digest, `${label} digest`).toLowerCase();
  if (!SHA256_PATTERN.test(digest)) throw new Error(`${label} digest is invalid`);
  return { algorithm, digest };
}

function decodeWord(value: unknown, index: number): WordToken {
  const word = record(value, `word ${index + 1}`);
  const startMs = finiteNumber(word.startMs, `word ${index + 1} start`, 0, Number.MAX_SAFE_INTEGER);
  const endMs = finiteNumber(word.endMs, `word ${index + 1} end`, startMs, Number.MAX_SAFE_INTEGER);
  return {
    id: identifierValue(word.id, `word ${index + 1} identifier`),
    text: boundedString(word.text, `word ${index + 1} text`, 4_096),
    startMs,
    endMs,
    confidence: optionalFiniteNumber(word.confidence, `word ${index + 1} confidence`, 0, 1),
    styleOverride: decodeCaptionStylePatch(word.styleOverride, `word ${index + 1} style override`),
  };
}

function decodeCaption(value: unknown, index: number): CaptionBlock {
  const caption = record(value, `caption ${index + 1}`);
  const startMs = finiteNumber(caption.startMs, `caption ${index + 1} start`, 0, Number.MAX_SAFE_INTEGER);
  const endMs = finiteNumber(caption.endMs, `caption ${index + 1} end`, startMs, Number.MAX_SAFE_INTEGER);
  const wordIds = decodeStringArray(caption.wordIds, `caption ${index + 1} word identifiers`, 10_000);
  return {
    id: identifierValue(caption.id, `caption ${index + 1} identifier`),
    text: boundedString(caption.text, `caption ${index + 1} text`, 100_000),
    startMs,
    endMs,
    wordIds,
    textMode: optionalEnum(caption.textMode, ['automatic', 'manual'] as const, `caption ${index + 1} text mode`),
    timelineVisible: caption.timelineVisible === undefined ? true : booleanValue(caption.timelineVisible, `caption ${index + 1} timeline visibility`),
    sourceAnchor: caption.sourceAnchor === undefined
      ? undefined
      : decodeCaptionSourceAnchor(caption.sourceAnchor, index),
    styleOverride: decodeCaptionStylePatch(caption.styleOverride, `caption ${index + 1} style override`),
  };
}

function decodeCaptionSourceAnchor(value: unknown, index: number) {
  const anchor = record(value, `caption ${index + 1} source anchor`);
  const sourceStartMs = finiteNumber(anchor.sourceStartMs, `caption ${index + 1} source anchor start`, 0, Number.MAX_SAFE_INTEGER);
  return {
    clipId: identifierValue(anchor.clipId, `caption ${index + 1} source clip identifier`),
    sourceStartMs,
    sourceEndMs: finiteNumber(anchor.sourceEndMs, `caption ${index + 1} source anchor end`, sourceStartMs, Number.MAX_SAFE_INTEGER),
    wordIds: anchor.wordIds === undefined
      ? []
      : decodeStringArray(anchor.wordIds, `caption ${index + 1} source word identifiers`, 10_000),
  };
}

function decodeCaptionTracks(value: unknown, captions: CaptionBlock[], primaryLanguage: string): CaptionTrackCollection {
  if (value === undefined) return emptyCaptionTrackCollection();
  const collection = record(value, 'caption track collection');
  if (collection.schemaVersion !== 1) throw new Error('Caption tracks use an unsupported version');
  if (collection.primaryTrackId !== 'captions') throw new Error('Caption tracks reference an invalid primary track');
  const primaryCaptionIds = new Set(captions.map((caption) => caption.id));
  const translations = decodeArray(
    collection.translations,
    'translation caption tracks',
    64,
    (rawTrack, trackIndex) => {
      const track = record(rawTrack, `translation track ${trackIndex + 1}`);
      const id = identifierValue(track.id, `translation track ${trackIndex + 1} identifier`);
      if (track.kind !== 'translation' || track.sourceTrackId !== 'captions') {
        throw new Error(`Translation track ${trackIndex + 1} has an invalid track relationship`);
      }
      const sourceLanguageTag = optionalNonEmptyString(
        track.sourceLanguageTag,
        `translation track ${trackIndex + 1} source language`,
      ) ?? primaryLanguage;
      const languageTag = nonEmptyString(track.languageTag, `translation track ${trackIndex + 1} language`);
      if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(sourceLanguageTag)) {
        throw new Error(`Translation track ${trackIndex + 1} source language is invalid`);
      }
      if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(languageTag)) {
        throw new Error(`Translation track ${trackIndex + 1} language is invalid`);
      }
      if (!sameCaptionLanguageFamily(sourceLanguageTag, primaryLanguage)) {
        throw new Error(`Translation track ${trackIndex + 1} no longer matches the primary caption language`);
      }
      if (sameCaptionLanguageFamily(sourceLanguageTag, languageTag)) {
        throw new Error(`Translation track ${trackIndex + 1} duplicates the primary language`);
      }
      const origin = track.origin === undefined
        ? 'manual' as const
        : enumValue(track.origin, ['manual', 'automatic'] as const, `translation track ${trackIndex + 1} origin`);
      const providerRecord = track.provider === undefined
        ? undefined
        : record(track.provider, `translation track ${trackIndex + 1} provider`);
      const providerId = providerRecord === undefined
        ? (origin === 'automatic' ? 'litertlm' as const : 'manual' as const)
        : enumValue(providerRecord.id, ['manual', 'litertlm'] as const, `translation track ${trackIndex + 1} provider`);
      if ((origin === 'automatic') !== (providerId === 'litertlm')) {
        throw new Error(`Translation track ${trackIndex + 1} has inconsistent provider metadata`);
      }
      const promptVersion = providerRecord === undefined
        ? undefined
        : optionalFiniteNumber(providerRecord.promptVersion, `translation track ${trackIndex + 1} prompt version`, 1, Number.MAX_SAFE_INTEGER);
      if (promptVersion !== undefined && !Number.isInteger(promptVersion)) {
        throw new Error(`Translation track ${trackIndex + 1} prompt version must be an integer`);
      }
      const modelId = providerRecord === undefined
        ? undefined
        : optionalNonEmptyString(providerRecord.modelId, `translation track ${trackIndex + 1} model`);
      const modelRevision = providerRecord === undefined
        ? undefined
        : optionalNonEmptyString(providerRecord.modelRevision, `translation track ${trackIndex + 1} model revision`);
      if (providerId === 'litertlm' && (!modelId || !modelRevision || promptVersion === undefined)) {
        throw new Error(`Translation track ${trackIndex + 1} has incomplete local-model provenance`);
      }
      if (providerId === 'manual' && (modelId || modelRevision || promptVersion !== undefined)) {
        throw new Error(`Translation track ${trackIndex + 1} has false local-model provenance`);
      }
      const cues = decodeArray(track.cues, `translation track ${trackIndex + 1} cues`, 100_000, (rawCue, cueIndex) => {
        const cue = record(rawCue, `translation cue ${cueIndex + 1}`);
        const text = boundedString(cue.text, `translation cue ${cueIndex + 1} text`, 100_000);
        const status = enumValue(
          cue.status,
          ['pending', 'translated', 'reviewed', 'stale'] as const,
          `translation cue ${cueIndex + 1} status`,
        );
        if (!text.trim() && (status === 'translated' || status === 'reviewed')) {
          throw new Error(`Translation cue ${cueIndex + 1} has no translated text`);
        }
        const reviewed = cue.reviewed === undefined
          ? status === 'reviewed'
          : booleanValue(cue.reviewed, `translation cue ${cueIndex + 1} review state`);
        if (reviewed !== (status === 'reviewed')) {
          throw new Error(`Translation cue ${cueIndex + 1} has inconsistent review state`);
        }
        return {
          id: identifierValue(cue.id, `translation cue ${cueIndex + 1} identifier`),
          sourceCaptionId: identifierValue(cue.sourceCaptionId, `translation cue ${cueIndex + 1} source caption`),
          sourceTextSnapshot: boundedString(cue.sourceTextSnapshot, `translation cue ${cueIndex + 1} source snapshot`, 100_000),
          text,
          status,
          reviewed,
          styleOverride: decodeCaptionStylePatch(cue.styleOverride, `translation cue ${cueIndex + 1} style override`),
        };
      });
      uniqueIds(cues, `translation track ${trackIndex + 1} cues`);
      const sourceCaptionIds = new Set<string>();
      cues.forEach((cue) => {
        if (!primaryCaptionIds.has(cue.sourceCaptionId)) {
          throw new Error(`Translation track ${trackIndex + 1} references an unknown primary caption`);
        }
        if (sourceCaptionIds.has(cue.sourceCaptionId)) {
          throw new Error(`Translation track ${trackIndex + 1} has duplicate source-caption links`);
        }
        sourceCaptionIds.add(cue.sourceCaptionId);
      });
      return {
        id,
        kind: 'translation' as const,
        sourceTrackId: 'captions' as const,
        sourceLanguageTag,
        languageTag,
        displayName: nonEmptyString(track.displayName, `translation track ${trackIndex + 1} name`),
        visible: track.visible === undefined ? true : booleanValue(track.visible, `translation track ${trackIndex + 1} visibility`),
        origin,
        provider: {
          id: providerId,
          modelId,
          modelRevision,
          promptVersion,
        },
        stackGap: optionalFiniteNumber(track.stackGap, `translation track ${trackIndex + 1} stack gap`, 0.008, 0.18) ?? 0.028,
        styleOverride: decodeCaptionStylePatch(track.styleOverride, `translation track ${trackIndex + 1} style override`),
        cues,
      };
    },
  );
  uniqueIds(translations, 'translation caption tracks');
  const languageTags = new Set<string>();
  translations.forEach((track) => {
    const normalized = track.languageTag.toLowerCase();
    if (languageTags.has(normalized)) throw new Error('Translation caption tracks contain duplicate languages');
    languageTags.add(normalized);
  });
  let visibleTrackFound = false;
  const normalizedTranslations = translations.map((track) => {
    if (!track.visible) return track;
    if (!visibleTrackFound) {
      visibleTrackFound = true;
      return track;
    }
    return { ...track, visible: false };
  });
  return synchronizeCaptionTracks({
    captions,
    captionTracks: { schemaVersion: 1, primaryTrackId: 'captions', translations: normalizedTranslations },
  });
}

function decodeLayers(value: unknown, projectStyle: CaptionStyle): VisualLayer[] {
  const rawLayers = value === undefined
    ? [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true }]
    : arrayValue(value, 'project visual layers', 5_000);
  const layers = rawLayers.map((rawLayer, index): VisualLayer => {
    const layer = record(rawLayer, `visual layer ${index + 1}`);
    const kind = enumValue(layer.kind, ['captions', 'text', 'image'] as const, `visual layer ${index + 1} kind`);
    if (kind === 'captions') {
      if (layer.id !== 'captions') throw new Error('The captions layer has an invalid identifier');
      return {
        id: 'captions',
        kind,
        name: nonEmptyString(layer.name, 'captions layer name'),
        visible: booleanValue(layer.visible, 'captions layer visibility'),
      };
    }
    if (kind === 'text') return decodeTextLayer(layer, index, projectStyle);
    return decodeImageLayer(layer, index);
  });
  const ids = uniqueIds(layers, 'project visual layers');
  if (!ids.has('captions')) layers.unshift({ id: 'captions', kind: 'captions', name: 'Captions', visible: true });
  return layers;
}

function decodeTextLayer(layer: Record<string, unknown>, index: number, projectStyle: CaptionStyle): TextVisualLayer {
  const startMs = finiteNumber(layer.startMs, `text layer ${index + 1} start`, 0, Number.MAX_SAFE_INTEGER);
  const id = identifierValue(layer.id, `text layer ${index + 1} identifier`);
  if (id === 'captions') throw new Error('A text layer cannot use the captions layer identifier');
  return {
    id,
    kind: 'text',
    name: nonEmptyString(layer.name, `text layer ${index + 1} name`),
    visible: booleanValue(layer.visible, `text layer ${index + 1} visibility`),
    text: boundedString(layer.text, `text layer ${index + 1} text`, 1_000_000),
    startMs,
    endMs: finiteNumber(layer.endMs, `text layer ${index + 1} end`, startMs, Number.MAX_SAFE_INTEGER),
    style: decodeCaptionStyle(layer.style, projectStyle, `text layer ${index + 1} style`),
    sourceAnchors: decodeSourceAnchors(layer.sourceAnchors, `text layer ${index + 1}`),
    timelineVisible: layer.timelineVisible === undefined ? true : booleanValue(layer.timelineVisible, `text layer ${index + 1} timeline visibility`),
  };
}

function decodeImageLayer(layer: Record<string, unknown>, index: number): ImageVisualLayer {
  const startMs = finiteNumber(layer.startMs, `image layer ${index + 1} start`, 0, Number.MAX_SAFE_INTEGER);
  const id = identifierValue(layer.id, `image layer ${index + 1} identifier`);
  if (id === 'captions') throw new Error('An image layer cannot use the captions layer identifier');
  return {
    id,
    kind: 'image',
    name: nonEmptyString(layer.name, `image layer ${index + 1} name`),
    visible: booleanValue(layer.visible, `image layer ${index + 1} visibility`),
    uri: localFileUri(layer.uri, `image layer ${index + 1} URI`),
    startMs,
    endMs: finiteNumber(layer.endMs, `image layer ${index + 1} end`, startMs, Number.MAX_SAFE_INTEGER),
    position: decodePoint(layer.position, `image layer ${index + 1} position`, -4, 4),
    box: decodeBox(layer.box, `image layer ${index + 1} box`),
    rotation: finiteNumber(layer.rotation, `image layer ${index + 1} rotation`, -360_000, 360_000),
    opacity: finiteNumber(layer.opacity, `image layer ${index + 1} opacity`, 0, 1),
    sourceAnchors: decodeSourceAnchors(layer.sourceAnchors, `image layer ${index + 1}`),
    timelineVisible: layer.timelineVisible === undefined ? true : booleanValue(layer.timelineVisible, `image layer ${index + 1} timeline visibility`),
  };
}

function decodeSourceAnchors(value: unknown, label: string): LayerSourceAnchor[] | undefined {
  if (value === undefined) return undefined;
  return decodeArray(value, `${label} source anchors`, 5_000, (rawAnchor, index) => {
    const anchor = record(rawAnchor, `${label} source anchor ${index + 1}`);
    const sourceStartMs = finiteNumber(anchor.sourceStartMs, `${label} source anchor ${index + 1} start`, 0, Number.MAX_SAFE_INTEGER);
    return {
      clipId: identifierValue(anchor.clipId, `${label} source anchor ${index + 1} clip identifier`),
      sourceStartMs,
      sourceEndMs: finiteNumber(anchor.sourceEndMs, `${label} source anchor ${index + 1} end`, sourceStartMs, Number.MAX_SAFE_INTEGER),
    };
  });
}

function decodeCaptionStyle(value: unknown, fallback: CaptionStyle, label: string): CaptionStyle {
  if (value === undefined) return cloneStyle(fallback);
  const style = record(value, label);
  return {
    font: decodeFont(style.font, fallback.font, `${label} font`),
    fontSize: optionalNumber(style.fontSize, fallback.fontSize, `${label} font size`, 6, 400),
    fontWeight: optionalEnum(style.fontWeight, ['400', '500', '600', '700', '800', '900'] as const, `${label} font weight`) ?? fallback.fontWeight,
    italic: optionalBoolean(style.italic, fallback.italic, `${label} italic state`),
    textColor: optionalColor(style.textColor, fallback.textColor, `${label} text color`),
    secondaryTextColor: optionalColor(style.secondaryTextColor, fallback.secondaryTextColor, `${label} secondary text color`),
    textTreatment: optionalEnum(style.textTreatment, ['solid', 'duotone-offset', 'duotone-shadow', 'duotone-neon'] as const, `${label} treatment`) ?? fallback.textTreatment,
    activeWordColor: optionalColor(style.activeWordColor, fallback.activeWordColor, `${label} active-word color`),
    stroke: decodeStroke(style.stroke, fallback.stroke, `${label} stroke`),
    shadow: decodeShadow(style.shadow, fallback.shadow, `${label} shadow`),
    background: decodeTextBackground(style.background, fallback.background, `${label} background`),
    alignment: optionalEnum(style.alignment, ['left', 'center', 'right'] as const, `${label} alignment`) ?? fallback.alignment,
    letterSpacing: optionalNumber(style.letterSpacing, fallback.letterSpacing, `${label} letter spacing`, -20, 100),
    lineHeight: optionalNumber(style.lineHeight, fallback.lineHeight, `${label} line height`, 0.5, 5),
    textTransform: optionalEnum(style.textTransform, ['none', 'uppercase', 'lowercase'] as const, `${label} transform`) ?? fallback.textTransform,
    position: style.position === undefined ? { ...fallback.position } : decodePoint(style.position, `${label} position`, -4, 4),
    box: style.box === undefined ? { ...fallback.box } : decodeBox(style.box, `${label} box`),
    rotation: optionalNumber(style.rotation, fallback.rotation, `${label} rotation`, -360_000, 360_000),
    maxLines: optionalNumber(style.maxLines, fallback.maxLines, `${label} maximum lines`, 1, 100),
    animation: decodeAnimation(style.animation, fallback.animation, `${label} animation`),
  };
}

function decodeCaptionStylePatch(value: unknown, label: string): CaptionStylePatch | undefined {
  if (value === undefined) return undefined;
  const patch = record(value, label);
  const decoded: CaptionStylePatch = {};
  if (patch.font !== undefined) decoded.font = decodeFontPatch(patch.font, `${label} font`);
  if (patch.fontSize !== undefined) decoded.fontSize = finiteNumber(patch.fontSize, `${label} font size`, 6, 400);
  if (patch.fontWeight !== undefined) decoded.fontWeight = enumValue(patch.fontWeight, ['400', '500', '600', '700', '800', '900'] as const, `${label} font weight`);
  if (patch.italic !== undefined) decoded.italic = booleanValue(patch.italic, `${label} italic state`);
  if (patch.textColor !== undefined) decoded.textColor = colorValue(patch.textColor, `${label} text color`);
  if (patch.secondaryTextColor !== undefined) decoded.secondaryTextColor = colorValue(patch.secondaryTextColor, `${label} secondary text color`);
  if (patch.textTreatment !== undefined) decoded.textTreatment = enumValue(patch.textTreatment, ['solid', 'duotone-offset', 'duotone-shadow', 'duotone-neon'] as const, `${label} treatment`);
  if (patch.activeWordColor !== undefined) decoded.activeWordColor = colorValue(patch.activeWordColor, `${label} active-word color`);
  if (patch.stroke !== undefined) decoded.stroke = decodeStrokePatch(patch.stroke, `${label} stroke`);
  if (patch.shadow !== undefined) decoded.shadow = decodeShadowPatch(patch.shadow, `${label} shadow`);
  if (patch.background !== undefined) decoded.background = decodeBackgroundPatch(patch.background, `${label} background`);
  if (patch.alignment !== undefined) decoded.alignment = enumValue(patch.alignment, ['left', 'center', 'right'] as const, `${label} alignment`);
  if (patch.letterSpacing !== undefined) decoded.letterSpacing = finiteNumber(patch.letterSpacing, `${label} letter spacing`, -20, 100);
  if (patch.lineHeight !== undefined) decoded.lineHeight = finiteNumber(patch.lineHeight, `${label} line height`, 0.5, 5);
  if (patch.textTransform !== undefined) decoded.textTransform = enumValue(patch.textTransform, ['none', 'uppercase', 'lowercase'] as const, `${label} transform`);
  if (patch.position !== undefined) decoded.position = decodePointPatch(patch.position, `${label} position`, -4, 4);
  if (patch.box !== undefined) decoded.box = decodeBoxPatch(patch.box, `${label} box`);
  if (patch.rotation !== undefined) decoded.rotation = finiteNumber(patch.rotation, `${label} rotation`, -360_000, 360_000);
  if (patch.maxLines !== undefined) decoded.maxLines = finiteNumber(patch.maxLines, `${label} maximum lines`, 1, 100);
  if (patch.animation !== undefined) decoded.animation = decodeAnimationPatch(patch.animation, `${label} animation`);
  return decoded;
}

function decodeFont(value: unknown, fallback: FontReference, label: string): FontReference {
  if (value === undefined) return { ...fallback };
  const font = record(value, label);
  const family = optionalNonEmptyString(font.family, `${label} family`) ?? fallback.family;
  const rawSource = optionalEnum(font.source, ['system', 'built-in', 'imported'] as const, `${label} source`) ?? fallback.source;
  const source = normalizeFontSource(rawSource, family);
  const rawUri = optionalNonEmptyString(font.uri, `${label} URI`) ?? fallback.uri;
  const uri = source === 'imported' && rawUri ? localFileUri(rawUri, `${label} URI`) : rawUri;
  if (source === 'imported' && !uri) throw new Error(`${label} is missing its imported file URI`);
  if (source !== 'imported' && uri) throw new Error(`${label} has an invalid bundled font URI`);
  return {
    id: font.id === undefined ? fallback.id : identifierValue(font.id, `${label} identifier`),
    family,
    source: source as FontReference['source'],
    uri,
    postScriptName: optionalNonEmptyString(font.postScriptName, `${label} PostScript name`) ?? fallback.postScriptName,
  };
}

function decodeFontPatch(value: unknown, label: string): Partial<FontReference> {
  const font = record(value, label);
  const result: Partial<FontReference> = {};
  const family = font.family === undefined ? undefined : nonEmptyString(font.family, `${label} family`);
  const rawSource = font.source === undefined
    ? undefined
    : enumValue(font.source, ['system', 'built-in', 'imported'] as const, `${label} source`);
  const source = rawSource === undefined ? undefined : normalizeFontSource(rawSource, family);
  const rawUri = font.uri === undefined ? undefined : nonEmptyString(font.uri, `${label} URI`);
  const uri = source === 'imported' && rawUri ? localFileUri(rawUri, `${label} URI`) : rawUri;
  if (source === 'imported' && !uri) throw new Error(`${label} is missing its imported file URI`);
  if (source !== undefined && source !== 'imported' && uri) throw new Error(`${label} has an invalid bundled font URI`);
  if (font.id !== undefined) result.id = identifierValue(font.id, `${label} identifier`);
  if (family !== undefined) result.family = family;
  if (source !== undefined) result.source = source as FontReference['source'];
  if (uri !== undefined) result.uri = uri;
  if (font.postScriptName !== undefined) result.postScriptName = nonEmptyString(font.postScriptName, `${label} PostScript name`);
  return result;
}

function decodeStroke(value: unknown, fallback: CaptionStyle['stroke'], label: string) {
  if (value === undefined) return { ...fallback };
  const stroke = record(value, label);
  return {
    color: optionalColor(stroke.color, fallback.color, `${label} color`),
    width: optionalNumber(stroke.width, fallback.width, `${label} width`, 0, 100),
  };
}

function decodeStrokePatch(value: unknown, label: string) {
  const stroke = record(value, label);
  return {
    ...(stroke.color === undefined ? {} : { color: colorValue(stroke.color, `${label} color`) }),
    ...(stroke.width === undefined ? {} : { width: finiteNumber(stroke.width, `${label} width`, 0, 100) }),
  };
}

function decodeShadow(value: unknown, fallback: CaptionStyle['shadow'], label: string) {
  if (value === undefined) return { ...fallback };
  const shadow = record(value, label);
  return {
    color: optionalColor(shadow.color, fallback.color, `${label} color`),
    opacity: optionalNumber(shadow.opacity, fallback.opacity, `${label} opacity`, 0, 1),
    blur: optionalNumber(shadow.blur, fallback.blur, `${label} blur`, 0, 200),
    offsetX: optionalNumber(shadow.offsetX, fallback.offsetX, `${label} horizontal offset`, -500, 500),
    offsetY: optionalNumber(shadow.offsetY, fallback.offsetY, `${label} vertical offset`, -500, 500),
  };
}

function decodeShadowPatch(value: unknown, label: string) {
  const shadow = record(value, label);
  return {
    ...(shadow.color === undefined ? {} : { color: colorValue(shadow.color, `${label} color`) }),
    ...(shadow.opacity === undefined ? {} : { opacity: finiteNumber(shadow.opacity, `${label} opacity`, 0, 1) }),
    ...(shadow.blur === undefined ? {} : { blur: finiteNumber(shadow.blur, `${label} blur`, 0, 200) }),
    ...(shadow.offsetX === undefined ? {} : { offsetX: finiteNumber(shadow.offsetX, `${label} horizontal offset`, -500, 500) }),
    ...(shadow.offsetY === undefined ? {} : { offsetY: finiteNumber(shadow.offsetY, `${label} vertical offset`, -500, 500) }),
  };
}

function decodeTextBackground(value: unknown, fallback: CaptionStyle['background'], label: string) {
  if (value === undefined) return { ...fallback };
  const background = record(value, label);
  return {
    color: optionalColor(background.color, fallback.color, `${label} color`),
    opacity: optionalNumber(background.opacity, fallback.opacity, `${label} opacity`, 0, 1),
    radius: optionalNumber(background.radius, fallback.radius, `${label} radius`, 0, 500),
    paddingX: optionalNumber(background.paddingX, fallback.paddingX, `${label} horizontal padding`, 0, 500),
    paddingY: optionalNumber(background.paddingY, fallback.paddingY, `${label} vertical padding`, 0, 500),
  };
}

function decodeBackgroundPatch(value: unknown, label: string) {
  const background = record(value, label);
  return {
    ...(background.color === undefined ? {} : { color: colorValue(background.color, `${label} color`) }),
    ...(background.opacity === undefined ? {} : { opacity: finiteNumber(background.opacity, `${label} opacity`, 0, 1) }),
    ...(background.radius === undefined ? {} : { radius: finiteNumber(background.radius, `${label} radius`, 0, 500) }),
    ...(background.paddingX === undefined ? {} : { paddingX: finiteNumber(background.paddingX, `${label} horizontal padding`, 0, 500) }),
    ...(background.paddingY === undefined ? {} : { paddingY: finiteNumber(background.paddingY, `${label} vertical padding`, 0, 500) }),
  };
}

function decodeAnimation(value: unknown, fallback: CaptionStyle['animation'], label: string) {
  if (value === undefined) return { ...fallback };
  const animation = record(value, label);
  const id = animation.id === undefined ? fallback.id : animationId(animation.id, `${label} identifier`);
  return {
    id,
    intensity: optionalNumber(animation.intensity, fallback.intensity, `${label} intensity`, 0, 4),
    durationMs: optionalNumber(animation.durationMs, fallback.durationMs, `${label} duration`, 1, 60_000),
  };
}

function decodeAnimationPatch(value: unknown, label: string) {
  const animation = record(value, label);
  return {
    ...(animation.id === undefined ? {} : { id: animationId(animation.id, `${label} identifier`) }),
    ...(animation.intensity === undefined ? {} : { intensity: finiteNumber(animation.intensity, `${label} intensity`, 0, 4) }),
    ...(animation.durationMs === undefined ? {} : { durationMs: finiteNumber(animation.durationMs, `${label} duration`, 1, 60_000) }),
  };
}

function decodeCanvas(value: unknown, primary: ProjectVideoSource): CaptionProject['canvas'] {
  if (value === undefined) {
    return { preset: 'source', aspectWidth: primary.width, aspectHeight: primary.height, backgroundColor: '#000000' };
  }
  const canvas = record(value, 'project canvas');
  return {
    preset: optionalEnum(canvas.preset, ['source', '9:16', '16:9', '1:1', '4:5'] as const, 'project canvas preset') ?? 'source',
    aspectWidth: finiteNumber(canvas.aspectWidth, 'project canvas width', 1, 65_535),
    aspectHeight: finiteNumber(canvas.aspectHeight, 'project canvas height', 1, 65_535),
    backgroundColor: optionalColor(canvas.backgroundColor, '#000000', 'project canvas background color'),
  };
}

function decodeVideoTransform(
  value: unknown,
  label: string,
  fallback: VideoTransform = DEFAULT_VIDEO_TRANSFORM,
): VideoTransform {
  if (value === undefined) return { ...fallback, position: { ...fallback.position } };
  const transform = record(value, label);
  return {
    fit: optionalEnum(transform.fit, ['fit', 'fill'] as const, `${label} fit`) ?? fallback.fit,
    position: transform.position === undefined
      ? { ...fallback.position }
      : decodePoint(transform.position, `${label} position`, -4, 4),
    scale: optionalNumber(transform.scale, fallback.scale, `${label} scale`, 0.05, 20),
    rotation: optionalNumber(transform.rotation, fallback.rotation, `${label} rotation`, -360_000, 360_000),
  };
}

function decodeBackgroundReplacement(value: unknown): BackgroundReplacement {
  if (value === undefined) {
    return {
      enabled: false,
      mask: { qualityPreset: 'stable', threshold: 0.46, softness: 0.14, temporalStability: 0.78, edgeFeather: 0.45 },
      personTransform: { position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
      keyframes: [],
    };
  }
  const background = record(value, 'background replacement');
  const source = background.source === undefined ? undefined : decodeBackgroundSource(background.source);
  const mask = background.mask === undefined ? {} : record(background.mask, 'background replacement mask');
  const personTransform = background.personTransform === undefined
    ? {}
    : record(background.personTransform, 'background replacement person transform');
  return {
    enabled: background.enabled === undefined ? false : booleanValue(background.enabled, 'background replacement enabled state'),
    source,
    mask: {
      qualityPreset: optionalEnum(mask.qualityPreset, ['stable', 'balanced', 'detailed', 'custom'] as const, 'background replacement quality') ?? 'stable',
      threshold: optionalNumber(mask.threshold, 0.46, 'background replacement threshold', 0, 1),
      softness: optionalNumber(mask.softness, 0.14, 'background replacement softness', 0.001, 1),
      temporalStability: optionalNumber(mask.temporalStability, 0.78, 'background replacement temporal stability', 0, 0.92),
      edgeFeather: optionalNumber(mask.edgeFeather, 0.45, 'background replacement edge feather', 0, 1),
    },
    personTransform: {
      position: personTransform.position === undefined
        ? { x: 0.5, y: 0.5 }
        : decodePoint(personTransform.position, 'background replacement person position', -1, 2),
      scale: optionalNumber(personTransform.scale, 1, 'background replacement person scale', 0.05, 8),
      rotation: optionalNumber(personTransform.rotation, 0, 'background replacement person rotation', -360_000, 360_000),
    },
    keyframes: decodePersonKeyframes(background.keyframes),
  };
}

function decodeBackgroundSource(value: unknown): NonNullable<BackgroundReplacement['source']> {
  const source = record(value, 'background replacement source');
  const uri = localMediaUri(source.uri, 'background replacement source URI');
  const storageMode = optionalEnum(source.storageMode, ['linked', 'copied'] as const, 'background replacement storage mode')
    ?? (uri.startsWith('content:') ? 'linked' : 'copied');
  if (storageMode === 'linked' && !uri.startsWith('content:')) throw new Error('The linked background has an invalid URI');
  return {
    kind: enumValue(source.kind, ['image', 'video'] as const, 'background replacement source kind'),
    uri,
    storageMode,
    displayName: nonEmptyString(source.displayName, 'background replacement source name'),
  };
}

function decodePersonKeyframe(value: unknown, index: number) {
  const frame = record(value, `person keyframe ${index + 1}`);
  return {
    id: identifierValue(frame.id, `person keyframe ${index + 1} identifier`),
    timeMs: finiteNumber(frame.timeMs, `person keyframe ${index + 1} time`, 0, Number.MAX_SAFE_INTEGER),
    position: decodePoint(frame.position, `person keyframe ${index + 1} position`, -1, 2),
    scale: finiteNumber(frame.scale, `person keyframe ${index + 1} scale`, 0.05, 8),
    rotation: finiteNumber(frame.rotation, `person keyframe ${index + 1} rotation`, -360_000, 360_000),
  };
}

function decodePersonKeyframes(value: unknown) {
  if (value === undefined) return [];
  const keyframes = decodeArray(value, 'background replacement keyframes', 100_000, decodePersonKeyframe);
  uniqueIds(keyframes, 'background replacement keyframes');
  return keyframes;
}

function normalizeFontSource(source: string, family: string | undefined) {
  return source === 'built-in' && family === 'sans-serif' ? 'system' : source;
}

function decodeExport(value: unknown): CaptionProject['export'] {
  if (value === undefined) return { resolution: '1080p', format: 'mp4', burnCaptions: true };
  const exportSettings = record(value, 'project export settings');
  return {
    resolution: optionalEnum(exportSettings.resolution, ['720p', '1080p', 'original'] as const, 'project export resolution') ?? '1080p',
    format: optionalEnum(exportSettings.format, ['mp4'] as const, 'project export format') ?? 'mp4',
    burnCaptions: optionalBoolean(exportSettings.burnCaptions, true, 'project burn-captions setting'),
  };
}

function decodeLifecycle(value: unknown): CaptionProject['lifecycle'] {
  if (value === undefined) return { status: 'saved' };
  const lifecycle = record(value, 'project lifecycle');
  return { status: enumValue(lifecycle.status, ['draft', 'saved'] as const, 'project lifecycle status') };
}

function decodePoint(value: unknown, label: string, minimum: number, maximum: number) {
  const point = record(value, label);
  return {
    x: finiteNumber(point.x, `${label} x`, minimum, maximum),
    y: finiteNumber(point.y, `${label} y`, minimum, maximum),
  };
}

function decodePointPatch(value: unknown, label: string, minimum: number, maximum: number) {
  const point = record(value, label);
  return {
    ...(point.x === undefined ? {} : { x: finiteNumber(point.x, `${label} x`, minimum, maximum) }),
    ...(point.y === undefined ? {} : { y: finiteNumber(point.y, `${label} y`, minimum, maximum) }),
  };
}

function decodeBox(value: unknown, label: string) {
  const box = record(value, label);
  return {
    width: finiteNumber(box.width, `${label} width`, 0.01, 10),
    height: finiteNumber(box.height, `${label} height`, 0.01, 10),
  };
}

function decodeBoxPatch(value: unknown, label: string) {
  const box = record(value, label);
  return {
    ...(box.width === undefined ? {} : { width: finiteNumber(box.width, `${label} width`, 0.01, 10) }),
    ...(box.height === undefined ? {} : { height: finiteNumber(box.height, `${label} height`, 0.01, 10) }),
  };
}

function cloneStyle(style: CaptionStyle): CaptionStyle {
  return {
    ...style,
    font: { ...style.font },
    stroke: { ...style.stroke },
    shadow: { ...style.shadow },
    background: { ...style.background },
    position: { ...style.position },
    box: { ...style.box },
    animation: { ...style.animation },
  };
}

function uniqueIds<T extends { id: string }>(items: readonly T[], label: string) {
  const ids = new Set<string>();
  items.forEach((item) => {
    if (ids.has(item.id)) throw new Error(`${label} contain duplicate identifiers`);
    ids.add(item.id);
  });
  return ids;
}

function decodeStringArray(value: unknown, label: string, maximumLength: number) {
  return arrayValue(value, label, maximumLength).map((entry, index) => identifierValue(entry, `${label} item ${index + 1}`));
}

function decodeArray<T>(
  value: unknown,
  label: string,
  maximumLength: number,
  decode: (entry: unknown, index: number) => T,
): T[] {
  return arrayValue(value, label, maximumLength).map(decode);
}

function arrayValue(value: unknown, label: string, maximumLength: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} are missing or invalid`);
  if (value.length > maximumLength) throw new Error(`${label} exceed the supported project limit`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is missing or invalid`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  return value;
}

function boundedString(value: unknown, label: string, maximumLength: number) {
  const string = stringValue(value, label);
  if (string.length > maximumLength) throw new Error(`${label} exceeds the supported project limit`);
  return string;
}

function nonEmptyString(value: unknown, label: string) {
  const string = boundedString(value, label, 16_384);
  if (!string.trim()) throw new Error(`${label} is empty`);
  return string;
}

function identifierValue(value: unknown, label: string) {
  const identifier = nonEmptyString(value, label);
  if (!IDENTIFIER_PATTERN.test(identifier)) throw new Error(`${label} is invalid`);
  return identifier;
}

function localMediaUri(value: unknown, label: string) {
  const uri = nonEmptyString(value, label);
  if (!uri.startsWith('content://') && !uri.startsWith('file:///')) throw new Error(`${label} is not local media`);
  return uri;
}

function localFileUri(value: unknown, label: string) {
  const uri = nonEmptyString(value, label);
  if (!uri.startsWith('file:///')) throw new Error(`${label} is not an app-owned file`);
  return uri;
}

function optionalLocalFileUri(value: unknown, label: string) {
  return value === undefined ? undefined : localFileUri(value, label);
}

function optionalNonEmptyString(value: unknown, label: string) {
  return value === undefined ? undefined : nonEmptyString(value, label);
}

function booleanValue(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label} is invalid`);
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, label: string) {
  return value === undefined ? fallback : booleanValue(value, label);
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, label: string, minimum: number, maximum: number) {
  return value === undefined ? undefined : finiteNumber(value, label, minimum, maximum);
}

function optionalNumber(value: unknown, fallback: number, label: string, minimum: number, maximum: number) {
  return value === undefined ? fallback : finiteNumber(value, label, minimum, maximum);
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${label} is invalid`);
  return value as T[number];
}

function optionalEnum<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] | undefined {
  return value === undefined ? undefined : enumValue(value, allowed, label);
}

function animationId(value: unknown, label: string): CaptionStyle['animation']['id'] {
  if (typeof value !== 'string' || !ANIMATION_IDS.has(value as CaptionStyle['animation']['id'])) throw new Error(`${label} is invalid`);
  return value as CaptionStyle['animation']['id'];
}

function colorValue(value: unknown, label: string) {
  const color = nonEmptyString(value, label);
  if (!COLOR_PATTERN.test(color)) throw new Error(`${label} is invalid`);
  return color.toUpperCase();
}

function optionalColor(value: unknown, fallback: string, label: string) {
  return value === undefined ? fallback : colorValue(value, label);
}

function dateString(value: unknown, label: string) {
  const timestamp = nonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} is invalid`);
  return timestamp;
}

function optionalDateString(value: unknown, label: string) {
  return value === undefined ? undefined : dateString(value, label);
}
