import type { TimelineRenderPlan } from './export-render-plan';

type SourceProbe = {
  media(uri: string): Promise<{ hasVideo: boolean; hasAudio: boolean; durationMs: number }>;
  image(uri: string): Promise<{ width: number; height: number }>;
};

// Export-only validation: old drafts remain loadable and editable, and no saved
// trim or duration is silently clamped when the backing media has changed.
export function assertExportSourceRange(
  startMs: number,
  endMs: number,
  durationMs: number,
  label: string,
) {
  if (!Number.isFinite(durationMs) || durationMs <= 0
    || !Number.isFinite(startMs) || !Number.isFinite(endMs)
    || startMs < 0 || endMs <= startMs || endMs > durationMs) {
    throw new Error(`Cannot export: ${label} has a trim outside its source duration. Adjust the clip trim or restore the original source, then try again.`);
  }
}

// Probe provider-backed URIs, not saved metadata or filesystem existence. Work
// sequentially to keep decoder/file-descriptor pressure bounded on small phones.
export async function assertExportSourcesAvailable(plan: TimelineRenderPlan, probe: SourceProbe) {
  const checkedImages = new Set<string>();
  const mediaInfoByUri = new Map<string, Awaited<ReturnType<SourceProbe['media']>>>();
  const sources = [
    ...plan.clips.map((clip) => ({ ...clip, kind: 'video' as const })),
    // Match buildInsertedAudioSequence: inaudible clips never open their source.
    ...plan.audioClips.filter((clip) => !clip.muted && clip.volume > 0)
      .map((clip) => ({ ...clip, kind: 'audio' as const })),
    ...plan.layers.flatMap((layer) => layer.kind === 'image' && layer.visible
      ? [{ id: layer.id, uri: layer.uri, kind: 'image' as const }] : []),
  ];
  for (const source of sources) {
    let mediaInfo: Awaited<ReturnType<SourceProbe['media']>> | undefined;
    try {
      if (!source.uri.trim()) throw new Error('Missing source URI');
      if (source.kind === 'image') {
        if (checkedImages.has(source.uri)) continue;
        const info = await probe.image(source.uri);
        if (!(info.width > 0 && info.height > 0)) throw new Error('Unreadable image');
        checkedImages.add(source.uri);
      } else {
        const info = mediaInfoByUri.get(source.uri) ?? await probe.media(source.uri);
        if (!Number.isFinite(info.durationMs) || info.durationMs <= 0
          || !(source.kind === 'video' ? info.hasVideo : info.hasAudio)) {
          throw new Error('The required media track is unavailable');
        }
        mediaInfoByUri.set(source.uri, info);
        mediaInfo = info;
      }
    } catch (cause) {
      throw new Error(`Cannot export: the ${source.kind} source for "${source.id}" cannot be read. Restore access to the original file, then try again. For a video, return to Projects and reopen the project to select the original file again.`, { cause });
    }
    // Cache the probe, never the range check: clips sharing a URI can use
    // different trims, and every consumed range must fit the fresh duration.
    if (
      source.kind !== 'image'
      && mediaInfo
      && Number.isFinite(source.sourceStartMs)
      && Number.isFinite(source.sourceEndMs)
    ) {
      assertExportSourceRange(source.sourceStartMs, source.sourceEndMs, mediaInfo.durationMs,
        `the ${source.kind} clip "${source.id}"`);
    }
  }
}
