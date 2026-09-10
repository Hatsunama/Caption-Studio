import { File, Paths } from 'expo-file-system';

import CaptionMedia from 'caption-media';
import { buildTimelineAudioRenderPlan } from '@/lib/timeline-audio-render-plan';
import { buildClipTimeline } from '@/lib/video-timeline';
import type { CaptionProject } from '@/types/project';

type TimelineAudioNativeModule = typeof CaptionMedia & {
  renderTimelineAudio: (
    outputUri: string,
    plan: ReturnType<typeof buildTimelineAudioRenderPlan>,
  ) => Promise<{ outputUri: string; sizeBytes: number; durationMs: number }>;
};

export type TimelineTranscriptionSession = {
  project: CaptionProject;
  restore: <T extends CaptionProject>(generated: T) => T;
  dispose: () => void;
};

function removeTemporaryAudio(file: File) {
  if (!file.exists) return;
  try {
    file.delete();
  } catch (caught) {
    console.warn('Caption Studio could not remove temporary timeline audio.', caught);
  }
}

export async function createTimelineTranscriptionSession(
  project: CaptionProject,
): Promise<TimelineTranscriptionSession> {
  const plan = buildTimelineAudioRenderPlan(project);
  if (plan.durationMs <= 0 || project.clips.length === 0) {
    throw new Error('Add a video clip with audible audio before generating captions.');
  }
  const output = new File(
    Paths.cache,
    `caption-timeline-${project.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.m4a`,
  );
  removeTemporaryAudio(output);
  try {
    const rendered = await (CaptionMedia as TimelineAudioNativeModule).renderTimelineAudio(output.uri, plan);
    if (!output.exists || rendered.sizeBytes <= 0) {
      throw new Error('The audible timeline could not be prepared for captioning.');
    }
  } catch (caught) {
    removeTemporaryAudio(output);
    const message = caught instanceof Error ? caught.message : '';
    if (/no audible audio|does not contain an audio track|no audio track/i.test(message)) {
      throw new Error('No audible audio is available on this timeline. Unmute a clip or add an audio track, then try again.');
    }
    throw new Error('Caption Studio could not prepare the timeline audio. Keep the editor open and make sure the source media is still available, then try again.');
  }

  const timelineEntries = buildClipTimeline(project.clips);
  const sourceId = `${project.id}-audible-timeline`;
  const syntheticProject: CaptionProject = {
    ...project,
    sources: [{
      id: sourceId,
      uri: output.uri,
      storageMode: 'copied',
      displayName: 'Audible timeline',
      durationMs: plan.durationMs,
      width: 2,
      height: 2,
      rotation: 0,
    }],
    clips: timelineEntries.map((entry) => ({
      ...entry.clip,
      sourceId,
      availableSourceStartMs: 0,
      availableSourceEndMs: plan.durationMs,
      sourceStartMs: entry.startMs,
      sourceEndMs: entry.endMs,
      playbackRate: 1,
    })),
    transcription: {
      ...project.transcription,
      sourceResults: {},
    },
  };

  return {
    project: syntheticProject,
    restore: (generated) => ({
      ...generated,
      sources: project.sources,
      clips: project.clips,
      audioSources: project.audioSources,
      audioClips: project.audioClips,
      transcription: {
        ...generated.transcription,
        sourceResults: project.transcription.sourceResults,
      },
    } as typeof generated),
    dispose: () => removeTemporaryAudio(output),
  };
}
