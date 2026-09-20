export const CAPTION_LINE_HEIGHT_MIN = 0.72;
export const CAPTION_LINE_HEIGHT_MAX = 1.12;

function clampProgress(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function normalizeCaptionLineHeight(value: number) {
  return Math.max(CAPTION_LINE_HEIGHT_MIN, Math.min(CAPTION_LINE_HEIGHT_MAX, value));
}

export function captionLineHeightAtProgress(progress: number) {
  return Number((CAPTION_LINE_HEIGHT_MIN
    + (CAPTION_LINE_HEIGHT_MAX - CAPTION_LINE_HEIGHT_MIN) * clampProgress(progress)).toFixed(2));
}

export function captionLineHeightProgress(lineHeight: number) {
  return clampProgress(
    (normalizeCaptionLineHeight(lineHeight) - CAPTION_LINE_HEIGHT_MIN)
      / (CAPTION_LINE_HEIGHT_MAX - CAPTION_LINE_HEIGHT_MIN),
  );
}
