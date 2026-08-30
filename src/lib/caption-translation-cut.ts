import { captionGroupingProfile } from '@/lib/caption-languages';
import {
  captionLayoutText,
  captionSpokenTokenSpans,
  captionTextLength,
} from '@/lib/caption-text-breaks';

export type CaptionDocumentSource = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
};

export type CaptionDocumentChunk = {
  id: string;
  text: string;
  sourceIds: string[];
};

const DOCUMENT_CHUNK_CHARACTERS = 1_600;
const SENTENCE_END = /[.!?。！？…\u061F]["'”’」』)\]]*$/u;

export function packCaptionDocuments(
  captions: readonly { id: string; text: string }[],
  maxCharacters = DOCUMENT_CHUNK_CHARACTERS,
): CaptionDocumentChunk[] {
  const chunks: CaptionDocumentChunk[] = [];
  let sourceIds: string[] = [];
  let texts: string[] = [];
  let characters = 0;

  const flush = () => {
    if (sourceIds.length === 0) return;
    chunks.push({
      id: `document-${chunks.length + 1}`,
      text: texts.join('\n'),
      sourceIds,
    });
    sourceIds = [];
    texts = [];
    characters = 0;
  };

  for (const caption of captions) {
    const text = caption.text.normalize('NFC').trim();
    if (!text) continue;
    const length = captionTextLength(text);
    if (sourceIds.length > 0 && characters + length + 1 > maxCharacters) flush();
    sourceIds.push(caption.id);
    texts.push(text);
    characters += length + (texts.length > 1 ? 1 : 0);
  }
  flush();
  return chunks;
}

export function cutTranslatedDocument(
  translatedText: string,
  sources: readonly CaptionDocumentSource[],
  targetLanguageTag: string,
): Map<string, string> {
  const result = new Map<string, string>();
  if (sources.length === 0) return result;
  const translated = translatedText.normalize('NFC').trim();
  if (sources.length === 1) {
    result.set(sources[0].id, translated || sources[0].text.trim());
    return result;
  }
  const tokens = captionSpokenTokenSpans(translated).map((span) => span.text);
  if (tokens.length === 0) {
    sources.forEach((source) => result.set(source.id, source.text.trim()));
    return result;
  }

  const compact = ['cjk', 'hangul', 'thai'].includes(captionGroupingProfile(targetLanguageTag));
  const weights = sources.map((source) => sourceWeight(source, compact));
  const assignments = allocateTokens(tokens, weights);
  assignments.forEach((slice, index) => {
    const source = sources[index];
    const text = captionLayoutText(slice).trim();
    result.set(source.id, text || source.text.trim());
  });
  return result;
}

function sourceWeight(source: CaptionDocumentSource, compact: boolean) {
  const duration = Math.max(80, source.endMs - source.startMs);
  const length = Math.max(1, captionTextLength(source.text));
  const lengthMs = compact ? length * 90 : length * 45;
  return duration * 0.62 + lengthMs * 0.38;
}

function allocateTokens(tokens: string[], weights: number[]) {
  const assignments: string[][] = weights.map(() => []);
  let index = 0;
  let remainingWeight = weights.reduce((total, weight) => total + weight, 0);
  for (let slot = 0; slot < weights.length; slot += 1) {
    const remainingSlots = weights.length - slot;
    const remainingTokens = tokens.length - index;
    if (slot === weights.length - 1 || remainingTokens <= remainingSlots) {
      assignments[slot] = tokens.slice(index);
      break;
    }
    const target = Math.max(1, Math.round(remainingTokens * (weights[slot] / Math.max(1, remainingWeight))));
    const maximum = remainingTokens - remainingSlots + 1;
    let take = Math.min(maximum, Math.max(1, target));
    take = snapToSentence(tokens, index, take, maximum);
    assignments[slot] = tokens.slice(index, index + take);
    index += take;
    remainingWeight -= weights[slot];
  }
  return fillEmptyAssignments(assignments);
}

function snapToSentence(tokens: string[], start: number, take: number, maximum: number) {
  const last = start + take - 1;
  if (SENTENCE_END.test(tokens[last] ?? '')) return take;
  const searchLimit = Math.min(start + maximum - 1, start + take + 3, tokens.length - 1);
  for (let index = last + 1; index <= searchLimit; index += 1) {
    if (SENTENCE_END.test(tokens[index] ?? '')) return index - start + 1;
  }
  for (let index = last - 1; index > start; index -= 1) {
    if (SENTENCE_END.test(tokens[index] ?? '') && last - index <= 3) return index - start + 1;
  }
  return take;
}

function fillEmptyAssignments(assignments: string[][]) {
  for (let index = 0; index < assignments.length; index += 1) {
    if (assignments[index].length > 0) continue;
    const donor = nearestDonor(assignments, index);
    if (donor < 0 || assignments[donor].length < 2) continue;
    const stolen = donor < index ? assignments[donor].pop() : assignments[donor].shift();
    if (stolen) assignments[index].push(stolen);
  }
  return assignments;
}

function nearestDonor(assignments: string[][], emptyIndex: number) {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  assignments.forEach((slice, index) => {
    if (slice.length < 2) return;
    const distance = Math.abs(index - emptyIndex);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}
