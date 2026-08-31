import type {
  CaptionBlock,
  CaptionProject,
  CaptionStyle,
  CaptionStylePatch,
  WordToken,
} from '@/types/project';

export type StyleScope = 'caption' | 'all';

export function mergeStyle(
  base: CaptionStyle,
  patch?: CaptionStylePatch,
): CaptionStyle {
  if (!patch) return base;

  return {
    ...base,
    ...patch,
    font: { ...base.font, ...patch.font },
    stroke: { ...base.stroke, ...patch.stroke },
    shadow: { ...base.shadow, ...patch.shadow },
    background: { ...base.background, ...patch.background },
    position: { ...base.position, ...patch.position },
    box: { ...base.box, ...patch.box },
    animation: { ...base.animation, ...patch.animation },
  };
}

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
  captionId: string,
  scope: StyleScope,
  patch: CaptionStylePatch,
): CaptionProject {
  const updatedAt = new Date().toISOString();

  if (scope === 'all') {
    return {
      ...project,
      updatedAt,
      projectStyle: mergeStyle(project.projectStyle, patch),
      captions: project.captions.map((caption) => ({
        ...caption,
        styleOverride: removePatchedKeys(caption.styleOverride, patch),
      })),
      transcription: {
        ...project.transcription,
        words: project.transcription.words.map((word) => ({
          ...word,
          styleOverride: removePatchedKeys(word.styleOverride, patch),
        })),
      },
    };
  }

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

function removePatchedKeys(
  override: CaptionStylePatch | undefined,
  patch: CaptionStylePatch,
): CaptionStylePatch | undefined {
  if (!override) return undefined;
  const next = { ...override } as Record<string, unknown>;
  const patchRecord = patch as Record<string, unknown>;

  for (const [key, patchValue] of Object.entries(patchRecord)) {
    const overrideValue = next[key];
    if (isRecord(patchValue) && isRecord(overrideValue)) {
      const nested = { ...overrideValue };
      for (const nestedKey of Object.keys(patchValue)) delete nested[nestedKey];
      if (Object.keys(nested).length === 0) delete next[key];
      else next[key] = nested;
    } else {
      delete next[key];
    }
  }

  return Object.keys(next).length > 0 ? (next as CaptionStylePatch) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function mergePatch(
  base: CaptionStylePatch | undefined,
  patch: CaptionStylePatch,
): CaptionStylePatch {
  return {
    ...base,
    ...patch,
    font: { ...base?.font, ...patch.font },
    stroke: { ...base?.stroke, ...patch.stroke },
    shadow: { ...base?.shadow, ...patch.shadow },
    background: { ...base?.background, ...patch.background },
    position: { ...base?.position, ...patch.position },
    box: { ...base?.box, ...patch.box },
    animation: { ...base?.animation, ...patch.animation },
  };
}
