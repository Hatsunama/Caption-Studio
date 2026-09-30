export class CaptionGenerationCancelledError extends Error {
  constructor() {
    super('Caption generation cancelled.');
    this.name = 'CaptionGenerationCancelledError';
  }
}

export class CaptionGenerationStopError extends Error {
  constructor(public readonly failures: unknown[]) {
    super('Caption generation could not stop cleanly. ' + failures.map((failure) => failure instanceof Error ? failure.message : String(failure)).join('; '));
    this.name = 'CaptionGenerationStopError';
  }
}

export type CaptionGenerationSessionContext = {
  isCancelled(): boolean;
  throwIfCancelled(): void;
  registerStopper(stopper: () => Promise<void>): () => void;
};

type Attempt = {
  token: number;
  cancelled: boolean;
  stoppers: Set<() => Promise<void>>;
  workExited: boolean;
  finished: Promise<void>;
  resolveFinished: () => void;
  stopSucceeded: boolean;
  stopFailures: unknown[];
  stopRequest?: Promise<CaptionGenerationCancellationResult>;
};

export type CaptionGenerationCancellationResult =
  | { status: 'idle' }
  | { status: 'stopping'; finished: Promise<void> }
  | { status: 'stop-failed'; failures: unknown[]; finished: Promise<void> };

export function createCaptionGenerationSession(cancelNativeExtraction: () => Promise<void>) {
  let nextToken = 1;
  let active: Attempt | undefined;
  const releaseIfSettled = (attempt: Attempt) => {
    if (!attempt.workExited || attempt.stopRequest) return;
    if (active?.token === attempt.token) active = undefined;
    attempt.resolveFinished();
  };

  return {
    async run<T>(work: (context: CaptionGenerationSessionContext) => Promise<T>): Promise<T> {
      if (active) throw new Error('Caption generation is already underway.');
      let resolveFinished!: () => void;
      const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
      const attempt: Attempt = {
        token: nextToken++,
        cancelled: false,
        stoppers: new Set(),
        workExited: false,
        finished,
        resolveFinished,
        stopSucceeded: false,
        stopFailures: [],
      };
      active = attempt;

      const throwIfCancelled = () => {
        if (attempt.cancelled || active?.token !== attempt.token) {
          throw new CaptionGenerationCancelledError();
        }
      };
      const context: CaptionGenerationSessionContext = {
        isCancelled: () => attempt.cancelled || active?.token !== attempt.token,
        throwIfCancelled,
        registerStopper: (stopper) => {
          throwIfCancelled();
          attempt.stoppers.add(stopper);
          return () => attempt.stoppers.delete(stopper);
        },
      };

      try {
        const result = await work(context);
        await attempt.stopRequest;
        if (attempt.stopFailures.length > 0) throw new CaptionGenerationStopError(attempt.stopFailures);
        throwIfCancelled();
        return result;
      } catch (error) {
        await attempt.stopRequest;
        if (error instanceof CaptionGenerationCancelledError && attempt.stopFailures.length > 0) {
          throw new CaptionGenerationStopError(attempt.stopFailures);
        }
        throw error;
      } finally {
        attempt.stoppers.clear();
        attempt.workExited = true;
        releaseIfSettled(attempt);
      }
    },

    async cancel(): Promise<CaptionGenerationCancellationResult> {
      const attempt = active;
      if (!attempt) return { status: 'idle' };
      if (attempt.stopRequest) return attempt.stopRequest;
      if (attempt.stopSucceeded) return { status: 'stopping', finished: attempt.finished };
      attempt.cancelled = true;
      const stoppers = [...attempt.stoppers];
      const callbacks = [cancelNativeExtraction, ...stoppers];
      const request = (async (): Promise<CaptionGenerationCancellationResult> => {
        const results = await Promise.allSettled(
          callbacks.map((callback) => Promise.resolve().then(callback)),
        );
        const failures = results.flatMap((result) => (
          result.status === 'rejected' ? [result.reason] : []
        ));
        attempt.stopSucceeded = failures.length === 0;
        attempt.stopFailures = failures;
        return failures.length > 0
          ? { status: 'stop-failed', failures, finished: attempt.finished }
          : { status: 'stopping', finished: attempt.finished };
      })();
      attempt.stopRequest = request;
      try {
        return await request;
      } finally {
        if (attempt.stopRequest === request) attempt.stopRequest = undefined;
        releaseIfSettled(attempt);
      }
    },
  };
}
