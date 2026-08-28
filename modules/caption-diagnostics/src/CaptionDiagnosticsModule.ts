import { NativeModule, requireNativeModule } from 'expo';

import type { NativeProcessExitRecord } from './CaptionDiagnostics.types';

declare class CaptionDiagnosticsModule extends NativeModule<Record<never, never>> {
  getHistoricalExitReasons(limit: number): Promise<NativeProcessExitRecord[]>;
}

export default requireNativeModule<CaptionDiagnosticsModule>('CaptionDiagnostics');
