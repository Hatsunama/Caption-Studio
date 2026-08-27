import { readPreference, writePreference } from '@/services/preferences';

const CONSENT_KEY = 'background-processing-metrics-consent-v1';

export async function hasBackgroundProcessingConsent(): Promise<boolean> {
  return await readPreference<unknown>(CONSENT_KEY, false) === true;
}

export async function setBackgroundProcessingConsent(granted: boolean): Promise<void> {
  await writePreference(CONSENT_KEY, granted);
}

export async function requireBackgroundProcessingConsent(): Promise<void> {
  if (await hasBackgroundProcessingConsent()) return;
  throw new Error('Background removal is off until you accept its on-device AI and optional Google metrics disclosure.');
}
