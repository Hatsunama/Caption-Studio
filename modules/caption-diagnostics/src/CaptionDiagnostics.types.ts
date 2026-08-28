export type NativeProcessExitRecord = {
  timestampMs: number;
  reason: number;
  status: number;
  importance: number;
  pssKb: number;
  rssKb: number;
  description: string;
  versionCode: number;
};
