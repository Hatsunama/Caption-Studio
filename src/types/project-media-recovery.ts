import type { ProjectVideoSource } from '@/types/project';

export type ProjectVideoDocument = {
  uri: string;
  name: string;
  size?: number | null;
};

export type ProjectVideoAccessStatus = 'ready' | 'permission-required' | 'missing' | 'unavailable';

export type ProjectMediaRecoveryPrompts = {
  requestOriginal(source: ProjectVideoSource, status: ProjectVideoAccessStatus): Promise<boolean>;
  confirmOriginal(source: ProjectVideoSource, document: ProjectVideoDocument): Promise<boolean>;
};
