export type TimelineAudioPlayer = {
  muted: boolean;
  volume: number;
  seekTo(seconds: number): Promise<void>;
  play(): void;
  pause(): void;
  remove(): void;
};

export type TimelineAudioPlaybackTarget = {
  clipId: string;
  sourceId: string;
  uri: string;
  targetSeconds: number;
  volume: number;
  muted: boolean;
  playing: boolean;
};

export type TimelineAudioPlaybackPhase = 'create' | 'seek' | 'prepare' | 'play';

export class TimelineAudioPlaybackError extends Error {
  readonly phase: TimelineAudioPlaybackPhase;
  readonly cause: unknown;

  constructor(phase: TimelineAudioPlaybackPhase, cause: unknown) {
    super(`Timeline audio preview failed during ${phase}.`);
    this.name = 'TimelineAudioPlaybackError';
    this.phase = phase;
    this.cause = cause;
  }
}

export function timelineAudioErrorMessage(error: unknown): string {
  if (!(error instanceof TimelineAudioPlaybackError)) {
    return 'Timeline audio preview could not continue playback.';
  }
  switch (error.phase) {
    case 'create':
      return 'Timeline audio preview could not load this audio source.';
    case 'seek':
      return 'Timeline audio preview could not seek this audio source.';
    case 'prepare':
      return 'Timeline audio preview could not configure playback.';
    case 'play':
      return 'Timeline audio preview could not play this audio source.';
  }
}

export type TimelineAudioPlaybackDependencies = {
  createPlayer: (uri: string) => TimelineAudioPlayer;
  preparePlayback?: () => Promise<void>;
  onError?: (error: unknown) => void;
  now?: () => number;
};

type ManagedAudioPlayer = {
  player: TimelineAudioPlayer;
  sourceId: string;
  uri: string;
  desired?: TimelineAudioPlaybackTarget & { requiresSeek: boolean };
  runner?: Promise<void>;
  disposed: boolean;
  positioned: boolean;
  playing: boolean;
  lastMuted?: boolean;
  lastVolume?: number;
  lastObservedAtMs?: number;
  lastObservedSeconds?: number;
  lastObservedPlaying?: boolean;
};

export class TimelineAudioPlaybackController {
  private readonly players = new Map<string, ManagedAudioPlayer>();
  private readonly pendingRunners = new Set<Promise<void>>();
  private readonly createPlayer: (uri: string) => TimelineAudioPlayer;
  private readonly preparePlayback: () => Promise<void>;
  private readonly onError: (error: unknown) => void;
  private readonly now: () => number;
  private disposed = false;

  constructor(dependencies: TimelineAudioPlaybackDependencies) {
    this.createPlayer = dependencies.createPlayer;
    this.preparePlayback = dependencies.preparePlayback ?? (() => Promise.resolve());
    this.onError = dependencies.onError ?? (() => {});
    this.now = dependencies.now ?? Date.now;
  }

  synchronize(targets: readonly TimelineAudioPlaybackTarget[]) {
    if (this.disposed) return;
    const targetById = new Map<string, TimelineAudioPlaybackTarget>();
    for (const target of targets) {
      assertTarget(target);
      if (targetById.has(target.clipId)) throw new Error(`Audio clip ${target.clipId} appears more than once.`);
      targetById.set(target.clipId, target);
    }

    for (const [clipId, managed] of this.players) {
      if (targetById.has(clipId)) continue;
      this.disposeManaged(clipId, managed);
    }

    for (const target of targets) {
      let managed = this.players.get(target.clipId);
      if (managed && (managed.sourceId !== target.sourceId || managed.uri !== target.uri)) {
        this.disposeManaged(target.clipId, managed);
        managed = undefined;
      }
      if (!managed) {
        try {
          managed = {
            player: this.createPlayer(target.uri),
            sourceId: target.sourceId,
            uri: target.uri,
            disposed: false,
            positioned: false,
            playing: false,
          };
          this.players.set(target.clipId, managed);
        } catch (error) {
          this.onError(new TimelineAudioPlaybackError('create', error));
          continue;
        }
      }
      const observedAtMs = this.now();
      const requiresSeek = managed.desired?.requiresSeek === true
        || requiresTimelineSeek(managed, target, observedAtMs);
      managed.lastObservedAtMs = observedAtMs;
      managed.lastObservedSeconds = target.targetSeconds;
      managed.lastObservedPlaying = target.playing;
      managed.desired = { ...target, requiresSeek };
      this.startRunner(managed);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const [clipId, managed] of this.players) this.disposeManaged(clipId, managed);
  }

  async whenIdle() {
    while (this.pendingRunners.size > 0) {
      await Promise.allSettled([...this.pendingRunners]);
    }
  }

  private startRunner(managed: ManagedAudioPlayer) {
    if (managed.runner || managed.disposed || this.disposed) return;
    const runner = this.drain(managed).catch((error) => {
      if (managed.disposed || this.disposed) return;
      managed.positioned = false;
      managed.playing = false;
      safeCall(() => managed.player.pause());
      this.onError(error);
    }).finally(() => {
      managed.runner = undefined;
      this.pendingRunners.delete(runner);
      if (managed.desired && !managed.disposed && !this.disposed) this.startRunner(managed);
    });
    managed.runner = runner;
    this.pendingRunners.add(runner);
  }

  private async drain(managed: ManagedAudioPlayer) {
    while (managed.desired && !managed.disposed && !this.disposed) {
      const target = managed.desired;
      managed.desired = undefined;
      if (managed.lastMuted !== target.muted) {
        managed.player.muted = target.muted;
        managed.lastMuted = target.muted;
      }
      if (managed.lastVolume === undefined || Math.abs(managed.lastVolume - target.volume) >= 0.015) {
        managed.player.volume = target.volume;
        managed.lastVolume = target.volume;
      }

      const playbackStateChanged = managed.playing !== target.playing;
      if (!target.playing && managed.playing) {
        managed.player.pause();
        managed.playing = false;
      }
      const needsSeek = !managed.positioned
        || playbackStateChanged
        || target.requiresSeek;
      if (needsSeek) {
        try {
          await managed.player.seekTo(target.targetSeconds);
        } catch (error) {
          throw new TimelineAudioPlaybackError('seek', error);
        }
        if (managed.disposed || this.disposed) return;
        managed.positioned = true;
        const latestDesired = managed.desired as ManagedAudioPlayer['desired'];
        if (latestDesired) {
          managed.desired = { ...latestDesired, requiresSeek: true };
          continue;
        }
      }

      if (target.playing && !managed.playing) {
        try {
          await this.preparePlayback();
        } catch (error) {
          throw new TimelineAudioPlaybackError('prepare', error);
        }
        if (managed.disposed || this.disposed) return;
        const latestDesired = managed.desired as ManagedAudioPlayer['desired'];
        if (latestDesired) {
          managed.desired = { ...latestDesired, requiresSeek: true };
          continue;
        }
        try {
          managed.player.play();
        } catch (error) {
          throw new TimelineAudioPlaybackError('play', error);
        }
        managed.playing = true;
      }
    }
  }

  private disposeManaged(clipId: string, managed: ManagedAudioPlayer) {
    if (this.players.get(clipId) === managed) this.players.delete(clipId);
    if (managed.disposed) return;
    managed.disposed = true;
    managed.desired = undefined;
    managed.playing = false;
    safeCall(() => managed.player.pause());
    safeCall(() => managed.player.remove());
  }
}

function requiresTimelineSeek(
  managed: ManagedAudioPlayer,
  target: TimelineAudioPlaybackTarget,
  observedAtMs: number,
) {
  if (
    managed.lastObservedAtMs === undefined
    || managed.lastObservedSeconds === undefined
    || managed.lastObservedPlaying === undefined
    || managed.lastObservedPlaying !== target.playing
  ) {
    return true;
  }
  const timelineDelta = target.targetSeconds - managed.lastObservedSeconds;
  if (!target.playing) return Math.abs(timelineDelta) > 0.005;
  if (timelineDelta < -0.02) return true;
  const elapsed = Math.max(0, observedAtMs - managed.lastObservedAtMs) / 1_000;
  return Math.abs(timelineDelta - elapsed) > 0.35;
}

function assertTarget(target: TimelineAudioPlaybackTarget) {
  if (!target.clipId || !target.sourceId || !target.uri) throw new Error('An audio playback target is incomplete.');
  if (!Number.isFinite(target.targetSeconds) || target.targetSeconds < 0) throw new Error('An audio playback position is invalid.');
  if (!Number.isFinite(target.volume) || target.volume < 0 || target.volume > 1) throw new Error('An audio playback volume is invalid.');
}

function safeCall(operation: () => void) {
  try {
    operation();
  } catch {
    return;
  }
}
