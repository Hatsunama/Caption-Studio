import { resolveCaptionLanguage } from '@/lib/caption-languages';

export function requireDetectedCaptionLanguage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Could not detect the spoken language. Try clearer audio or choose a source language before generating captions.');
  }
  const language = value.trim();
  if (!resolveCaptionLanguage(language)) {
    throw new Error(`The detected language (${language}) is unknown to Caption Studio. Choose a supported source language and try again.`);
  }
  return language;
}
