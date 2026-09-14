export type LayerGeometryInput = {
  position: { x: number; y: number };
  box: { width: number; height: number };
  rotation: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
};

export type LayerGeometry = Required<LayerGeometryInput>;
export type LayerTouch = { id: number; x: number; y: number };
export type LayerCanvas = { width: number; height: number; pageX: number; pageY: number };
export type LayerGestureMode = 'move' | 'corner' | 'left' | 'right' | 'top' | 'bottom';

export function positiveLayerScale(value: unknown = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 3.4028234663852886e38) {
    throw new Error('Layer scale must be a positive finite float');
  }
  return value;
}

export function resolveLayerGeometry(value: LayerGeometryInput): LayerGeometry {
  return {
    position: { ...value.position }, box: { ...value.box }, rotation: value.rotation,
    scale: positiveLayerScale(value.scale),
    scaleX: positiveLayerScale(value.scaleX),
    scaleY: positiveLayerScale(value.scaleY),
  };
}

export function layerExtent(value: LayerGeometryInput) {
  const geometry = resolveLayerGeometry(value);
  return {
    width: geometry.box.width * geometry.scale * geometry.scaleX,
    height: geometry.box.height * geometry.scale * geometry.scaleY,
  };
}

export function sameLayerGeometry(a: LayerGeometryInput, b: LayerGeometryInput) {
  return a.position.x === b.position.x && a.position.y === b.position.y
    && a.box.width === b.box.width && a.box.height === b.box.height && a.rotation === b.rotation
    && (a.scale ?? 1) === (b.scale ?? 1) && (a.scaleX ?? 1) === (b.scaleX ?? 1) && (a.scaleY ?? 1) === (b.scaleY ?? 1);
}

const angle = (a: LayerTouch, b: LayerTouch) => Math.atan2(b.y - a.y, b.x - a.x);
const distance = (a: LayerTouch, b: LayerTouch) => Math.hypot(b.x - a.x, b.y - a.y);
const midpoint = (a: LayerTouch, b: LayerTouch) => ({ id: -1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const degrees = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;
const ordered = (touches: readonly LayerTouch[]) => touches.slice().sort((a, b) => a.id - b.id).slice(0, 2);

export function createLayerGesture(initial: LayerGeometryInput) {
  let current = resolveLayerGeometry(initial);
  let baseline = current;
  let points: LayerTouch[] = [];
  let mode: LayerGestureMode = 'move';
  let canvas: LayerCanvas = { width: 1, height: 1, pageX: 0, pageY: 0 };
  let active = false;
  const rebase = (touches: LayerTouch[]) => { baseline = current; points = touches; };
  return {
    current: () => current,
    active: () => active,
    sync(value: LayerGeometryInput) { if (!active) current = resolveLayerGeometry(value); },
    begin(nextMode: LayerGestureMode, touches: readonly LayerTouch[], size: LayerCanvas) {
      if (active || touches.length === 0) return false;
      mode = nextMode;
      canvas = { ...size, width: Math.max(1, size.width), height: Math.max(1, size.height) };
      active = true;
      rebase(ordered(touches));
      return true;
    },
    update(touches: readonly LayerTouch[]) {
      if (!active || touches.length === 0) return current;
      const next = ordered(touches);
      // Touch membership changes rebase from the last emitted geometry, never delayed React props.
      if (next.length !== points.length || next.some((point, index) => point.id !== points[index].id)) {
        rebase(next);
        return current;
      }
      const extent = layerExtent(baseline);
      const minimumRatio = Math.max(1 / (extent.width * canvas.width), 1 / (extent.height * canvas.height));
      if (next.length === 2) {
        const origin = midpoint(points[0], points[1]);
        const target = midpoint(next[0], next[1]);
        const initialDistance = distance(points[0], points[1]);
        if (initialDistance < 1) { rebase(next); return current; }
        const ratio = Math.max(minimumRatio, distance(next[0], next[1]) / initialDistance);
        const rotation = angle(next[0], next[1]) - angle(points[0], points[1]);
        const x = canvas.pageX + baseline.position.x * canvas.width - origin.x;
        const y = canvas.pageY + baseline.position.y * canvas.height - origin.y;
        current = { ...baseline, scale: baseline.scale * ratio, rotation: degrees(baseline.rotation + rotation * 180 / Math.PI),
          position: {
            x: (target.x + ratio * (x * Math.cos(rotation) - y * Math.sin(rotation)) - canvas.pageX) / canvas.width,
            y: (target.y + ratio * (x * Math.sin(rotation) + y * Math.cos(rotation)) - canvas.pageY) / canvas.height,
          } };
      } else if (mode === 'move') {
        current = { ...baseline, position: {
          x: baseline.position.x + (next[0].x - points[0].x) / canvas.width,
          y: baseline.position.y + (next[0].y - points[0].y) / canvas.height,
        } };
      } else if (mode === 'corner') {
        const center = { id: -1, x: canvas.pageX + baseline.position.x * canvas.width, y: canvas.pageY + baseline.position.y * canvas.height };
        const ratio = Math.max(minimumRatio, distance(center, next[0]) / Math.max(1, distance(center, points[0])));
        current = { ...baseline, scale: baseline.scale * ratio };
      } else {
        const horizontal = mode === 'left' || mode === 'right';
        const side = mode === 'left' || mode === 'top' ? -1 : 1;
        const radians = baseline.rotation * Math.PI / 180;
        const axisX = horizontal ? Math.cos(radians) : -Math.sin(radians);
        const axisY = horizontal ? Math.sin(radians) : Math.cos(radians);
        const delta = (next[0].x - points[0].x) * axisX + (next[0].y - points[0].y) * axisY;
        const original = horizontal ? extent.width * canvas.width : extent.height * canvas.height;
        const dimension = Math.max(1, original + side * delta);
        const shift = side * (dimension - original) / 2;
        current = { ...baseline,
          ...(horizontal ? { scaleX: baseline.scaleX * dimension / original } : { scaleY: baseline.scaleY * dimension / original }),
          position: { x: baseline.position.x + shift * axisX / canvas.width, y: baseline.position.y + shift * axisY / canvas.height },
        };
      }
      return current;
    },
    end() { const wasActive = active; active = false; points = []; return wasActive ? current : undefined; },
  };
}

export function createGeometryFrameQueue<T>(schedule: (callback: () => void) => number, cancel: (id: number) => void, publish: (value: T) => void) {
  let frame: number | undefined;
  let latest: T | undefined;
  return {
    push(value: T) {
      latest = value;
      if (frame === undefined) frame = schedule(() => { frame = undefined; if (latest !== undefined) publish(latest); latest = undefined; });
    },
    clear() { if (frame !== undefined) cancel(frame); frame = undefined; latest = undefined; },
  };
}
