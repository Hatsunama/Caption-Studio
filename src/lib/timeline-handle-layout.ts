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
