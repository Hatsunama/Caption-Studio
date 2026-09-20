const MIN_GRIP_WIDTH = 8;
const MAX_GRIP_WIDTH = 16;

export function timelineHandleLayout(selected: boolean, width: number) {
  const blockWidth = Math.max(0, width);
  if (!selected) {
    return {
      showTrimGrips: false,
      gripWidth: 0,
      moveLeft: 0,
      moveWidth: blockWidth,
    };
  }

  const gripWidth = Math.min(MAX_GRIP_WIDTH, Math.max(MIN_GRIP_WIDTH, blockWidth * 0.1));
  const showTrimGrips = blockWidth >= gripWidth * 4;
  return {
    showTrimGrips,
    gripWidth: showTrimGrips ? gripWidth : 0,
    moveLeft: showTrimGrips ? gripWidth : 0,
    moveWidth: showTrimGrips ? blockWidth - 2 * gripWidth : blockWidth,
  };
}
