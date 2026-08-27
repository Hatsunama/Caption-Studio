export class VideoExportCancelledError extends Error {
  constructor() {
    super('Video export cancelled.');
    this.name = 'VideoExportCancelledError';
  }
}

export type VideoExportSessionContext = {
  waitFor<T>(operation: Promise<T>): Promise<T>;
  throwIfCancelled(): void;
  startNative<T>(start: () => Promise<T>): Promise<T>;
};

type Attempt = {
  token: number;
  cancelled: boolean;
  nativeStarted: boolean;
  signalCancellation: () => void;
};

export function createVideoExportSession(cancelNative: () => Promise<void>) {
  let nextToken = 1;
  let active: Attempt | undefined;

  return {
    async run<T>(work: (context: VideoExportSessionContext) => Promise<T>): Promise<T> {
      if (active) throw new Error('A video export is already underway.');
      const cancellationListeners = new Set<(error: VideoExportCancelledError) => void>();
      const signalCancellation = () => {
        const error = new VideoExportCancelledError();
        cancellationListeners.forEach((reject) => reject(error));
        cancellationListeners.clear();
      };
      const attempt: Attempt = {
        token: nextToken++,
        cancelled: false,
        nativeStarted: false,
        signalCancellation,
      };
      active = attempt;

      const throwIfCancelled = () => {
        if (attempt.cancelled || active?.token !== attempt.token) throw new VideoExportCancelledError();
      };
      const context: VideoExportSessionContext = {
        waitFor: async <TValue>(operation: Promise<TValue>) => {
          throwIfCancelled();
          let rejectCancellation = (_error: VideoExportCancelledError) => {};
          const cancellation = new Promise<never>((_resolve, reject) => {
            rejectCancellation = reject;
            cancellationListeners.add(reject);
          });
          try {
            const value = await Promise.race([operation, cancellation]);
            throwIfCancelled();
            return value;
          } finally {
            cancellationListeners.delete(rejectCancellation);
          }
        },
        throwIfCancelled,
        startNative: async <TValue>(start: () => Promise<TValue>) => {
          throwIfCancelled();
          attempt.nativeStarted = true;
          try {
            const value = await start();
            throwIfCancelled();
            return value;
          } catch (error) {
            throwIfCancelled();
            throw error;
          }
        },
      };

      try {
        return await work(context);
      } finally {
        if (active?.token === attempt.token) active = undefined;
      }
    },

    async cancel(): Promise<boolean> {
      const attempt = active;
      if (!attempt || attempt.cancelled) return false;
      attempt.cancelled = true;
      attempt.signalCancellation();
      if (attempt.nativeStarted) await cancelNative();
      return true;
    },
  };
}
