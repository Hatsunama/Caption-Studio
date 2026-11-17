/** Project schema colors are #RRGGBB[AA]. */
function validateProjectColor(color: string, label: string): void {
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(color)
    || color.length !== 7 && color.length !== 9) {
    throw new Error(`Invalid ${label} color. Expected #RRGGBB or #RRGGBBAA.`);
  }
}

/** Preserve style alpha when crossing Android's #AARRGGBB bridge boundary. */
export function toAndroidArgbColor(color: string): string {
  validateProjectColor(color, 'style');
  return (color.length === 9 ? '#' + color.slice(7, 9) + color.slice(1, 7) : color).toUpperCase();
}

/** Resolve source-over black once.
 * https://www.w3.org/TR/compositing-1/#simplealphacompositing
 * Native render plans receive opaque RGB, avoiding Android's ARGB ordering.
 */
export function resolveCanvasColor(color: string): string {
  validateProjectColor(color, 'canvas');
  const alpha = color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1;
  return '#' + [1, 3, 5].map(offset => Math.round(parseInt(color.slice(offset, offset + 2), 16) * alpha)
    .toString(16).padStart(2, '0')).join('').toUpperCase();
}
