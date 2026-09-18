import { createLayerGesture, resolveLayerGeometry, sameLayerGeometry, type LayerGeometry, type LayerGeometryInput, type LayerTouch } from '@/lib/layer-geometry';
import { previewCanvasPoint, previewInteractionAtPoint, previewObjectAtPoint, type PreviewObjectTarget, type PreviewOrigin, type PreviewSize } from '@/lib/preview-object-hit-test';

export type PreviewSceneTarget<T> = PreviewObjectTarget<T> & {
  deletable?: boolean;
  /** Cues keep separate hit identities but share their track's transform. */
  transformKey?: string;
};

export type PreviewSceneOptions<T> = {
  targets: readonly PreviewSceneTarget<T>[];
  selectedKey?: string;
  enabled: boolean;
  contextKey?: string;
  onSelect: (selection: T) => void;
  onClearSelection: () => void;
  /** A single commit on release. Moves are drafts, never project mutations. */
  onChange: (target: PreviewSceneTarget<T>, geometry: LayerGeometry) => void;
  onDelete: (target: PreviewSceneTarget<T>) => void;
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
};

type Owner<T> = {
  target: PreviewSceneTarget<T>;
  contextKey?: string;
  geometry: LayerGeometry;
  gesture?: ReturnType<typeof createLayerGesture>;
  pointers: Set<number>;
  origin: PreviewOrigin;
  size: PreviewSize;
  deleteArmed: boolean;
  first: LayerTouch;
  drained: boolean;
  lastPoints: LayerTouch[];
  activationPoints: LayerTouch[];
  moved: boolean;
};

/** Native-event-independent state machine. A contact sequence can own one target. */
export function createPreviewSceneController<T>(notify: () => void = () => undefined) {
  let options: PreviewSceneOptions<T>;
  let size: PreviewSize = { width: 0, height: 0 };
  let owner: Owner<T> | undefined;
  let sequence = false;
  let selectedKey: string | undefined;
  let externalSelectedKey: string | undefined;

  const finish = (commit: boolean) => {
    const ending = owner;
    owner = undefined;
    sequence = false;
    if (!ending) return;
    ending.gesture?.end();
    try {
      if (commit && ending.deleteArmed) options.onDelete(ending.target);
      else if (commit && ending.gesture && !sameLayerGeometry(ending.target.geometry, ending.geometry)) {
        options.onChange(ending.target, resolveLayerGeometry(ending.geometry));
      }
    } finally {
      if (ending.gesture) options.onInteractionEnd();
      selectedKey = externalSelectedKey;
      notify();
    }
  };
  const valid = () => {
    if (!owner) return false;
    const target = options.targets.find((candidate) => candidate.key === owner!.target.key);
    if (!options.enabled || owner.contextKey !== options.contextKey || !target
      || target.transformKey !== owner.target.transformKey
      || !sameLayerGeometry(target.geometry, owner.target.geometry)) {
      finish(false);
      return false;
    }
    return true;
  };
  const local = (point: LayerTouch, origin: PreviewOrigin): LayerTouch => ({
    id: point.id, ...previewCanvasPoint(point.x, point.y, origin),
  });
  const pointsFor = (touches: readonly LayerTouch[], current: Owner<T>) => touches
    .filter((touch) => current.pointers.has(touch.id)).map((touch) => local(touch, current.origin));
  const update = (touches: readonly LayerTouch[]) => {
    if (!valid() || !owner) return;
    const current = owner;
    if (!current.gesture) {
      const first = touches.find((touch) => touch.id === current.first.id);
      if (touches.length > 1 || (first && Math.hypot(first.x - current.first.x, first.y - current.first.y) > 12)) {
        current.deleteArmed = false;
      }
      if (first) {
        const hit = previewInteractionAtPoint([current.target], current.target.key, local(first, current.origin), current.size, true);
        if (hit?.mode !== 'delete') current.deleteArmed = false;
      }
      return;
    }
    const points = pointsFor(touches, current);
    if (!points.length) { current.drained = true; return; }
    if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) { finish(false); return; }
    if (points.length === current.lastPoints.length && points.every((point) => current.lastPoints.some((last) =>
      point.id === last.id && point.x === last.x && point.y === last.y))) return;
    if (!current.moved) {
      current.moved = points.some((point) => {
        const initial = current.activationPoints.find((candidate) => candidate.id === point.id);
        return initial && Math.hypot(point.x - initial.x, point.y - initial.y) >= 3;
      });
      if (!current.moved) return;
    }
    current.lastPoints = points;
    const next = current.gesture.update(points);
    if (!sameLayerGeometry(current.geometry, next)) {
      current.geometry = next;
      notify();
    }
  };

  return {
    configure(next: PreviewSceneOptions<T>) {
      const previous = selectedKey;
      externalSelectedKey = next.selectedKey;
      if (!owner) selectedKey = externalSelectedKey;
      options = next;
      valid();
      if (selectedKey !== previous) notify();
    },
    layout(next: PreviewSize) {
      if (next.width !== size.width || next.height !== size.height) finish(false);
      size = { ...next };
    },
    grant(touches: readonly LayerTouch[], origin: PreviewOrigin) {
      finish(false);
      if (!options.enabled || !touches.length || !(size.width > 0) || !(size.height > 0)
        || ![origin.pageX, origin.pageY, ...touches.flatMap((p) => [p.x, p.y])].every(Number.isFinite)) return;
      sequence = true;
      const first = touches[0];
      const selected = options.targets.find((target) => target.key === selectedKey);
      const interaction = previewInteractionAtPoint(options.targets, selectedKey, local(first, origin), size, Boolean(selected?.deletable));
      if (!interaction) {
        selectedKey = undefined;
        options.onClearSelection();
        notify();
        return;
      }
      const source = interaction.target as PreviewSceneTarget<T>;
      const target = { ...source, geometry: resolveLayerGeometry(source.geometry) };
      const gesture = interaction.mode === 'delete' ? undefined : createLayerGesture(target.geometry);
      if (gesture && !gesture.begin(interaction.mode === 'delete' ? 'move' : interaction.mode,
        [local(first, origin)], { ...size, pageX: 0, pageY: 0, located: true })) return;
      owner = { target, gesture, geometry: resolveLayerGeometry(target.geometry), pointers: new Set([first.id]),
        contextKey: options.contextKey, origin: { ...origin }, size: { ...size },
        first: { ...first }, deleteArmed: interaction.mode === 'delete', drained: false,
        lastPoints: [local(first, origin)], activationPoints: [local(first, origin)], moved: false };
      selectedKey = target.key;
      // Install ownership before selection can synchronously re-render the editor.
      options.onSelect(target.selection);
      if (gesture) options.onInteractionStart();
      notify();
      this.start(touches);
    },
    start(touches: readonly LayerTouch[]) {
      if (!valid() || !owner || owner.drained) return;
      const current = owner;
      if (!current.gesture) { update(touches); return; }
      // Account for movement before changing pointer membership, then rebase.
      update(touches);
      const targets = options.targets.map((target) => target.key === current.target.key
        ? { ...target, geometry: current.geometry } : target);
      for (const touch of touches) {
        if (current.pointers.size >= 2) break;
        if (current.pointers.has(touch.id)) continue;
        const hit = previewObjectAtPoint(targets, local(touch, current.origin), current.size);
        // Empty space can provide the second pinch finger; another object cannot.
        if (!hit || hit.key === current.target.key) current.pointers.add(touch.id);
      }
      current.gesture.update(pointsFor(touches, current));
      current.lastPoints = pointsFor(touches, current);
      if (!current.moved) current.activationPoints = current.lastPoints;
    },
    move(touches: readonly LayerTouch[]) { update(touches); },
    end(touches: readonly LayerTouch[], changed: readonly LayerTouch[] = []) {
      if (!valid() || !owner) return;
      const live = new Set(touches.map((touch) => touch.id));
      // End events exclude lifted fingers. Preserve their final movement.
      update([...touches, ...changed.filter((touch) => !live.has(touch.id))]);
      if (!owner) return;
      for (const id of owner.pointers) if (!live.has(id)) owner.pointers.delete(id);
      if (!owner.pointers.size) owner.drained = true;
      else {
        owner.gesture?.update(pointsFor(touches, owner));
        owner.lastPoints = pointsFor(touches, owner);
        if (!owner.moved) owner.activationPoints = owner.lastPoints;
      }
    },
    release() { if (valid()) finish(true); else sequence = false; },
    cancel() { finish(false); },
    /** Moving/resizing the coordinate frame invalidates an in-flight baseline. */
    locate(origin: PreviewOrigin) {
      if (owner && (Math.abs(origin.pageX - owner.origin.pageX) > 1 || Math.abs(origin.pageY - owner.origin.pageY) > 1)) finish(false);
    },
    get active() { return sequence; },
    get selectedKey() { return owner?.target.key ?? selectedKey; },
    geometryFor(key: string, geometry: LayerGeometryInput) {
      const target = options?.targets.find((candidate) => candidate.key === key);
      return owner?.gesture && (owner.target.key === key
        || (owner.target.transformKey && owner.target.transformKey === target?.transformKey)) ? owner.geometry : geometry;
    },
  };
}
