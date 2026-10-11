export type VerticalRect = { y: number; height: number };
export type MeasuredInputView = { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void };

export function inputScrollOffset(field: VerticalRect, viewport: VerticalRect, offset: number) {
  if (![field.y, field.height, viewport.y, viewport.height, offset].every(Number.isFinite)
    || field.height <= 0 || viewport.height <= 0) return offset;
  const above = field.y - viewport.y;
  const below = field.y + field.height - viewport.y - viewport.height;
  const delta = field.height > viewport.height || above < 0 ? above : Math.max(0, below);
  return Math.max(0, offset + delta);
}

export function createInputRevealController(options: {
  viewport: () => MeasuredInputView | null;
  scrollToOffset: (offset: number) => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
}) {
  let input: MeasuredInputView | null = null;
  let offset = 0;
  let revision = 0;
  let attached = true;
  let frame: number | undefined;
  const invalidate = () => {
    revision++;
    if (frame !== undefined) options.cancelFrame(frame);
    frame = undefined;
  };
  const reveal = () => {
    invalidate();
    if (!attached || !input) return;
    const owner = revision, field = input, viewport = options.viewport();
    if (!viewport) return;
    const current = () => attached && revision === owner && input === field && options.viewport() === viewport;
    frame = options.requestFrame(() => {
      frame = undefined;
      if (!current()) return;
      field.measureInWindow((_x, y, _width, height) => {
        if (!current()) return;
        viewport.measureInWindow((_vx, vy, _vw, vh) => {
          if (!current()) return;
          const next = inputScrollOffset({ y, height }, { y: vy, height: vh }, offset);
          if (Number.isFinite(next) && Math.abs(next - offset) > 0.5) {
            offset = next;
            options.scrollToOffset(next);
          }
        });
      });
    });
  };
  return {
    focus: (field: MeasuredInputView | null) => { input = field; reveal(); },
    blur: (field: MeasuredInputView | null) => { if (field === input) { input = null; invalidate(); } },
    reveal,
    recordScroll: (value: number) => { if (Number.isFinite(value)) offset = Math.max(0, value); },
    beginDrag: invalidate,
    attach: () => { invalidate(); attached = true; },
    detach: () => { attached = false; input = null; invalidate(); },
  };
}

export function createInputRevealConnection(
  frames: Pick<Parameters<typeof createInputRevealController>[0], 'requestFrame' | 'cancelFrame'>,
) {
  let viewport: MeasuredInputView | null = null;
  let scrollToOffset: ((offset: number) => void) | undefined;
  const controller = createInputRevealController({
    ...frames,
    viewport: () => scrollToOffset ? viewport : null,
    scrollToOffset: (offset) => scrollToOffset?.(offset),
  });
  return {
    ...controller,
    connectViewport: (view: MeasuredInputView | null) => {
      viewport = view;
      controller.reveal();
    },
    connectScrollToOffset: (command: ((offset: number) => void) | undefined) => {
      scrollToOffset = command;
      controller.reveal();
    },
  };
}
