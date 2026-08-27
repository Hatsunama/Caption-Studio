export class CaptionGenerationCancelledError extends Error {
  constructor() {
    super('Caption generation cancelled.');
    this.name = 'CaptionGenerationCancelledError';
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
};

export function createCaptionGenerationSession(cancelNativeExtraction: () => Promise<void>) {
  let nextToken = 1;
  let active: Attempt | undefined;

  return {
    async run<T>(work: (context: CaptionGenerationSessionContext) => Promise<T>): Promise<T> {
      if (active) throw new Error('Caption generation is already underway.');
      const attempt: Attempt = {
        token: nextToken++,
        cancelled: false,
        stoppers: new Set(),
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
        return await work(context);
      } catch (error) {
        throwIfCancelled();
        throw error;
      } finally {
        attempt.stoppers.clear();
        if (active?.token === attempt.token) active = undefined;
      }
    },

    async cancel(): Promise<boolean> {
      const attempt = active;
      if (!attempt || attempt.cancelled) return false;
      attempt.cancelled = true;
      const stoppers = [...attempt.stoppers];
      await Promise.allSettled([
        cancelNativeExtraction(),
        ...stoppers.map((stopper) => stopper()),
      ]);
      return true;
    },
  };
}
