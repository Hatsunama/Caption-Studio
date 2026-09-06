import { isInvariantTranslation } from '@/lib/translation-invariants';

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
  { tag: 'hi', displayName: 'Hindi', family: 'hi', grouping: 'spaced', automaticTranslation: true },
  { tag: 'es', displayName: 'Spanish', family: 'es', grouping: 'spaced', automaticTranslation: true },
  { tag: 'fr', displayName: 'French', family: 'fr', grouping: 'spaced', automaticTranslation: true },
  { tag: 'ar', displayName: 'Arabic', family: 'ar', grouping: 'arabic', automaticTranslation: true },
  { tag: 'bn', displayName: 'Bengali', family: 'bn', grouping: 'spaced', automaticTranslation: true },
  { tag: 'pt', displayName: 'Portuguese', family: 'pt', grouping: 'spaced', automaticTranslation: true },
  { tag: 'ru', displayName: 'Russian', family: 'ru', grouping: 'spaced', automaticTranslation: true },
  { tag: 'ur', displayName: 'Urdu', family: 'ur', grouping: 'arabic', automaticTranslation: true },
  { tag: 'id', displayName: 'Indonesian', family: 'id', grouping: 'spaced', automaticTranslation: true },
  { tag: 'de', displayName: 'German', family: 'de', grouping: 'spaced', automaticTranslation: true },
  { tag: 'ja', displayName: 'Japanese', family: 'ja', grouping: 'cjk', automaticTranslation: true },
  { tag: 'ko', displayName: 'Korean', family: 'ko', grouping: 'hangul', automaticTranslation: true },
  { tag: 'tr', displayName: 'Turkish', family: 'tr', grouping: 'spaced', automaticTranslation: true },
  { tag: 'vi', displayName: 'Vietnamese', family: 'vi', grouping: 'spaced', automaticTranslation: true },
  { tag: 'th', displayName: 'Thai', family: 'th', grouping: 'thai', automaticTranslation: true },
  { tag: 'it', displayName: 'Italian', family: 'it', grouping: 'spaced', automaticTranslation: true },
  { tag: 'pl', displayName: 'Polish', family: 'pl', grouping: 'spaced', automaticTranslation: true },
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
  const source = resolveCaptionLanguage(sourceLanguageTag);
  const target = resolveCaptionLanguage(targetLanguageTag);
  return Boolean(source && target && source.family !== target.family
    && source.automaticTranslation && target.automaticTranslation);
}

export function automaticTranslationTargetTags(sourceLanguageTag: string): CaptionLanguageTag[] {
  const source = resolveCaptionLanguage(sourceLanguageTag);
  if (!source) throw new Error('Caption Studio cannot translate an unknown source language.');
  return TOP_SPOKEN_CAPTION_LANGUAGES
    .filter((language) => language.automaticTranslation && language.family !== source.family)
    .map((language) => language.tag);
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

export function isLikelyUntranslatedCaption(sourceText: string, translatedText: string, targetLanguage: string) {
  const source = sourceText.normalize('NFC').trim();
  const translated = translatedText.normalize('NFC').trim();
  if (isInvariantTranslation(source, translated, targetLanguage)) return false;
  if (!translated || source === translated) return true;
  const multilingualTarget = resolveCaptionLanguage(targetLanguage)?.tag;
  if (multilingualTarget && multilingualTarget !== 'en' && multilingualTarget !== 'zh-Hans' && multilingualTarget !== 'zh-Hant') {
    if (multilingualTarget === 'ja') return !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(translated);
    if (multilingualTarget === 'ko') return !/\p{Script=Hangul}/u.test(translated);
    if (multilingualTarget === 'th') return !/\p{Script=Thai}/u.test(translated);
    if (multilingualTarget === 'ar' || multilingualTarget === 'ur') return !/\p{Script=Arabic}/u.test(translated);
    if (multilingualTarget === 'hi') return !/\p{Script=Devanagari}/u.test(translated);
    if (multilingualTarget === 'bn') return !/\p{Script=Bengali}/u.test(translated);
    if (multilingualTarget === 'ru') return !/\p{Script=Cyrillic}/u.test(translated);
    return !/\p{Script=Latin}/u.test(translated);
  }
  try {
    const target = normalizeEnglishChineseCaptionLanguage(targetLanguage);
    if (target === 'en') return containsChineseCaptionText(translated);
    if (!containsChineseCaptionText(translated)) {
      const latinCount = (translated.match(/[A-Za-z]/g) ?? []).length;
      return latinCount >= 3 || /^[A-Za-z0-9\s.,!?'\":;()\-–—’”“‘“”'"]+$/.test(translated);
    }
    return false;
  } catch {
    return false;
  }
}

function containsChineseCaptionText(value: string) {
  return /\p{Script=Han}/u.test(value);
}

function inferGroupingProfile(languageTag: string): CaptionGroupingProfile {
  const family = languageTag.trim().toLowerCase().split('-')[0] ?? '';
  if (family === 'zh' || family === 'ja' || family === 'yue') return 'cjk';
  if (family === 'ko') return 'hangul';
  if (family === 'th' || family === 'lo' || family === 'km' || family === 'my') return 'thai';
  if (family === 'ar' || family === 'ur' || family === 'fa' || family === 'ps') return 'arabic';
  return 'spaced';
}
