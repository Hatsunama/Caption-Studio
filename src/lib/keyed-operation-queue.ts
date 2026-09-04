export function createKeyedOperationQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    tails.set(key, result);
    void result.finally(() => { if (tails.get(key) === result) tails.delete(key); }).catch(() => undefined);
    return result;
  };
}
