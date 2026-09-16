export type VideoSourceFailure = {
  sourceId: string;
  uri: string;
  displayName: string;
  message: string;
  detail: string;
};

export function videoSourceFailure(
  source: { id: string; uri: string; displayName: string },
  caught: unknown,
): VideoSourceFailure {
  const detail = caught instanceof Error ? caught.message
    : typeof caught === 'object' && caught && 'message' in caught ? String(caught.message)
      : String(caught ?? 'Unknown player error');
  const access = /SecurityException|permission|denied|not found|ENOENT|unreadable|cannot open|could not open/i.test(detail);
  return {
    sourceId: source.id, uri: source.uri, displayName: source.displayName, detail,
    message: access
      ? 'Caption Studio cannot read this video. Its file access may have expired, or the file may have moved. Try again after restoring access. If it still fails, return to Projects and reopen this project to select the original video again.'
      : 'This video could not be played. Try loading it again. If it still fails, check that the original video opens on this phone, then return to Projects and reopen this project.',
  };
}

export function canReuseVideoSource(
  loaded: { id: string; uri: string } | undefined,
  source: { id: string; uri: string },
  status: string,
) {
  return loaded?.id === source.id && loaded.uri === source.uri && status === 'readyToPlay';
}

type SourcePlayer = {
  status: string;
  replaceAsync(uri: string): Promise<void>;
  addListener(event: 'statusChange', listener: (event: { status: string; error?: { message?: string } }) => void): { remove(): void };
};

// replaceAsync completing only confirms source replacement, not decoder readiness.
// Subscribe first so a fast native failure cannot disappear between the two.
export function loadPlayableVideoSource(player: SourcePlayer, uri: string, timeoutMs = 15_000) {
  return new Promise<void>((resolve, reject) => {
    let replaced = false;
    let settled = false;
    let subscription: { remove(): void } | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.remove();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('The video did not become ready. Check the original file and try again.')), timeoutMs);
    try {
      subscription = player.addListener('statusChange', ({ status, error }) => {
        if (status === 'error') finish(new Error(error?.message ?? 'The video could not be loaded.'));
        else if (replaced && status === 'readyToPlay') finish();
      });
      Promise.resolve(player.replaceAsync(uri)).then(() => {
        replaced = true;
        if (player.status === 'error') finish(new Error('The video could not be loaded.'));
        else if (player.status === 'readyToPlay') finish();
      }, (error) => finish(error instanceof Error ? error : new Error(String(error))));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
