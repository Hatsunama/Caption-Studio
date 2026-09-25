const GRIP_WIDTH = 24;
const EDGE_INTERACTION_INSET = 18;
const MINIMUM_MOVE_WIDTH = 8;

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

  return {
    showTrimGrips: blockWidth > 0,
    gripWidth: GRIP_WIDTH,
    interactionInset: EDGE_INTERACTION_INSET,
    minimumMoveWidth: MINIMUM_MOVE_WIDTH,
    moveLeft: 0,
    moveWidth: blockWidth,
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
  const inset = selected ? GRIP_WIDTH : 0;
  const left = Math.max(0, blockLeft - inset);
  const right = Math.min(Math.max(0, trackWidth), blockLeft + visualWidth + inset);
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
