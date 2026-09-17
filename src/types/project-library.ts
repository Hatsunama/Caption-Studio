export type ProjectLibraryProject = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lifecycleStatus: 'draft' | 'saved';
  sourceId?: string;
  sourceUri?: string;
  thumbnailUri?: string;
  durationMs: number;
  clipCount: number;
  captionCount: number;
};

export type ProjectRecordSummary =
  | { kind: 'project'; project: ProjectLibraryProject }
  | { kind: 'unreadable'; id: string; name: string; updatedAt: string; reason: string };
