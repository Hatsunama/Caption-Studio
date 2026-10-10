export type ViewportFrame = { x: number; y: number; width: number; height: number };
export type KeyboardFrame = { screenX: number; screenY: number; width: number; height: number };

// Both rectangles use measureInWindow / keyboard event screen coordinates.
// A resized native viewport can end exactly where a docked keyboard begins.
export function keyboardViewportCoversBottom(frame: ViewportFrame | undefined, keyboard: KeyboardFrame | undefined): boolean {
  if (!frame || !keyboard) return false;
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  const keyboardRight = keyboard.screenX + keyboard.width;
  const keyboardBottom = keyboard.screenY + keyboard.height;
  if (![frame.x, frame.y, frame.width, frame.height, keyboard.screenX, keyboard.screenY,
    keyboard.width, keyboard.height, right, bottom, keyboardRight, keyboardBottom].every(Number.isFinite)) return false;
  if (frame.width <= 0 || frame.height <= 0 || keyboard.width <= 0 || keyboard.height <= 0) return false;
  return keyboard.screenX < right && keyboardRight > frame.x
    && keyboard.screenY <= bottom && keyboardBottom >= bottom;
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
