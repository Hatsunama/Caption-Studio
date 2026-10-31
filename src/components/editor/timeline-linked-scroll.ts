export type TimelineScrollColumn = 'items' | 'labels';
type Geometry = { viewport?: number; content?: number; target?: number };
type Column = Geometry & { position: number; expected: Set<number>; latest?: number; serial: number; beginTime?: number };

// RN 0.86 Android emits these fields, but its NativeScrollEvent/LayoutChangeEvent
// declarations omit them. Keep this runtime adapter at the UI boundary.
export function timelineScrollMetadata(event: object) {
  const value = event as { target?: unknown; timestamp?: unknown };
  return {
    target: typeof value.target === 'number' && Number.isFinite(value.target) ? value.target : undefined,
    timestamp: typeof value.timestamp === 'number' && Number.isFinite(value.timestamp) ? value.timestamp : undefined,
  };
}

/** Native onScroll is also emitted by scrollTo, and may coalesce intermediate
 * events. A mirror acknowledgement must never become a new scroll command.
 * Keep expected destination offsets until the latest command is acknowledged.
 * A new physical drag takes over that column; no timers infer completion. */
export function createTimelineLinkedScroll(options: {
  scroll: (column: TimelineScrollColumn, y: number) => boolean;
  offset: (y: number) => void;
  round?: (y: number) => number;
}) {
  const columns: Record<TimelineScrollColumn, Column> = {
    items: { position: 0, expected: new Set(), serial: 0 },
    labels: { position: 0, expected: new Set(), serial: 0 },
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.0001;
  const round = options.round ?? ((y: number) => y);
  const normalize = (y: number, column: Column) => round(Math.max(0,
    column.viewport !== undefined && column.content !== undefined
      ? Math.min(y, Math.max(0, column.content - column.viewport)) : y));
  let current = 0;
  let driver: TimelineScrollColumn | undefined;
  let reveal: number | undefined;
  const publish = (y: number) => { current = y; options.offset(y); };

  function send(side: TimelineScrollColumn, y: number, force = false) {
    const column = columns[side], target = normalize(y, column);
    if (column.expected.size && column.latest !== undefined && near(target, column.latest)) return;
    if (!column.expected.size && near(column.position, target)) {
      // Explicit reveals must still stop native momentum at the current offset.
      if (force) options.scroll(side, target);
      return;
    }
    const hadTarget = column.expected.has(target), previous = column.latest, serial = ++column.serial;
    column.expected.add(target); column.latest = target;
    const rollback = () => {
      if (column.serial !== serial) return;
      if (!hadTarget) column.expected.delete(target);
      column.latest = previous;
    };
    try { if (!options.scroll(side, target)) rollback(); }
    catch (error) { rollback(); throw error; }
  }

  function measure(side: TimelineScrollColumn, geometry: Geometry) {
    const column = columns[side];
    const viewport = Number.isFinite(geometry.viewport) && geometry.viewport! >= 0 ? geometry.viewport : column.viewport;
    const content = Number.isFinite(geometry.content) && geometry.content! >= 0 ? geometry.content : column.content;
    if (viewport === column.viewport && content === column.content) return;
    column.viewport = viewport; column.content = content;
    // An in-flight command may be clamped by a new native viewport. Keep both
    // its old value and the clamped value until the latest native ACK arrives.
    for (const value of Array.from(column.expected)) column.expected.add(normalize(value, column));
    if (column.latest !== undefined) column.latest = normalize(column.latest, column);
  }

  function sync(y: number, source: TimelineScrollColumn | 'reveal', geometry?: Geometry & { timestamp?: number }) {
    if (!Number.isFinite(y)) return;
    y = round(Math.max(0, y));
    if (source === 'reveal') {
      driver = undefined; reveal = y;
      const target = Math.min(normalize(y, columns.items), normalize(y, columns.labels));
      publish(target); send('items', target, true); send('labels', target, true);
      return;
    }
    const column = columns[source];
    if (geometry?.target !== undefined && column.target !== undefined && geometry.target !== column.target) return;
    if (geometry) measure(source, geometry);
    if (geometry?.timestamp !== undefined && column.beginTime !== undefined && geometry.timestamp < column.beginTime) return;
    column.position = y;
    if (Array.from(column.expected).some(value => near(value, y))) {
      if (column.latest !== undefined && near(column.latest, y)) {
        column.expected.clear(); column.latest = undefined;
      } else column.expected.delete(y);
      return;
    }
    if (driver && driver !== source) { send(source, current); return; }
    reveal = undefined;
    if (near(y, current)) return;
    publish(y); send(source === 'items' ? 'labels' : 'items', y);
  }

  function begin(source: TimelineScrollColumn, y: number, timestamp?: number, target?: number) {
    const column = columns[source];
    if (target !== undefined && column.target !== undefined && target !== column.target) return;
    driver = source; reveal = undefined;
    column.expected.clear(); column.latest = undefined; column.beginTime = timestamp;
    sync(y, source, { timestamp });
  }

  function layout(source: TimelineScrollColumn, geometry: Geometry) {
    const column = columns[source];
    if (geometry.target !== undefined) {
      if (column.target !== undefined && column.target !== geometry.target) {
        column.expected.clear(); column.latest = undefined; column.position = 0; column.beginTime = undefined;
        if (driver === source) driver = undefined;
      }
      column.target = geometry.target;
    }
    measure(source, geometry);
    if (reveal === undefined) { if (driver !== source) send(source, current); return; }
    // Finish an explicit reveal once native sizes become available; ordinary
    // user scrolling revokes this request and cannot be pulled back by reflow.
    const target = Math.min(normalize(reveal, columns.items), normalize(reveal, columns.labels));
    if (!near(target, current)) publish(target);
    // A replaced host begins at zero even when the logical reveal is unchanged.
    send('items', target); send('labels', target);
  }

  return { sync, begin, layout, end: (source?: TimelineScrollColumn, target?: number) => {
    if (source && target !== undefined && columns[source].target !== undefined && target !== columns[source].target) return;
    if (!source || driver === source) driver = undefined;
  } };
}
