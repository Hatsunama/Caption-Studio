export type EnglishChineseCaptionLanguage = 'en' | 'zh-Hans' | 'zh-Hant';

export type CaptionLanguageTag =
  | 'en'
  | 'zh-Hans'
  | 'zh-Hant'
  | 'hi'
  | 'es'
  | 'fr'
  | 'ar'
  | 'bn'
  | 'pt'
  | 'ru'
  | 'ur'
  | 'id'
  | 'de'
  | 'ja'
  | 'ko'
  | 'tr'
  | 'vi'
  | 'th'
  | 'it'
  | 'pl';

export type CaptionGroupingProfile = 'spaced' | 'cjk' | 'hangul' | 'thai' | 'arabic';

export type CaptionLanguageDefinition = {
  tag: CaptionLanguageTag;
  displayName: string;
  family: string;
  grouping: CaptionGroupingProfile;
  automaticTranslation: boolean;
};

export const TOP_SPOKEN_CAPTION_LANGUAGES: readonly CaptionLanguageDefinition[] = [
  { tag: 'en', displayName: 'English', family: 'en', grouping: 'spaced', automaticTranslation: true },
  { tag: 'zh-Hans', displayName: 'Chinese (Simplified)', family: 'zh', grouping: 'cjk', automaticTranslation: true },
  { tag: 'zh-Hant', displayName: 'Chinese (Traditional)', family: 'zh', grouping: 'cjk', automaticTranslation: true },
  { tag: 'hi', displayName: 'Hindi', family: 'hi', grouping: 'spaced', automaticTranslation: false },
  { tag: 'es', displayName: 'Spanish', family: 'es', grouping: 'spaced', automaticTranslation: false },
  { tag: 'fr', displayName: 'French', family: 'fr', grouping: 'spaced', automaticTranslation: false },
  { tag: 'ar', displayName: 'Arabic', family: 'ar', grouping: 'arabic', automaticTranslation: false },
  { tag: 'bn', displayName: 'Bengali', family: 'bn', grouping: 'spaced', automaticTranslation: false },
  { tag: 'pt', displayName: 'Portuguese', family: 'pt', grouping: 'spaced', automaticTranslation: false },
  { tag: 'ru', displayName: 'Russian', family: 'ru', grouping: 'spaced', automaticTranslation: false },
  { tag: 'ur', displayName: 'Urdu', family: 'ur', grouping: 'arabic', automaticTranslation: false },
  { tag: 'id', displayName: 'Indonesian', family: 'id', grouping: 'spaced', automaticTranslation: false },
  { tag: 'de', displayName: 'German', family: 'de', grouping: 'spaced', automaticTranslation: false },
  { tag: 'ja', displayName: 'Japanese', family: 'ja', grouping: 'cjk', automaticTranslation: false },
  { tag: 'ko', displayName: 'Korean', family: 'ko', grouping: 'hangul', automaticTranslation: false },
  { tag: 'tr', displayName: 'Turkish', family: 'tr', grouping: 'spaced', automaticTranslation: false },
  { tag: 'vi', displayName: 'Vietnamese', family: 'vi', grouping: 'spaced', automaticTranslation: false },
  { tag: 'th', displayName: 'Thai', family: 'th', grouping: 'thai', automaticTranslation: false },
  { tag: 'it', displayName: 'Italian', family: 'it', grouping: 'spaced', automaticTranslation: false },
  { tag: 'pl', displayName: 'Polish', family: 'pl', grouping: 'spaced', automaticTranslation: false },
];

const LANGUAGE_BY_TAG = new Map(TOP_SPOKEN_CAPTION_LANGUAGES.map((language) => [language.tag, language]));

export function captionLanguageFamily(languageTag: string) {
  return resolveCaptionLanguage(languageTag)?.family ?? languageTag.trim().toLowerCase().split('-')[0] ?? '';
}

export function sameCaptionLanguageFamily(left: string, right: string) {
  return captionLanguageFamily(left) === captionLanguageFamily(right);
}

export function captionLanguageLabel(languageTag: string) {
  return resolveCaptionLanguage(languageTag)?.displayName ?? languageTag.trim();
}

export function captionGroupingProfile(languageTag: string): CaptionGroupingProfile {
  return resolveCaptionLanguage(languageTag)?.grouping ?? inferGroupingProfile(languageTag);
}

export type DualCaptionLanguageChoice = {
  tag: CaptionLanguageTag;
  displayName: string;
  automatic: boolean;
};

export function canonicalCaptionLanguageTag(languageTag: string) {
  const resolved = resolveCaptionLanguage(languageTag);
  if (resolved) return resolved.tag;
  const trimmed = languageTag.trim();
  if (!trimmed) throw new Error('Caption language is missing.');
  return trimmed;
}

export function supportsAutomaticCaptionTranslation(languageTag: string) {
  return resolveCaptionLanguage(languageTag)?.automaticTranslation === true;
}

export function canAutomaticallyTranslatePair(sourceLanguageTag: string, targetLanguageTag: string) {
  try {
    const source = normalizeEnglishChineseCaptionLanguage(sourceLanguageTag);
    const target = normalizeEnglishChineseCaptionLanguage(targetLanguageTag);
    return source !== target
      && supportsAutomaticCaptionTranslation(source)
      && supportsAutomaticCaptionTranslation(target);
  } catch {
    return false;
  }
}

export function automaticTranslationTargetTags(sourceLanguageTag: string): EnglishChineseCaptionLanguage[] {
  const source = normalizeEnglishChineseCaptionLanguage(sourceLanguageTag);
  if (source === 'en') return ['zh-Hans', 'zh-Hant'];
  return ['en'];
}

export function dualCaptionLanguageChoices(sourceLanguageTag: string): DualCaptionLanguageChoice[] {
  const sourceFamily = captionLanguageFamily(sourceLanguageTag);
  return TOP_SPOKEN_CAPTION_LANGUAGES
    .filter((language) => language.family !== sourceFamily)
    .map((language) => ({
      tag: language.tag,
      displayName: language.displayName,
      automatic: canAutomaticallyTranslatePair(sourceLanguageTag, language.tag),
    }));
}

export function resolveCaptionLanguage(languageTag: string): CaptionLanguageDefinition | undefined {
  const normalized = languageTag.trim().toLowerCase();
  if (!normalized) return undefined;
  if (LANGUAGE_BY_TAG.has(normalized as CaptionLanguageTag)) {
    return LANGUAGE_BY_TAG.get(normalized as CaptionLanguageTag);
  }
  try {
    const englishChinese = normalizeEnglishChineseCaptionLanguage(normalized);
    return LANGUAGE_BY_TAG.get(englishChinese);
  } catch {
    const family = normalized.split('-')[0] ?? '';
    return TOP_SPOKEN_CAPTION_LANGUAGES.find((language) => language.family === family);
  }
}

export function normalizeEnglishChineseCaptionLanguage(languageTag: string): EnglishChineseCaptionLanguage {
  const normalized = languageTag.trim().toLowerCase();
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (normalized === 'zh-hant' || normalized.startsWith('zh-hant-') || normalized === 'zh-tw' || normalized === 'zh-hk' || normalized === 'yue') {
    return 'zh-Hant';
  }
  if (normalized === 'zh' || normalized === 'zh-hans' || normalized.startsWith('zh-hans-') || normalized === 'zh-cn' || normalized === 'zh-sg') {
    return 'zh-Hans';
  }
  throw new Error('On-device translation currently supports English and Chinese captions.');
}

function inferGroupingProfile(languageTag: string): CaptionGroupingProfile {
  const family = languageTag.trim().toLowerCase().split('-')[0] ?? '';
  if (family === 'zh' || family === 'ja' || family === 'yue') return 'cjk';
  if (family === 'ko') return 'hangul';
  if (family === 'th' || family === 'lo' || family === 'km' || family === 'my') return 'thai';
  if (family === 'ar' || family === 'ur' || family === 'fa' || family === 'ps') return 'arabic';
  return 'spaced';
}
