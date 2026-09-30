// The editor owns timers; this boundary also invalidates writes that have
// already left a timer but have not yet entered storage's project queue.
export function createCaptionJournalQueue() {
  let epoch = 0;
  let enabled = false;
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T,>(operation: () => Promise<T>) => {
    const task = tail.then(operation);
    tail = task.catch(() => undefined);
    return task;
  };
  const pause = () => { enabled = false; epoch += 1; };
  return {
    pause,
    resume: () => { enabled = true; },
    write(operation: () => Promise<void>) {
      const expected = epoch;
      return enqueue(async () => {
        if (enabled && expected === epoch) await operation();
      });
    },
    clear(operation: () => Promise<void>, stillCurrent: () => boolean = () => true) {
      pause();
      return enqueue(async () => {
        if (!stillCurrent()) return false;
        await operation();
        return true;
      });
    },
  };
}

export const CAPTION_CLEANUP_WARNING = 'Your changes were saved. Recovery copy cleanup failed. Retry cleanup to remove the old recovery copy; your project does not need to be saved again.';
