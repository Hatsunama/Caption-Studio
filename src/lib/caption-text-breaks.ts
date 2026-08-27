export type CaptionTextTokenSpan = {
  text: string;
  start: number;
  end: number;
};

export type TimedCaptionText = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
};

const TOKEN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
const EAST_ASIAN_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const CLOSING_PUNCTUATION = /^[,.;:!?%\u2026\u3001\u3002\uFF01\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF05)\]}\u3009\u300B\u300D\u300F\u3011\u3015\u3017\u3019\u301B\u2019\u201D]+$/u;
const OPENING_PUNCTUATION = /^[([{\u3008\u300A\u300C\u300E\u3010\u3014\u3016\u3018\u301A\u2018\u201C]+$/u;
const CJK_PUNCTUATION_EDGE = /[\u3001\u3002\uFF01\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF05\u3008-\u301B]/u;
const COMBINING_CHARACTER = /[\p{Mark}\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}]/u;

export function captionTextTokenSpans(text: string): CaptionTextTokenSpan[] {
  return [...text.matchAll(TOKEN_PATTERN)].map((match) => ({
    text: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

export function captionTextTokens(text: string) {
  return captionTextTokenSpans(text.normalize('NFC')).map((span) => span.text);
}

export function captionSpokenTokenSpans(text: string): CaptionTextTokenSpan[] {
  const result: CaptionTextTokenSpan[] = [];
  for (const span of captionTextTokenSpans(text)) {
    if (CLOSING_PUNCTUATION.test(span.text) && result.length > 0) {
      const previous = result[result.length - 1];
      result[result.length - 1] = {
        text: `${previous.text}${span.text}`,
        start: previous.start,
        end: span.end,
      };
      continue;
    }
    if (result.length > 0 && OPENING_PUNCTUATION.test(result[result.length - 1].text)) {
      const previous = result[result.length - 1];
      result[result.length - 1] = {
        text: `${previous.text}${span.text}`,
        start: previous.start,
        end: span.end,
      };
      continue;
    }
    result.push(span);
  }
  return result;
}

export function alignCaptionTimedWords<T extends TimedCaptionText>(
  words: readonly T[],
  captionText: string,
): T[] {
  if (
    words.length === 0
    || words.some((word) => (
      !Number.isFinite(word.startMs)
      || !Number.isFinite(word.endMs)
      || word.endMs <= word.startMs
    ))
  ) return [];

  const captionUnits = captionTimingUnits(captionText);
  const timedUnits = words.flatMap(expandTimedCaptionWord);
  if (
    captionUnits.length === 0
    || captionUnits.length !== timedUnits.length
    || captionUnits.some((unit, index) => unit.key !== timedUnits[index].key)
  ) return [];

  return captionUnits.map((unit, index) => ({
    ...timedUnits[index].word,
    text: unit.text,
    startMs: timedUnits[index].startMs,
    endMs: timedUnits[index].endMs,
  }));
}

export function captionLayoutText(tokens: readonly string[]) {
  return tokens.reduce((result, token, index) => {
    if (index === 0 || !captionTokensNeedSpace(tokens[index - 1], token)) return `${result}${token}`;
    return `${result} ${token}`;
  }, '');
}

export function captionTokensNeedSpace(previous: string, current: string) {
  const previousEdge = lastCodePoint(previous);
  const currentEdge = firstCodePoint(current);
  if (!previousEdge || !currentEdge) return false;
  if (CLOSING_PUNCTUATION.test(current) || OPENING_PUNCTUATION.test(previous)) return false;
  if (EAST_ASIAN_CHARACTER.test(previousEdge) || EAST_ASIAN_CHARACTER.test(currentEdge)) return false;
  if (CJK_PUNCTUATION_EDGE.test(previousEdge) || CJK_PUNCTUATION_EDGE.test(currentEdge)) return false;
  return true;
}

export function captionTextLength(text: string) {
  return captionGraphemeSpans(text.normalize('NFC')).length;
}

export function captionTextHead(text: string, maximumLength: number) {
  const spans = captionGraphemeSpans(text);
  if (spans.length <= maximumLength) return text;
  if (maximumLength <= 0) return '';
  return text.slice(0, spans[maximumLength - 1].end);
}

export function captionTextTail(text: string, maximumLength: number) {
  const spans = captionGraphemeSpans(text);
  if (spans.length <= maximumLength) return text;
  if (maximumLength <= 0) return '';
  return text.slice(spans[spans.length - maximumLength].start);
}

export function captionTextPrefixLength(text: string, requestedOffset: number) {
  const offset = safeCaptionTextOffset(text, requestedOffset);
  return captionGraphemeSpans(text).filter((span) => span.end <= offset).length;
}

export function safeCaptionTextOffset(text: string, requestedOffset: number) {
  const offset = Math.min(text.length, Math.max(0, Math.trunc(requestedOffset)));
  const containing = captionGraphemeSpans(text).find((span) => offset > span.start && offset < span.end);
  if (!containing) return offset;
  return offset - containing.start <= containing.end - offset ? containing.start : containing.end;
}

export function captionSplitBoundaryAtCursor(text: string, requestedOffset: number) {
  const spans = captionSpokenTokenSpans(text);
  if (spans.length < 2) return undefined;
  const offset = safeCaptionTextOffset(text, requestedOffset);
  for (let index = 1; index < spans.length; index += 1) {
    if (offset >= spans[index - 1].end && offset <= spans[index].start) {
      return { offset, tokenIndex: index };
    }
  }
  return undefined;
}

export function captionTextOffsetForSpokenBoundary(text: string, tokenIndex: number) {
  const spans = captionSpokenTokenSpans(text);
  if (tokenIndex <= 0 || tokenIndex >= spans.length) return undefined;
  return spans[tokenIndex - 1].end;
}

export function captionTextNearestSpokenBoundary(text: string, requestedOffset: number) {
  const spans = captionSpokenTokenSpans(text);
  if (spans.length < 2) return undefined;
  const offset = safeCaptionTextOffset(text, requestedOffset);
  let best = { offset: spans[0].end, tokenIndex: 1 };
  for (let index = 2; index < spans.length; index += 1) {
    const candidate = spans[index - 1].end;
    if (Math.abs(candidate - offset) < Math.abs(best.offset - offset)) {
      best = { offset: candidate, tokenIndex: index };
    }
  }
  return best;
}

export function captionCjkCharacterCount(text: string) {
  return captionGraphemeSpans(text.normalize('NFC'))
    .filter((span) => EAST_ASIAN_CHARACTER.test(span.text))
    .length;
}

export function containsCaptionCjk(text: string) {
  return EAST_ASIAN_CHARACTER.test(text);
}

export function compactCaptionToken(value: string) {
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{P}\p{S}]+$/u.test(value);
}

type CaptionTimingUnit = {
  text: string;
  key: string;
};

type ExpandedTimedCaptionWord<T extends TimedCaptionText> = CaptionTimingUnit & {
  word: T;
  startMs: number;
  endMs: number;
};

function captionTimingUnits(text: string): CaptionTimingUnit[] {
  const units: CaptionTimingUnit[] = [];
  let prefix = '';
  for (const span of captionSpokenTokenSpans(text.normalize('NFC'))) {
    const key = captionTimingKey(span.text);
    if (!key) {
      if (units.length > 0) units[units.length - 1].text += span.text;
      else prefix += span.text;
      continue;
    }
    units.push({ text: `${prefix}${span.text}`, key });
    prefix = '';
  }
  if (prefix && units.length > 0) units[units.length - 1].text += prefix;
  return units;
}

function expandTimedCaptionWord<T extends TimedCaptionText>(word: T): ExpandedTimedCaptionWord<T>[] {
  const units = captionTimingUnits(word.text);
  if (units.length === 0) return [];
  const weights = units.map((unit) => Math.max(1, captionTextLength(unit.text)));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const durationMs = word.endMs - word.startMs;
  let consumedWeight = 0;
  return units.flatMap((unit, index) => {
    const startMs = word.startMs + Math.round(durationMs * consumedWeight / totalWeight);
    consumedWeight += weights[index];
    const endMs = word.startMs + Math.round(durationMs * consumedWeight / totalWeight);
    if (endMs <= startMs) return [];
    return [{
      ...unit,
      word: units.length === 1
        ? word
        : { ...word, id: `${word.id}:timing-${index}` },
      startMs,
      endMs,
    }];
  });
}

function captionTimingKey(text: string) {
  return (text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\u2019/gu, "'")
    .match(/[\p{L}\p{N}\p{M}']+/gu) ?? [])
    .join('');
}

function captionGraphemeSpans(text: string): CaptionTextTokenSpan[] {
  const spans: CaptionTextTokenSpan[] = [];
  let offset = 0;
  let joinsNext = false;
  for (const character of text) {
    const start = offset;
    offset += character.length;
    const append = spans.length > 0 && (joinsNext || character === '\u200D' || COMBINING_CHARACTER.test(character));
    if (append) {
      const previous = spans[spans.length - 1];
      spans[spans.length - 1] = {
        text: `${previous.text}${character}`,
        start: previous.start,
        end: offset,
      };
    } else {
      spans.push({ text: character, start, end: offset });
    }
    joinsNext = character === '\u200D';
  }
  return spans;
}

function firstCodePoint(text: string) {
  return Array.from(text)[0] ?? '';
}

function lastCodePoint(text: string) {
  return Array.from(text).at(-1) ?? '';
}
