export const CAPTION_LINE_HEIGHT_MIN = 0.55;
export const CAPTION_LINE_HEIGHT_MAX = 1.12;

export function normalizeCaptionLineHeight(value: number) {
  return Math.max(CAPTION_LINE_HEIGHT_MIN, Math.min(CAPTION_LINE_HEIGHT_MAX, value));
}
