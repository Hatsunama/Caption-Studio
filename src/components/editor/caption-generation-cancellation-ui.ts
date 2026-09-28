import type { CaptionGenerationCancellationResult } from '@/services/caption-generation-session';

export async function runCaptionCancellationRequest(
  cancel: () => Promise<CaptionGenerationCancellationResult>,
  setCancelling: (value: boolean) => void,
  reportFailure: (message: string) => void,
): Promise<void> {
  setCancelling(true);
  try {
    const result = await cancel();
    if (result.status === 'idle') {
      setCancelling(false);
      return;
    }
    if (result.status === 'stop-failed') {
      const details = result.failures.map((failure) => (
        failure instanceof Error ? failure.message : String(failure)
      )).join('; ');
      reportFailure(`Caption generation could not be stopped: ${details}`);
      setCancelling(false);
      return;
    }
    void result.finished.then(
      () => setCancelling(false),
      (error) => {
        reportFailure(error instanceof Error ? error.message : 'Caption generation could not be stopped.');
        setCancelling(false);
      },
    );
  } catch (error) {
    reportFailure(error instanceof Error ? error.message : 'Caption generation could not be stopped.');
    setCancelling(false);
  }
}
