const GRIP_WIDTH = 24;
const MINIMUM_MOVE_WIDTH = 8;
const HANDLE_HEIGHT = 38;

export type TimelineHandleHitRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Authoritative geometry in body-relative pixels. Rectangles use half-open
 * bounds so adjacent trim/move targets never own the same point. Each boundary
 * is computed from its predecessor: independently evaluating equivalent sums
 * can create a floating-point overlap. Translate the shell origin once, then
 * lay out children consecutively (0, 24, 24 + moveHit.width), rather than
 * independently translating and reconstructing each rectangle. Track
 * padding owns outside space; these bounds must not be clamped to track edges.
 */
export function timelineHandleHitLayout(selected: boolean, width: number) {
  const bodyWidth = Math.max(0, width);
  const showTrimGrips = selected && bodyWidth > 0;
  const clearance = showTrimGrips ? Math.max(0, MINIMUM_MOVE_WIDTH - bodyWidth) / 2 : 0;
  const startLeft = showTrimGrips ? -clearance - GRIP_WIDTH : 0;
  const moveHit: TimelineHandleHitRect = {
    left: showTrimGrips ? startLeft + GRIP_WIDTH : 0,
    top: 0,
    width: showTrimGrips ? Math.max(MINIMUM_MOVE_WIDTH, bodyWidth) : bodyWidth,
    height: HANDLE_HEIGHT,
  };
  const endLeft = moveHit.left + moveHit.width;
  const startHit: TimelineHandleHitRect | null = showTrimGrips
    ? { left: startLeft, top: 0, width: GRIP_WIDTH, height: HANDLE_HEIGHT }
    : null;
  const endHit: TimelineHandleHitRect | null = showTrimGrips
    ? { left: endLeft, top: 0, width: GRIP_WIDTH, height: HANDLE_HEIGHT }
    : null;
  const envelope: TimelineHandleHitRect = {
    left: startLeft,
    top: 0,
    width: showTrimGrips ? endLeft + GRIP_WIDTH - startLeft : moveHit.width,
    height: HANDLE_HEIGHT,
  };
  return { showTrimGrips, startLeft, endLeft, startHit, moveHit, endHit, envelope };
}

export function timelineHandleLayout(selected: boolean, width: number) {
  const blockWidth = Math.max(0, width);
  if (!selected) {
    return {
      showTrimGrips: false,
      gripWidth: 0,
      interactionInset: 0,
      minimumMoveWidth: 0,
      moveLeft: 0,
      moveWidth: blockWidth,
    };
  }

  const hitLayout = timelineHandleHitLayout(true, blockWidth);
  return {
    showTrimGrips: hitLayout.showTrimGrips,
    gripWidth: GRIP_WIDTH,
    interactionInset: Math.max(0, -hitLayout.envelope.left),
    minimumMoveWidth: MINIMUM_MOVE_WIDTH,
    moveLeft: hitLayout.moveHit.left,
    moveWidth: hitLayout.moveHit.width,
  };
}

export function timelineHandleMarkerLayout(blockLeft: number, blockWidth: number, gripWidth: number) {
  return {
    startLeft: blockLeft - gripWidth,
    endLeft: blockLeft + blockWidth,
  };
}

export function timelineVideoHandleLayout(blockLeft: number, blockWidth: number, trackWidth: number, selected: boolean) {
  const visualWidth = Math.max(0, blockWidth);
  if (selected) {
    const hitLayout = timelineHandleHitLayout(true, visualWidth);
    const visualLeft = -hitLayout.envelope.left;
    const moveLeft = hitLayout.showTrimGrips ? GRIP_WIDTH : 0;
    const endGripLeft = moveLeft + hitLayout.moveHit.width;
    return {
      left: blockLeft + hitLayout.envelope.left,
      width: endGripLeft + (hitLayout.showTrimGrips ? GRIP_WIDTH : 0),
      visualLeft,
      visualWidth,
      startGripLeft: 0,
      endGripLeft,
      moveLeft,
      moveWidth: hitLayout.moveHit.width,
      height: hitLayout.envelope.height,
      hitLayout,
    };
  }
  // Preserve the legacy unselected contract, including its track clipping.
  const left = Math.max(0, blockLeft);
  const right = Math.min(Math.max(0, trackWidth), blockLeft + visualWidth);
  const width = Math.max(0, right - left);
  const visualLeft = blockLeft - left;
  const markers = timelineHandleMarkerLayout(visualLeft, visualWidth, GRIP_WIDTH);
  const maxGripLeft = Math.max(0, width - GRIP_WIDTH);
  const withinInteraction = (markerLeft: number) => Math.max(0, Math.min(maxGripLeft, markerLeft));
  return {
    left,
    width,
    visualLeft,
    visualWidth,
    startGripLeft: withinInteraction(markers.startLeft),
    endGripLeft: withinInteraction(markers.endLeft),
  };
}
