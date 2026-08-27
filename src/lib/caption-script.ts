import {
  captionLayoutText,
  captionSpokenTokenSpans,
  captionSplitBoundaryAtCursor,
  captionTextLength,
  captionTextNearestSpokenBoundary,
  captionTextOffsetForSpokenBoundary,
  captionTextPrefixLength,
} from '@/lib/caption-text-breaks';
import type { CaptionBlock, WordToken } from '@/types/project';

const MINIMUM_CAPTION_MS = 80;

export type CaptionScriptMutation = {
  captions: CaptionBlock[];
  focusedId: string;
};

export type CaptionMergeResult = CaptionScriptMutation | { blockedByVideoCut: true } | null;

export function updateCaptionScriptText(captions: CaptionBlock[], captionId: string, requestedText: string) {
  return captions.map((caption) => caption.id === captionId
    ? { ...caption, text: requestedText, textMode: 'manual' as const }
    : caption);
}

export function splitCaptionScriptBlock(
  captions: CaptionBlock[],
  captionId: string,
  cursor: number,
  words: WordToken[],
  newCaptionId: string,
): CaptionScriptMutation | null {
  const index = captions.findIndex((caption) => caption.id === captionId);
  if (index < 0 || captions.some((caption) => caption.id === newCaptionId)) return null;
  const caption = captions[index];
  const splitBoundary = captionSplitBoundaryAtCursor(caption.text, cursor);
  if (!splitBoundary) return null;
  const beforeText = normalizeText(caption.text.slice(0, splitBoundary.offset));
  const afterText = normalizeText(caption.text.slice(splitBoundary.offset));
  if (!beforeText || !afterText || caption.endMs - caption.startMs < MINIMUM_CAPTION_MS * 2) return null;

  const wordById = new Map(words.map((word) => [word.id, word]));
  const timedWordIds = caption.wordIds.filter((wordId) => wordById.has(wordId));
  const splitIndex = wordSplitIndex(caption.text, splitBoundary.offset, splitBoundary.tokenIndex, timedWordIds.length);
  const leftWordIds = timedWordIds.slice(0, splitIndex);
  const rightWordIds = timedWordIds.slice(splitIndex);
  const leftWord = wordById.get(leftWordIds.at(-1) ?? '');
  const rightWord = wordById.get(rightWordIds[0] ?? '');
  const proportionalTime = caption.startMs
    + (caption.endMs - caption.startMs)
      * clamp(captionTextPrefixLength(caption.text, splitBoundary.offset) / Math.max(1, captionTextLength(caption.text)), 0, 1);
  const timedBoundary = leftWord && rightWord ? (leftWord.endMs + rightWord.startMs) / 2 : proportionalTime;
  const splitMs = clamp(timedBoundary, caption.startMs + MINIMUM_CAPTION_MS, caption.endMs - MINIMUM_CAPTION_MS);
  const sourceSplitMs = caption.sourceAnchor
    ? caption.sourceAnchor.sourceStartMs
      + (caption.sourceAnchor.sourceEndMs - caption.sourceAnchor.sourceStartMs)
        * (splitMs - caption.startMs) / Math.max(1, caption.endMs - caption.startMs)
    : undefined;

  const left: CaptionBlock = {
    ...caption,
    text: beforeText,
    textMode: 'manual',
    endMs: splitMs,
    wordIds: leftWordIds,
    sourceAnchor: caption.sourceAnchor && sourceSplitMs != null
      ? { ...caption.sourceAnchor, sourceEndMs: sourceSplitMs, wordIds: leftWordIds }
      : undefined,
  };
  const right: CaptionBlock = {
    ...caption,
    id: newCaptionId,
    text: afterText,
    textMode: 'manual',
    startMs: splitMs,
    wordIds: rightWordIds,
    sourceAnchor: caption.sourceAnchor && sourceSplitMs != null
      ? { ...caption.sourceAnchor, sourceStartMs: sourceSplitMs, wordIds: rightWordIds }
      : undefined,
  };
  const next = [...captions];
  next.splice(index, 1, left, right);
  return { captions: next, focusedId: right.id };
}

export function splitCaptionScriptBlockAtTime(
  captions: CaptionBlock[],
  captionId: string,
  requestedTimeMs: number,
  words: WordToken[],
  newCaptionId: string,
): CaptionScriptMutation | null {
  const caption = captions.find((candidate) => candidate.id === captionId);
  if (
    !caption
    || !Number.isFinite(requestedTimeMs)
    || requestedTimeMs <= caption.startMs + MINIMUM_CAPTION_MS
    || requestedTimeMs >= caption.endMs - MINIMUM_CAPTION_MS
  ) return null;

  const wordById = new Map(words.map((word) => [word.id, word]));
  const timedWords = caption.wordIds
    .map((wordId) => wordById.get(wordId))
    .filter((word): word is WordToken => Boolean(word));
  const splitWordIndex = nearestWordBoundary(timedWords, requestedTimeMs);
  const cursor = textCursorForWordBoundary(caption.text, splitWordIndex, timedWords.length, requestedTimeMs, caption);
  const result = splitCaptionScriptBlock(captions, captionId, cursor, words, newCaptionId);
  if (!result) return null;

  const boundaryMs = splitWordIndex > 0 && splitWordIndex < timedWords.length
    ? clamp(
        (timedWords[splitWordIndex - 1].endMs + timedWords[splitWordIndex].startMs) / 2,
        caption.startMs + MINIMUM_CAPTION_MS,
        caption.endMs - MINIMUM_CAPTION_MS,
      )
    : clamp(requestedTimeMs, caption.startMs + MINIMUM_CAPTION_MS, caption.endMs - MINIMUM_CAPTION_MS);
  const left = result.captions.find((candidate) => candidate.id === captionId);
  const right = result.captions.find((candidate) => candidate.id === newCaptionId);
  if (!left || !right) return null;
  return {
    captions: result.captions.map((candidate) => {
      if (candidate.id === left.id) return withCaptionBoundary(candidate, 'end', boundaryMs);
      if (candidate.id === right.id) return withCaptionBoundary(candidate, 'start', boundaryMs);
      return candidate;
    }),
    focusedId: result.focusedId,
  };
}

export function mergeCaptionScriptBlock(
  captions: CaptionBlock[],
  captionId: string,
  direction: 'previous' | 'next' = 'previous',
): CaptionMergeResult {
  const currentIndex = captions.findIndex((caption) => caption.id === captionId);
  if (currentIndex < 0) return null;
  const leftIndex = direction === 'previous' ? currentIndex - 1 : currentIndex;
  const rightIndex = leftIndex + 1;
  if (leftIndex < 0 || rightIndex >= captions.length) return null;
  const previous = captions[leftIndex];
  const current = captions[rightIndex];
  if (
    !previous.sourceAnchor
    || !current.sourceAnchor
    || previous.sourceAnchor.clipId !== current.sourceAnchor.clipId
  ) return { blockedByVideoCut: true };

  const wordIds = [...previous.wordIds, ...current.wordIds];
  const sourceAnchor = previous.sourceAnchor && current.sourceAnchor
    ? {
        ...previous.sourceAnchor,
        sourceStartMs: Math.min(previous.sourceAnchor.sourceStartMs, current.sourceAnchor.sourceStartMs),
        sourceEndMs: Math.max(previous.sourceAnchor.sourceEndMs, current.sourceAnchor.sourceEndMs),
        wordIds,
      }
    : undefined;
  const merged: CaptionBlock = {
    ...previous,
    text: normalizeText(captionLayoutText([previous.text.trim(), current.text.trim()])),
    textMode: 'manual',
    endMs: Math.max(previous.endMs, current.endMs),
    wordIds,
    sourceAnchor,
    timelineVisible: true,
  };
  const next = [...captions];
  next.splice(leftIndex, 2, merged);
  return { captions: next, focusedId: merged.id };
}

function nearestWordBoundary(words: WordToken[], requestedTimeMs: number) {
  if (words.length < 2) return 0;
  let nearestIndex = 1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const boundary = (words[index - 1].endMs + words[index].startMs) / 2;
    const distance = Math.abs(boundary - requestedTimeMs);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  }
  return nearestIndex;
}

function textCursorForWordBoundary(
  text: string,
  wordBoundary: number,
  timedWordCount: number,
  requestedTimeMs: number,
  caption: CaptionBlock,
) {
  if (timedWordCount > 1 && wordBoundary > 0) {
    const exact = captionTextOffsetForSpokenBoundary(text, wordBoundary);
    if (exact != null && captionSpokenTokenSpans(text).length === timedWordCount) return exact;
  }
  const ratio = (requestedTimeMs - caption.startMs) / Math.max(1, caption.endMs - caption.startMs);
  const requestedGrapheme = captionTextLength(text) * clamp(ratio, 0, 1);
  const spans = captionSpokenTokenSpans(text);
  const requestedCursor = spans.find((span) => captionTextPrefixLength(text, span.end) >= requestedGrapheme)?.end
    ?? spans.at(-1)?.end
    ?? 0;
  return captionTextNearestSpokenBoundary(text, requestedCursor)?.offset ?? 0;
}

function withCaptionBoundary(caption: CaptionBlock, edge: 'start' | 'end', boundaryMs: number): CaptionBlock {
  if (!caption.sourceAnchor) return { ...caption, [edge === 'start' ? 'startMs' : 'endMs']: boundaryMs };
  const duration = Math.max(1, caption.endMs - caption.startMs);
  const sourceBoundary = caption.sourceAnchor.sourceStartMs
    + (caption.sourceAnchor.sourceEndMs - caption.sourceAnchor.sourceStartMs)
      * (boundaryMs - caption.startMs) / duration;
  return {
    ...caption,
    [edge === 'start' ? 'startMs' : 'endMs']: boundaryMs,
    sourceAnchor: {
      ...caption.sourceAnchor,
      [edge === 'start' ? 'sourceStartMs' : 'sourceEndMs']: sourceBoundary,
    },
  };
}

function wordSplitIndex(text: string, cursor: number, tokenBoundary: number, wordCount: number) {
  if (wordCount < 2) return 0;
  const tokenCount = captionSpokenTokenSpans(text).length;
  if (tokenCount === wordCount && tokenBoundary > 0 && tokenBoundary < wordCount) return tokenBoundary;
  const prefixLength = captionTextPrefixLength(text, cursor);
  return clamp(Math.round(wordCount * prefixLength / Math.max(1, captionTextLength(text))), 1, wordCount - 1);
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
