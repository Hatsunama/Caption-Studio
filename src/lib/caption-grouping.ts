import { captionGroupingProfile, type CaptionGroupingProfile } from '@/lib/caption-languages';
import {
  captionCjkCharacterCount,
  captionLayoutText,
  captionTextLength,
} from '@/lib/caption-text-breaks';
import type { CaptionBlock, WordToken } from '@/types/project';
import { normalizeProjectedPrimaryWords, sequenceGeneratedPrimaryCaptions } from '@/lib/primary-caption-timing';

export type CaptionGroupingOptions = {
  maxWords: number;
  maxCharacters: number;
  maxCjkCharacters: number;
  maxDurationMs: number;
  pauseBreakMs: number;
};

export function groupingOptionsForLanguage(languageTag?: string): CaptionGroupingOptions {
  return groupingOptionsForProfile(captionGroupingProfile(languageTag ?? 'en'));
}

export function groupingOptionsForProfile(profile: CaptionGroupingProfile): CaptionGroupingOptions {
  if (profile === 'cjk') {
    return { maxWords: 99, maxCharacters: 42, maxCjkCharacters: 16, maxDurationMs: 3_200, pauseBreakMs: 500 };
  }
  if (profile === 'hangul') {
    return { maxWords: 8, maxCharacters: 32, maxCjkCharacters: 18, maxDurationMs: 3_200, pauseBreakMs: 550 };
  }
  if (profile === 'thai') {
    return { maxWords: 99, maxCharacters: 36, maxCjkCharacters: 22, maxDurationMs: 3_200, pauseBreakMs: 500 };
  }
  if (profile === 'arabic') {
    return { maxWords: 6, maxCharacters: 38, maxCjkCharacters: 16, maxDurationMs: 3_400, pauseBreakMs: 650 };
  }
  return { maxWords: 7, maxCharacters: 34, maxCjkCharacters: 16, maxDurationMs: 3_200, pauseBreakMs: 650 };
}

export const DEFAULT_GROUPING_OPTIONS: CaptionGroupingOptions = groupingOptionsForProfile('spaced');

const HARD_BREAK = /[.!?\u3002\uFF01\uFF1F\u2026\u061F][\]"')\u2019\u201D\u300D\u300F\u3011]*$/u;
const UNSPACED_NON_HANGUL = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

function isUnspacedNonHangulToken(text: string) {
  return UNSPACED_NON_HANGUL.test(text);
}

function normalizeCaptionTimings(
  captions: CaptionBlock[], words: WordToken[], options: CaptionGroupingOptions,
): CaptionBlock[] {
  const wordById = new Map(words.map((word) => [word.id, word]));
  const fitsTextBudget = (caption: CaptionBlock) => {
    const cueWords = caption.wordIds.map((id) => wordById.get(id));
    if (cueWords.some((word) => !word)) return false;
    return cueWords.filter((word) => !isUnspacedNonHangulToken(word!.text)).length <= options.maxWords
      && captionTextLength(caption.text) <= options.maxCharacters
      && captionCjkCharacterCount(caption.text) <= options.maxCjkCharacters;
  };
  return sequenceGeneratedPrimaryCaptions(captions, options.maxDurationMs, fitsTextBudget);
}

export function groupWordsIntoCaptions(
  words: WordToken[],
  options: CaptionGroupingOptions = DEFAULT_GROUPING_OPTIONS,
): CaptionBlock[] {
  const groups: WordToken[][] = [];
  let current: WordToken[] = [];

  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };

  for (const word of words) {
    const candidate = [...current, word];
    const candidateText = joinWords(candidate);
    const duration = candidate.at(-1)!.endMs - candidate[0]!.startMs;
    const previous = current.at(-1);
    const pause = previous ? word.startMs - previous.endMs : 0;
    const lexicalWordCount = candidate.filter((item) => !isUnspacedNonHangulToken(item.text)).length;

    const mustBreakBefore =
      current.length > 0 &&
      (lexicalWordCount > options.maxWords ||
        captionTextLength(candidateText) > options.maxCharacters ||
        captionCjkCharacterCount(candidateText) > options.maxCjkCharacters ||
        duration > options.maxDurationMs ||
        pause >= options.pauseBreakMs);

    if (mustBreakBefore) flush();
    current.push(word);

    if (HARD_BREAK.test(word.text)) flush();
  }

  flush();

  return normalizeCaptionTimings(groups.map((group, index) => ({
    id: `caption-${index + 1}`,
    text: joinWords(group),
    startMs: group.reduce((start, word) => Math.min(start, word.startMs), Infinity),
    endMs: group.reduce((end, word) => Math.max(end, word.endMs), -Infinity),
    wordIds: group.map((word) => word.id),
    textMode: 'automatic',
    timelineVisible: true,
  })), words, options);
}

export function groupTimelineWordsByClip(
  words: WordToken[],
  clipIds: string[],
  options: CaptionGroupingOptions | ((clipId: string) => CaptionGroupingOptions) = DEFAULT_GROUPING_OPTIONS,
) {
  let previousClipEndMs = -Infinity;
  const captions = clipIds.flatMap((clipId) => {
    const clipWords = words.filter((word) => word.id.startsWith(`${clipId}-`));
    if (clipWords.length === 0) return [];
    const normalizedWords = normalizeProjectedPrimaryWords(
      clipWords,
      clipId,
      Math.max(previousClipEndMs, clipWords[0].startMs),
      Math.max(...clipWords.map((word) => word.endMs)),
    );
    previousClipEndMs = normalizedWords.at(-1)!.endMs;
    return groupWordsIntoCaptions(normalizedWords, typeof options === 'function' ? options(clipId) : options)
      .map((caption, index) => ({ ...caption, id: `caption-${clipId}-${index + 1}` }));
  });
  for (let index = 1; index < captions.length; index += 1) {
    if (captions[index].startMs < captions[index - 1].endMs) {
      throw new Error(`Primary caption timing quality failure: clip groups overlap at ${captions[index].id}`);
    }
  }
  return captions;
}

export function joinWords(words: WordToken[]): string {
  return captionLayoutText(words
    .map((word) => word.text.trim())
    .filter(Boolean))
    .trim();
}
