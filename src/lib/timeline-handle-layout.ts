const MIN_GRIP_WIDTH = 2;
const MAX_GRIP_WIDTH = 8;
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

  const gripWidth = Math.min(MAX_GRIP_WIDTH, Math.max(MIN_GRIP_WIDTH, blockWidth * 0.08));
  return {
    showTrimGrips: blockWidth > 0,
    gripWidth,
    interactionInset: EDGE_INTERACTION_INSET,
    minimumMoveWidth: MINIMUM_MOVE_WIDTH,
    moveLeft: 0,
    moveWidth: blockWidth,
  };
}
