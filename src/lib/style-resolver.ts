import { mergeStyle, mergePatch, mergeFont, removePatchedKeys } from '@/lib/caption-style';
import { migrateLegacyTranslationTransforms } from '@/lib/caption-tracks';
import { captionTransform, hasCaptionTransform, withoutCaptionTransform } from '@/lib/caption-transform';
import type {
  CaptionBlock,
  CaptionProject,
  CaptionStyle,
  CaptionStylePatch,
  FontReference,
  WordToken,
} from '@/types/project';

export type StyleScope = 'caption' | 'all';
export { mergeStyle, mergePatch, removePatchedKeys } from '@/lib/caption-style';

export function resolveCaptionStyle(
  projectStyle: CaptionStyle,
  caption?: CaptionBlock,
  word?: WordToken,
): CaptionStyle {
  return mergeStyle(
    mergeStyle(projectStyle, caption?.styleOverride),
    word?.styleOverride,
  );
}

export function applyStylePatch(
  project: CaptionProject,
  captionId: string | undefined,
  scope: StyleScope,
  patch: CaptionStylePatch,
): CaptionProject {
  const updatedAt = new Date().toISOString();

  if (scope === 'caption' && !project.captions.some((caption) => caption.id === captionId)) return project;
  if (hasCaptionTransform(patch)) {
    const selected = project.captions.find((caption) => caption.id === captionId)
      ?? [...project.captions].sort((a, b) => Number(b.timelineVisible !== false) - Number(a.timelineVisible !== false)
        || a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    const geometry = captionTransform(mergeStyle(resolveCaptionStyle(project.projectStyle, selected), patch));
    project = migrateLegacyTranslationTransforms(project, captionId);
    project = {
      ...project,
      updatedAt,
      projectStyle: mergeStyle(project.projectStyle, geometry),
      captions: project.captions.map((caption) => ({ ...caption, styleOverride: withoutCaptionTransform(caption.styleOverride) })),
      transcription: { ...project.transcription, words: project.transcription.words.map((word) => ({
        ...word, styleOverride: withoutCaptionTransform(word.styleOverride),
      })) },
    };
    patch = withoutCaptionTransform(patch) ?? {};
    if (!Object.keys(patch).length) return project;
  }

  if (scope === 'all') {
    const captionFontsByWord = new Map<string, FontReference>();
    if (patch.font) {
      for (const caption of project.captions) {
        const font = mergeFont(project.projectStyle.font, caption.styleOverride?.font);
        for (const wordId of caption.wordIds) captionFontsByWord.set(wordId, font);
      }
    }
    return {
      ...project,
      updatedAt,
      projectStyle: mergeStyle(project.projectStyle, patch),
      captions: project.captions.map((caption) => ({
        ...caption,
        styleOverride: removePatchedKeys(caption.styleOverride, patch, project.projectStyle.font),
      })),
      transcription: {
        ...project.transcription,
        words: project.transcription.words.map((word) => ({
          ...word,
          styleOverride: removePatchedKeys(
            word.styleOverride, patch, captionFontsByWord.get(word.id) ?? project.projectStyle.font,
          ),
        })),
      },
    };
  }

  if (!captionId) return project;

  return {
    ...project,
    updatedAt,
    captions: project.captions.map((caption) =>
      caption.id === captionId
        ? {
            ...caption,
            styleOverride: mergePatch(caption.styleOverride, patch),
          }
        : caption,
    ),
  };
}
