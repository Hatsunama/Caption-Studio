import { relinkProjectVideo } from '@/lib/project-media-relink';
import type { ProbedVideoInfo } from '@/lib/media-validation';
import type { CaptionProject, ProjectVideoSource } from '@/types/project';
import type { ProjectVideoAccessStatus, ProjectVideoDocument } from '@/types/project-media-recovery';

export type MediaRecoveryPorts = {
  check(uri: string): Promise<{ status: ProjectVideoAccessStatus }>;
  choose(source: ProjectVideoSource, status: ProjectVideoAccessStatus): Promise<ProjectVideoDocument | null>;
  probe(uri: string): Promise<ProbedVideoInfo>;
  confirm(source: ProjectVideoSource, document: ProjectVideoDocument): Promise<boolean>;
  persist(project: CaptionProject): Promise<void>;
};

/** Run before mounting playback; publish only after a successful durable write. */
export async function recoverProjectVideoAccess(project: CaptionProject, ports: MediaRecoveryPorts) {
  let recovered = project;
  const checked = new Set<string>();
  for (const original of project.sources) {
    const source = recovered.sources.find((candidate) => candidate.id === original.id)!;
    if (checked.has(source.uri)) continue;
    const { status } = await ports.check(source.uri);
    if (status === 'ready') {
      checked.add(source.uri);
      continue;
    }
    const document = await ports.choose(source, status);
    if (!document) throw new Error(`Video access is still needed for ${source.displayName}. Reopen this project and select the original video to restore preview. Your project and recovery drafts are preserved.`);
    if ((await ports.check(document.uri)).status !== 'ready') {
      throw new Error('Android could not retain readable access to the selected video. Your project is unchanged.');
    }
    const next = relinkProjectVideo(recovered, source, document, await ports.probe(document.uri));
    if (!await ports.confirm(source, document)) throw new Error('Re-link cancelled. Your project and recovery drafts are preserved.');
    recovered = next;
    checked.add(document.uri);
  }
  if (recovered !== project) await ports.persist(recovered);
  return recovered;
}
