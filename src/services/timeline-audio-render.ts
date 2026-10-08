import { File, Paths } from 'expo-file-system';

import CaptionMedia from 'caption-media';
import { buildTimelineAudioRenderPlan } from '@/lib/timeline-audio-render-plan';
import { buildClipTimeline } from '@/lib/video-timeline';
import { restoreTimelineTranscription } from '@/lib/timeline-transcription';
import type { CaptionGenerationSessionContext } from '@/services/caption-generation-session';
import type { CaptionProject } from '@/types/project';

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
  session?: CaptionGenerationSessionContext,
): Promise<TimelineTranscriptionSession> {
  session?.throwIfCancelled();
  const plan = buildTimelineAudioRenderPlan(project);
  if (plan.durationMs <= 0 || project.clips.length === 0) {
    throw new Error('Add a video clip with audible audio before generating captions.');
  }
  const output = new File(
    Paths.cache,
    `caption-timeline-${project.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.m4a`,
  );
  removeTemporaryAudio(output);
  let handedOff = false;
  try {
    // The session's native stopper requests cancellation; only render settlement
    // permits cleanup. Do not race this promise against a cancellation signal.
    const rendered = await CaptionMedia.renderTimelineAudio(output.uri, plan).catch((caught: unknown) => {
      // A cancellation request must not hide a genuine native preparation error.
      // Translate only the renderer's explicit cancellation code for this owner.
      if (session?.isCancelled() && caught && typeof caught === 'object'
        && 'code' in caught && caught.code === 'E_TIMELINE_AUDIO_CANCELLED') {
        session.throwIfCancelled();
      }
      const message = caught instanceof Error ? caught.message : '';
      if (/no audible audio|does not contain an audio track|no audio track/i.test(message)) {
        throw new Error('No audible audio is available on this timeline. Unmute a clip or add an audio track, then try again.', { cause: caught });
      }
      throw new Error('Caption Studio could not prepare the timeline audio. Keep the editor open and make sure the source media is still available, then try again.', { cause: caught });
    });
    session?.throwIfCancelled();
    if (!output.exists || rendered.sizeBytes <= 0) {
      throw new Error('The audible timeline could not be prepared for captioning.');
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

    handedOff = true;
    return {
      project: syntheticProject,
      restore: (generated) => restoreTimelineTranscription(project, generated),
      dispose: () => removeTemporaryAudio(output),
    };
  } finally {
    // Until a session is returned, this function owns every failure's output,
    // including cancellation, invalid output, and synthetic timeline setup.
    if (!handedOff) removeTemporaryAudio(output);
  }
}
