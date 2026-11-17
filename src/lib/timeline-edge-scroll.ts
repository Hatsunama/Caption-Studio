type Viewport = { left: number; width: number };
const EDGE_BAND_PX = 56;
const MAX_SCROLL_PX_PER_SECOND = 720;
const MAX_FRAME_MS = 64;
type Options = {
  offset: () => number;
  maximum: () => number;
  ready: () => boolean;
  measure: (receive: (left: number, width: number) => void) => boolean;
  scroll: (x: number) => void;
  pin: (owner: string | undefined) => void;
};

/** A command is only a request. Only the timeline's native onScroll receipt
 * changes content displacement; a rejected or clamped command cannot move a draft. */
export function createTimelineEdgeScroll(options: Options) {
  type Drag = {
    origin: number; dx: number; dy: number; pageX?: number; viewport?: Viewport;
    apply: (dx: number, dy: number) => void;
    baselinePending?: number;
    measuring?: boolean;
    retriedBaseline?: boolean;
  };
  let active: Drag | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastTick = 0;
  const stop = () => {
    active = undefined;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    options.pin(undefined);
  };
  const apply = (drag: Drag) => {
    if (active !== drag) return;
    const scrollDelta = drag.baselinePending === undefined ? options.offset() - drag.origin : 0;
    try { drag.apply(drag.dx + scrollDelta, drag.dy); }
    catch (error) { stop(); throw error; }
  };
  return {
    begin(owner: string | undefined, onMove: Drag['apply']) {
      stop();
      const drag: Drag = { origin: options.offset(), dx: 0, dy: 0, apply: onMove };
      active = drag;
      options.pin(owner);
      const measure = () => {
        if (drag.measuring || active !== drag) return;
        drag.measuring = true;
        const requested = options.measure((left, width) => {
          drag.measuring = false;
          if (active === drag && Number.isFinite(left) && Number.isFinite(width) && width > 0) drag.viewport = { left, width };
        });
        if (!requested) drag.measuring = false;
      };
      measure();
      lastTick = Date.now();
      timer = setInterval(() => {
        const time = Date.now();
        const seconds = Math.max(0, Math.min(MAX_FRAME_MS, time - lastTick)) / 1000;
        lastTick = time;
        if (active !== drag || !options.ready()) return;
        if (drag.baselinePending !== undefined) {
          // A dropped entry reveal can retry after the spring binding/layout is
          // ready. Never substitute a requested target for the displayed offset.
          const target = drag.baselinePending;
          // Android can reach the entry target yet lose its scroll event. An
          // identical command then has no changed offset to acknowledge. A
          // one-point, bounded alternate request obtains a real native receipt;
          // displayed offset and the drag origin still change only in onScroll.
          const maximum = options.maximum();
          const alternate = target < maximum ? Math.min(maximum, target + 1) : Math.max(0, target - 1);
          options.scroll(drag.retriedBaseline ? alternate : target);
          drag.retriedBaseline = !drag.retriedBaseline;
          return;
        }
        if (!drag.viewport) { measure(); return; }
        if (drag.pageX === undefined) return;
        const { left, width } = drag.viewport;
        const band = Math.min(EDGE_BAND_PX, width / 2);
        const x = drag.pageX - left;
        const penetration = x < band ? -Math.min(1, (band - x) / band)
          : x > width - band ? Math.min(1, (x - width + band) / band) : 0;
        const velocity = Math.sign(penetration) * penetration * penetration * MAX_SCROLL_PX_PER_SECOND;
        const offset = options.offset();
        const next = Math.max(0, Math.min(options.maximum(), offset + velocity * seconds));
        if (next !== offset) options.scroll(next);
      }, 16);
      return {
        move(dx: number, dy: number, pageX?: number) {
          if (active !== drag || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
          drag.dx = dx; drag.dy = dy;
          drag.pageX = Number.isFinite(pageX) ? pageX : undefined;
          apply(drag);
        },
        stop() { if (active === drag) stop(); },
      };
    },
    acknowledge() {
      if (!active) return;
      if (active.baselinePending !== undefined) {
        if (Math.abs(options.offset() - active.baselinePending) > 1) return;
        active.origin = options.offset();
        active.baselinePending = undefined;
      }
      apply(active);
    },
    /** Entering the compact filmstrip changes coordinate space once. Its reveal
     * receipt establishes the scroll origin, rather than becoming drag motion. */
    rebaseOnReceipt(x: number) { if (active) active.baselinePending = x; },
    ownsDrag: () => active !== undefined,
    stop,
  };
}

export type TimelineEdgeScroll = ReturnType<typeof createTimelineEdgeScroll>;
