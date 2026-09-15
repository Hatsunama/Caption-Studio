import { captionTextTokens } from '@/lib/caption-text-breaks';
import { reactionEmojis } from '@/lib/emoji-reactions';

/** One cycle over the current cue, independent of presets and stale word timings. */
export function captionCueProgress(currentMs: number, cue: { startMs: number; endMs: number }) {
  const { startMs, endMs } = cue;
  if (
    !Number.isFinite(currentMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs)
    || endMs <= startMs || currentMs < startMs || currentMs >= endMs
  ) return undefined;
  return (currentMs - startMs) / (endMs - startMs);
}

/** Keep one small reaction family stable for the whole cue, using its current text. */
export function captionCueEmojis(text: string): string[] {
  const words = captionTextTokens(text);
  for (let activeIndex = 0; activeIndex < words.length; activeIndex += 1) {
    const emojis = reactionEmojis(words[activeIndex], text, { words, activeIndex });
    if (emojis.length > 0) return emojis.slice(0, 2);
  }
  return reactionEmojis('', text).slice(0, 2);
}
