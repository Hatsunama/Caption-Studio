/** Accept invariant tokens, never an arbitrary echoed source sentence. */
export function isInvariantTranslation(source: string, translated: string, target: string): boolean {
  if (!translated) return false;
  const acknowledgement = (value: string) => value.toLowerCase().replace(/[\s\p{P}]/gu, '');
  if (['ok', 'okay'].includes(acknowledgement(source))) {
    const result = acknowledgement(translated);
    if (result === 'ok') return true;
    if (result === 'okay' && /^(en|es|fr|pt|id|de|tr|vi|it|pl)(-|$)/.test(target)) return true;
  }
  if (source !== translated) return false;
  return !/\p{L}/u.test(source) || /^https?:\/\/[^\s]+$/u.test(source);
}

/** Code-point count matching the native translator boundary. */
export function translationCodePointCount(value: string): number {
  return Array.from(value.normalize('NFC')).length;
}

/**
 * Language-agnostic per-cue correspondence: reject multi-cue bleed / runaway expansion
 * relative to that cue's source. Script checks remain separate review flags.
 */
export function isPlausibleCueTranslation(sourceText: string, translatedText: string): boolean {
  const source = sourceText.normalize('NFC').trim();
  const translated = translatedText.normalize('NFC').trim();
  if (!translated) return false;
  const sourcePoints = translationCodePointCount(source);
  const translatedPoints = translationCodePointCount(translated);
  const maximum = Math.max(sourcePoints * 4, sourcePoints + 60, 48);
  return translatedPoints <= maximum;
}

export type TranslationBoundaryItem = { id: string; text: string; valid?: boolean };

export type TranslationBoundaryResult = {
  translations: Map<string, string>;
  rejected: Set<string>;
};

/**
 * Authoritative translation boundary for native and JS:
 * exact requested-ID set, one result per cue, no duplicates, no source fallback, no partial map.
 * Schema violations throw. Per-cue bleed / empty / invalid stay rejected empty strings.
 */
export function acceptTranslationBoundary(
  expected: readonly TranslationBoundaryItem[],
  actual: readonly TranslationBoundaryItem[],
): TranslationBoundaryResult {
  if (actual.length !== expected.length) {
    throw new Error('The local model returned an incomplete translation. No captions were changed.');
  }
  const expectedIds = new Set(expected.map((item) => item.id));
  if (expectedIds.size !== expected.length) {
    throw new Error('A subtitle was included more than once.');
  }
  const sourceById = new Map(expected.map((item) => [item.id, item.text]));
  const seen = new Set<string>();
  const translations = new Map<string, string>();
  const rejected = new Set<string>();
  for (const item of actual) {
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || !expectedIds.has(id) || seen.has(id)) {
      throw new Error('The local model returned an incomplete translation. No captions were changed.');
    }
    seen.add(id);
    const text = typeof item.text === 'string' ? item.text.normalize('NFC').trim() : '';
    const source = sourceById.get(id) ?? '';
    if (
      item.valid === false
      || !text
      || !isPlausibleCueTranslation(source, text)
    ) {
      translations.set(id, '');
      rejected.add(id);
      continue;
    }
    translations.set(id, text);
  }
  if (seen.size !== expectedIds.size) {
    throw new Error('The local model returned an incomplete translation. No captions were changed.');
  }
  return { translations, rejected };
}

/** UTF-8 / token estimate matching NaturalCaptionTranslator.estimateTokens. */
export function estimateTranslationTokens(value: string): number {
  let asciiCharacters = 0;
  let nonAsciiTokens = 0;
  for (const character of value.normalize('NFC')) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) asciiCharacters += 1;
    else nonAsciiTokens += codePoint > 0xffff ? 2 : 1;
  }
  return Math.floor((asciiCharacters + 2) / 3) + nonAsciiTokens;
}

/** Native prompt/runtime batch budget (see NaturalCaptionTranslator.MAX_ESTIMATED_REQUEST_TOKENS). */
export const TRANSLATION_BATCH_TOKEN_BUDGET = 3_600;
export const TRANSLATION_BATCH_CONTEXT_TOKEN_RESERVE = 200;
export const TRANSLATION_BATCH_STRUCTURAL_TOKEN_BASE = 384;

