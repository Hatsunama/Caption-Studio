export type ViewportFrame = { x: number; y: number; width: number; height: number };
export type KeyboardFrame = { screenX: number; screenY: number; width: number; height: number };

export function keyboardViewportBottomGap(frame: ViewportFrame | undefined, keyboard: KeyboardFrame | undefined): number | undefined {
  if (!frame || !keyboard) return undefined;
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  const keyboardRight = keyboard.screenX + keyboard.width;
  const keyboardBottom = keyboard.screenY + keyboard.height;
  if (![frame.x, frame.y, frame.width, frame.height, keyboard.screenX, keyboard.screenY,
    keyboard.width, keyboard.height, right, bottom, keyboardRight, keyboardBottom].every(Number.isFinite)) return undefined;
  if (frame.width <= 0 || frame.height <= 0 || keyboard.width <= 0 || keyboard.height <= 0) return undefined;
  if (keyboard.screenX >= right || keyboardRight <= frame.x
    || keyboard.screenY > bottom || keyboardBottom < frame.y) return undefined;
  return Math.max(0, bottom - keyboardBottom);
}

export function keyboardViewportCoversBottom(frame: ViewportFrame | undefined, keyboard: KeyboardFrame | undefined, bottomInset = 0): boolean {
  if (!Number.isFinite(bottomInset) || bottomInset < 0) return false;
  const gap = keyboardViewportBottomGap(frame, keyboard);
  return gap !== undefined && gap <= bottomInset;
}

export function keyboardViewportOverlap(frame: ViewportFrame | undefined, keyboard: KeyboardFrame | undefined): number {
  if (!frame || !keyboard) return 0;
  if (![frame.x, frame.y, frame.width, frame.height, keyboard.screenX, keyboard.screenY,
    keyboard.width, keyboard.height].every(Number.isFinite)) return 0;
  if (frame.width <= 0 || frame.height <= 0 || keyboard.width <= 0 || keyboard.height <= 0) return 0;
  if (keyboard.screenX >= frame.x + frame.width || keyboard.screenX + keyboard.width <= frame.x
    || keyboard.screenY >= frame.y + frame.height || keyboard.screenY + keyboard.height <= frame.y) return 0;
  return Math.min(frame.height, Math.max(0, frame.y + frame.height - keyboard.screenY));
}
