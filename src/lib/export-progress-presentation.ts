export type ExportProgressInput = {
  stage: 'idle' | 'preparing' | 'rendering' | 'publishing';
  percent: number | null;
};

export function exportProgressPresentation(progress: ExportProgressInput) {
  if (progress.stage === 'publishing') {
    return { kind: 'determinate' as const, percent: 99, label: 'Saving to media library · 99%' };
  }
  if (progress.stage === 'idle' || progress.stage === 'preparing') {
    return { kind: 'indeterminate' as const, label: 'Preparing export' };
  }
  if (progress.percent === null || !Number.isFinite(progress.percent)) {
    return { kind: 'indeterminate' as const, label: 'Rendering video' };
  }
  const percent = Math.max(0, Math.min(99, Math.round(progress.percent)));
  return { kind: 'determinate' as const, percent, label: `Rendering video · ${percent}%` };
}
