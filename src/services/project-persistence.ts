import { publishAfterDurableWrite } from '@/lib/persistence-boundaries';
import { saveProject } from '@/services/database';
import type { CaptionProject } from '@/types/project';

export type ProjectWriter = (project: CaptionProject) => Promise<void>;

export class ProjectPersistenceError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('Project changes were not saved. Check available storage and try again.');
    this.name = 'ProjectPersistenceError';
    this.cause = cause;
  }
}

export async function persistProjectCheckpoint(
  project: CaptionProject,
  writeProject: ProjectWriter = saveProject,
) {
  try {
    await writeProject(project);
    return project;
  } catch (cause) {
    throw new ProjectPersistenceError(cause);
  }
}

export async function publishProjectAfterDurableSave(
  project: CaptionProject,
  publish: (persisted: CaptionProject) => void,
  writeProject: ProjectWriter = saveProject,
) {
  return publishAfterDurableWrite(
    project,
    (candidate) => persistProjectCheckpoint(candidate, writeProject).then(() => undefined),
    publish,
  );
}
