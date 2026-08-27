export type EnglishChineseCaptionLanguage = 'en' | 'zh-Hans' | 'zh-Hant';

export function normalizeEnglishChineseCaptionLanguage(languageTag: string): EnglishChineseCaptionLanguage {
  const normalized = languageTag.trim().toLowerCase();
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (normalized === 'zh-hant' || normalized.startsWith('zh-hant-') || normalized === 'zh-tw' || normalized === 'zh-hk') {
    return 'zh-Hant';
  }
  if (normalized === 'zh' || normalized === 'zh-hans' || normalized.startsWith('zh-hans-') || normalized === 'zh-cn' || normalized === 'zh-sg') {
    return 'zh-Hans';
  }
  throw new Error('Natural local translation currently supports English and Chinese captions.');
}

export function captionLanguageFamily(languageTag: string) {
  return languageTag.trim().toLowerCase().split('-')[0];
}
