// Existing persisted project capacities, shared with join preflight checks.
export const MAX_PROJECT_CAPTIONS = 100_000;
export const MAX_PROJECT_SNAPSHOT_LENGTH = 64 * 1024 * 1024;

export function assertProjectSnapshotSize(snapshot: string) {
  if (snapshot.length > MAX_PROJECT_SNAPSHOT_LENGTH) throw new Error('Project data exceeds the supported size limit');
}
