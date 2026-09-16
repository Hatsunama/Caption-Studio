import type { TimelineRenderPlan } from './export-render-plan';

type SourceProbe = {
  media(uri: string): Promise<{ hasVideo: boolean; hasAudio: boolean; durationMs: number }>;
  image(uri: string): Promise<{ width: number; height: number }>;
};

// Probe provider-backed URIs, not saved metadata or filesystem existence. Work
// sequentially to keep decoder/file-descriptor pressure bounded on small phones.
export async function assertExportSourcesAvailable(plan: TimelineRenderPlan, probe: SourceProbe) {
  const checked = new Set<string>();
  const sources = [
    ...plan.clips.map((clip) => ({ ...clip, kind: 'video' as const })),
    // Match buildInsertedAudioSequence: inaudible clips never open their source.
    ...plan.audioClips.filter((clip) => !clip.muted && clip.volume > 0)
      .map((clip) => ({ ...clip, kind: 'audio' as const })),
    ...plan.layers.flatMap((layer) => layer.kind === 'image' && layer.visible
      ? [{ id: layer.id, uri: layer.uri, kind: 'image' as const }] : []),
  ];
  for (const source of sources) {
    const key = `${source.kind}:${source.uri}`;
    if (checked.has(key)) continue;
    try {
      if (!source.uri.trim()) throw new Error('Missing source URI');
      if (source.kind === 'image') {
        const info = await probe.image(source.uri);
        if (!(info.width > 0 && info.height > 0)) throw new Error('Unreadable image');
      } else {
        const info = await probe.media(source.uri);
        if (!Number.isFinite(info.durationMs) || info.durationMs <= 0
          || !(source.kind === 'video' ? info.hasVideo : info.hasAudio)) {
          throw new Error('The required media track is unavailable');
        }
      }
    } catch (cause) {
      throw new Error(`Cannot export: the ${source.kind} source for "${source.id}" cannot be read. Restore access to the original file, then try again. For a video, return to Projects and reopen the project to select the original file again.`, { cause });
    }
    checked.add(key);
  }
}
