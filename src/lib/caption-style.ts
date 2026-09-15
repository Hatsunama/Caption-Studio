import type { CaptionStyle, CaptionStylePatch, FontReference } from '@/types/project';

export function mergeStyle(
  base: CaptionStyle,
  patch?: CaptionStylePatch,
): CaptionStyle {
  if (!patch) return base;

  return {
    ...base,
    ...patch,
    font: mergeFont(base.font, patch.font),
    stroke: { ...base.stroke, ...patch.stroke },
    shadow: { ...base.shadow, ...patch.shadow },
    background: { ...base.background, ...patch.background },
    position: { ...base.position, ...patch.position },
    box: { ...base.box, ...patch.box },
    animation: { ...base.animation, ...patch.animation },
  };
}

export function removePatchedKeys(
  override: CaptionStylePatch | undefined,
  patch: CaptionStylePatch,
  inheritedFont: FontReference,
): CaptionStylePatch | undefined {
  if (!override) return undefined;
  const next = { ...override } as Record<string, unknown>;
  const patchRecord = patch as Record<string, unknown>;

  for (const [key, patchValue] of Object.entries(patchRecord)) {
    const overrideValue = next[key];
    // A global font replacement must also discard identity-bound override data.
    if (key === 'font' && fontIdentityChanged(mergeFont(inheritedFont, override.font), patch.font)) {
      delete next.font;
      continue;
    }
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
  const merged: CaptionStylePatch = {
    ...base,
    ...patch,
  };
  assignNestedPatch(merged, 'font', base?.font, patch.font,
    (left, right) => mergeFont(left as Partial<FontReference>, right as Partial<FontReference>));
  assignNestedPatch(merged, 'stroke', base?.stroke, patch.stroke);
  assignNestedPatch(merged, 'shadow', base?.shadow, patch.shadow);
  assignNestedPatch(merged, 'background', base?.background, patch.background);
  assignNestedPatch(merged, 'position', base?.position, patch.position);
  assignNestedPatch(merged, 'box', base?.box, patch.box);
  assignNestedPatch(merged, 'animation', base?.animation, patch.animation);
  return merged;
}

function assignNestedPatch(
  target: CaptionStylePatch,
  key: 'font' | 'stroke' | 'shadow' | 'background' | 'position' | 'box' | 'animation',
  base: object | undefined,
  patch: object | undefined,
  merge: (base: object | undefined, patch: object | undefined) => object =
    (left = {}, right = {}) => ({ ...left, ...right }),
) {
  const record = target as Record<string, unknown>;
  if (!base && !patch) {
    delete record[key];
    return;
  }
  const value = merge(base, patch);
  if (Object.keys(value).length === 0) delete record[key];
  else record[key] = value;
}

function fontIdentityChanged(base: Partial<FontReference> | undefined, patch: Partial<FontReference> | undefined) {
  return (['id', 'family', 'source'] as const).some(
    (key) => patch?.[key] !== undefined && patch[key] !== base?.[key],
  );
}

export function mergeFont(base: FontReference, patch: Partial<FontReference> | undefined): FontReference;
export function mergeFont(base: Partial<FontReference> | undefined, patch: Partial<FontReference> | undefined): Partial<FontReference>;
export function mergeFont(base: Partial<FontReference> | undefined, patch: Partial<FontReference> | undefined) {
  const inherited = { ...base };
  if (fontIdentityChanged(base, patch)) {
    delete inherited.uri;
    delete inherited.postScriptName;
  }
  return { ...inherited, ...patch };
}
