import type { CaptionProject } from '@/types/project';

export type ProjectRecordSummary =
  | { kind: 'project'; project: CaptionProject }
  | { kind: 'unreadable'; id: string; name: string; updatedAt: string; reason: string };
