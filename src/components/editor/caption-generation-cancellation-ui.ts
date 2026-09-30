import type { CaptionGenerationCancellationResult } from '@/services/caption-generation-session';

export async function runCaptionCancellationRequest(
  cancel: () => Promise<CaptionGenerationCancellationResult>,
  setCancelling: (value: boolean) => void,
  reportFailure: (message: string) => void,
): Promise<{ interruptionError?: string } | undefined> {
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
      const interruptionError = `Caption generation could not be stopped: ${details}`;
      reportFailure(interruptionError);
      setCancelling(false);
      return { interruptionError };
    }
    await result.finished;
    setCancelling(false);
  } catch (error) {
    const interruptionError = error instanceof Error ? error.message : 'Caption generation could not be stopped.';
    reportFailure(interruptionError);
    setCancelling(false);
    return { interruptionError };
  }
}
