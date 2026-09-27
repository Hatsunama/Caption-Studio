export function needsTranslationModelDownloadConsent(
  models: readonly { status: 'ready' | 'incomplete' }[],
): boolean {
  return !models.some((model) => model.status === 'ready');
}
