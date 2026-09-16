import type { ProjectVideoSource } from '@/types/project';

// Application contracts: native providers adapt their results at the service boundary.
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
