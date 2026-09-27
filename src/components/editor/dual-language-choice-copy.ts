export function dualLanguageChoiceCopy(
  automatic: boolean,
  displayName: string,
  sourceLanguageLabel: string,
  automaticModelLabel: string,
): { badge: string; detail: string } {
  if (!automatic) {
    return {
      badge: 'Manual entry',
      detail: `Add ${displayName} as a second subtitle track and type its text yourself.`,
    };
  }
  return {
    badge: 'On this phone',
    detail: `Uses the ${automaticModelLabel} model after a one-time download. Keep this screen open while the whole ${sourceLanguageLabel} script is translated.`,
  };
}
