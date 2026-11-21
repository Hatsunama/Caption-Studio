import { resolveCaptionStyle } from '@/lib/style-resolver';
import { resolveLayerGeometry } from '@/lib/layer-geometry';
import type { CaptionPair } from '@/lib/caption-tracks';
import { exportCaptionPairs } from '@/lib/export-caption-pairs';
import { projectRenderDuration } from '@/lib/project-timeline';
import { totalClipDuration } from '@/lib/video-timeline';
import {
  captionLayoutText,
  captionSpokenTokenSpans,
} from '@/lib/caption-text-breaks';
import type { CaptionBlock, CaptionProject, CaptionStyle, WordToken } from '@/types/project';

export function serializeSrt(project: CaptionProject, allowIncompleteTranslations = false) {
  const durationMs = subtitleDuration(project);
  const translations = translationsByCaption(project, allowIncompleteTranslations);
  const events = visibleCaptions(project).flatMap((caption) => {
    const timing = srtRange(caption.startMs, caption.endMs, durationMs);
    const pairs = translations.get(caption.id) ?? [];
    const aligned = pairs.filter((pair) => pair.startMs === caption.startMs && pair.endMs === caption.endMs);
    const independent = pairs.filter((pair) => !aligned.includes(pair));
    return [{
      sourceStartMs: caption.startMs,
      sourceEndMs: caption.endMs,
      startMs: timing.startMs,
      endMs: timing.endMs,
      text: [normalizeLineEndings(caption.text).trim(), ...aligned.map((pair) => normalizeLineEndings(pair.displayText).trim())].join('\n'),
    }, ...independent.map((pair) => ({
      sourceStartMs: pair.startMs,
      sourceEndMs: pair.endMs,
      ...srtRange(pair.startMs, pair.endMs, durationMs),
      text: normalizeLineEndings(pair.displayText).trim(),
    }))];
  }).sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const primaryIds = new Set(visibleCaptions(project).map((caption) => caption.id));
  for (const [id, pairs] of translations) {
    if (primaryIds.has(id)) continue;
    pairs.forEach((pair) => events.push({ ...srtRange(pair.startMs, pair.endMs, durationMs),
      sourceStartMs: pair.startMs, sourceEndMs: pair.endMs,
      text: normalizeLineEndings(pair.displayText).trim() }));
  }
  events.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const emitted = events.map((event) => ({ ...event, text: srtCaptionText(event.text) }))
    .filter((event) => event.text && event.endMs > event.startMs);
  const timebase = subtitleTimebase(emitted.map((event) => ({
    startMs: event.sourceStartMs, endMs: event.sourceEndMs,
  })), durationMs, 1);
  const cues = emitted.map((event) => ({ ...event,
    ...srtRange(event.sourceStartMs, event.sourceEndMs, durationMs, timebase),
  })).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return cues.length > 0 ? `${cues.map((event, index) => [
    String(index + 1),
    `${srtTime(event.startMs)} --> ${srtTime(event.endMs)}`,
    event.text,
  ].join('\n')).join('\n\n')}\n` : '';
}

export function serializeAss(project: CaptionProject, allowIncompleteTranslations = false) {
  const durationMs = subtitleDuration(project);
  const { width, height } = subtitleCanvasSize(project);
  const scale = width / 360;
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 0',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,48,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,1,5,20,20,20,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const translations = translationsByCaption(project, allowIncompleteTranslations);
  const captions = visibleCaptions(project);
  const timebase = subtitleTimebase([
    ...captions, ...[...translations.values()].flat(),
  ].filter((event) => {
    const timing = assRange(event.startMs, event.endMs, durationMs);
    return timing.endCs > timing.startCs;
  }), durationMs, 10);
  const events = captions.flatMap((caption) => {
    const style = resolveCaptionStyle(project.projectStyle, caption);
    const timing = assRange(caption.startMs, caption.endMs, durationMs, timebase);
    return [
      assDialogue(0, timing, style, width, height, scale, assCaptionText(project, caption, style, scale)),
      ...(translations.get(caption.id) ?? []).map((pair, index) => assDialogue(
        index + 1,
        assRange(pair.startMs, pair.endMs, durationMs, timebase),
        pair.style,
        width,
        height,
        scale,
        assText(transformText(normalizeLineEndings(pair.displayText).trim(), pair.style.textTransform)),
      )),
    ];
  });
  const primaryIds = new Set(visibleCaptions(project).map((caption) => caption.id));
  for (const [id, pairs] of translations) {
    if (primaryIds.has(id)) continue;
    pairs.forEach((pair, index) => events.push(assDialogue(index + 1,
      assRange(pair.startMs, pair.endMs, durationMs, timebase), pair.style, width, height, scale,
      assText(transformText(normalizeLineEndings(pair.displayText).trim(), pair.style.textTransform)))));
  }
  return [...header, ...events.filter(Boolean), ''].join('\n');
}

function assDialogue(
  layer: number,
  timing: ReturnType<typeof assRange>,
  style: CaptionStyle,
  width: number,
  height: number,
  scale: number,
  text: string,
) {
  if (timing.endCs <= timing.startCs) return '';
  const x = Math.round(style.position.x * width);
  const y = Math.round(style.position.y * height);
  const alignment = style.alignment === 'left' ? 4 : style.alignment === 'right' ? 6 : 5;
  const geometry = resolveLayerGeometry(style);
  const tags = [
    assPaintTags(style, scale),
    `\\fsp${decimal(style.letterSpacing * scale)}`,
    `\\frz${decimal(style.rotation)}`,
    `\\fscx${decimal(geometry.scale * geometry.scaleX * 100)}`,
    `\\fscy${decimal(geometry.scale * geometry.scaleY * 100)}`,
    `\\an${alignment}`,
    `\\pos(${x},${y})`,
    '\\q0',
  ].join('');
  return `Dialogue: ${layer},${assTime(timing.startCs)},${assTime(timing.endCs)},Default,,0,0,0,,{${tags}}${text}`;
}

function translationsByCaption(project: CaptionProject, allowIncompleteTranslations = false) {
  const pairs = new Map<string, CaptionPair[]>();
  for (const pair of exportCaptionPairs(project, allowIncompleteTranslations)) {
    const current = pairs.get(pair.source.id) ?? [];
    current.push(pair);
    pairs.set(pair.source.id, current);
  }
  return pairs;
}

export function visibleCaptions(project: CaptionProject) {
  const durationMs = projectRenderDuration(project);
  return project.captions
    .filter((caption) => (
      durationMs > 0
      &&
      caption.timelineVisible !== false
      && Number.isFinite(caption.startMs)
      && Number.isFinite(caption.endMs)
      && Math.min(durationMs, caption.endMs) > Math.max(0, caption.startMs)
      && caption.text.trim()
    ))
    .map((caption) => ({ ...caption, startMs: Math.max(0, caption.startMs),
      endMs: Math.min(durationMs, caption.endMs) }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id));
}

function assCaptionText(
  project: CaptionProject,
  caption: CaptionBlock,
  captionStyle: CaptionStyle,
  scale: number,
) {
  const sourceText = normalizeLineEndings(caption.text);
  const wordsById = new Map(project.transcription?.words?.map((word) => [word.id, word]) ?? []);
  const words = caption.wordIds.flatMap((id) => {
    const word = wordsById.get(id);
    return word ? [word] : [];
  });
  if (words.length === 0 || comparableText(captionLayoutText(words.map((word) => word.text))) !== comparableText(sourceText)) {
    return assText(transformText(sourceText, captionStyle.textTransform));
  }

  let tokens = captionSpokenTokenSpans(sourceText);
  let alignedWords = words;
  if (tokens.length !== words.length
    || tokens.some((token, index) => comparableText(token.text) !== comparableText(words[index].text))) {
    // Symbol-only authored spans are gaps, never a reason to rebuild from ASR.
    const spokenWords = words.flatMap((word) => captionSpokenTokenSpans(word.text)
      .filter((token) => comparableText(token.text))
      .map((token) => ({ key: comparableText(token.text), word })));
    tokens = tokens.filter((token) => comparableText(token.text));
    if (tokens.length !== spokenWords.length
      || tokens.some((token, index) => comparableText(token.text) !== spokenWords[index].key)) {
      return assText(transformText(sourceText, captionStyle.textTransform));
    }
    alignedWords = spokenWords.map(({ word }) => word);
  }

  const authoredGap = (text: string) => {
    const reset = /\S/u.test(text) ? `{${assPaintTags(captionStyle, scale)}}` : '';
    return `${reset}${assText(transformText(text, captionStyle.textTransform))}`;
  };
  let cursor = 0;
  const styled = tokens.map((token, index) => {
    const separator = authoredGap(sourceText.slice(cursor, token.start));
    cursor = token.end;
    return `${separator}${styledAssWord(sourceText.slice(token.start, token.end), project, caption, alignedWords[index], scale)}`;
  }).join('');
  return `${styled}${authoredGap(sourceText.slice(cursor))}`;
}

function styledAssWord(
  text: string,
  project: CaptionProject,
  caption: CaptionBlock,
  word: WordToken,
  scale: number,
) {
  const style = resolveCaptionStyle(project.projectStyle, caption, word);
  return `{${assPaintTags(style, scale)}}${assText(transformText(text, style.textTransform))}`;
}

function assPaintTags(style: CaptionStyle, scale: number) {
  const shadow = assShadow(style, scale);
  return [
    `\\fn${assTagText(style.font.postScriptName || style.font.family)}`,
    `\\fs${decimal(style.fontSize * scale)}`,
    `\\b${style.fontWeight}`,
    `\\i${style.italic ? 1 : 0}`,
    `\\c${assColor(style.textColor)}`,
    `\\2c${assColor(style.activeWordColor)}`,
    `\\3c${assColor(style.stroke.color)}`,
    `\\bord${decimal(style.stroke.width * scale)}`,
    `\\4c${assColor(shadow.color, shadow.opacity)}`,
    `\\xshad${decimal(shadow.offsetX)}`,
    `\\yshad${decimal(shadow.offsetY)}`,
    `\\blur${decimal(shadow.blur)}`,
  ].join('');
}

function assShadow(style: CaptionStyle, scale: number) {
  if (style.textTreatment === 'duotone-offset') {
    return { color: style.secondaryTextColor, opacity: 1, offsetX: 4 * scale, offsetY: 4 * scale, blur: 0 };
  }
  if (style.textTreatment === 'duotone-shadow') {
    return { color: style.secondaryTextColor, opacity: 1, offsetX: 0, offsetY: 4 * scale, blur: 2 * scale };
  }
  if (style.textTreatment === 'duotone-neon') {
    return { color: style.secondaryTextColor, opacity: 1, offsetX: 0, offsetY: 0, blur: 10 * scale };
  }
  return {
    color: style.shadow.color,
    opacity: style.shadow.opacity,
    offsetX: style.shadow.offsetX * scale,
    offsetY: style.shadow.offsetY * scale,
    blur: style.shadow.blur * scale,
  };
}

function transformText(value: string, transform: CaptionStyle['textTransform']) {
  if (transform === 'uppercase') return value.toUpperCase();
  if (transform === 'lowercase') return value.toLowerCase();
  return value;
}

function comparableText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

/** Retain the exact footage end until the subtitle format quantizes its bound. */
function subtitleDuration(project: CaptionProject) {
  return project.clips?.length ? totalClipDuration(project.clips) : projectRenderDuration(project);
}

/**
 * Project only legacy-emitted events onto a shared format clock. Adjacent source
 * timestamps may coincide on that clock, but every event needs at least one unit.
 * A single monotone map keeps shared boundaries shared across all export tracks
 * without flattening authored overlaps or changing project timing.
 */
function subtitleTimebase(
  events: readonly { startMs: number; endMs: number }[],
  durationMs: number,
  quantumMs: number,
) {
  const clamp = (time: number) => Math.max(0, Math.min(durationMs, time));
  const ranges = events.map((event) => [clamp(event.startMs), clamp(event.endMs)]);
  const times = [...new Set(ranges.flat())].sort((a, b) => a - b);
  const indices = new Map(times.map((time, index) => [time, index]));
  const incoming: number[][] = times.map(() => []);
  const outgoing: number[][] = times.map(() => []);
  for (const [start, end] of ranges) {
    const left = indices.get(start)!;
    const right = indices.get(end)!;
    outgoing[left].push(right);
    incoming[right].push(left);
  }
  const limit = Math.floor(durationMs / quantumMs);
  // The epsilon tolerates floating point noise at a format-unit boundary only.
  const epsilon = 1e-9;
  const lower = times.map((time) => Math.max(0, Math.ceil(time / quantumMs - 1 - epsilon)));
  const upper = times.map((time) => Math.min(limit, Math.floor(time / quantumMs + 1 + epsilon)));
  const infeasible = () => {
    throw new Error(quantumMs === 10
      ? 'These captions are too closely timed for ASS. Export SRT or adjust their timing.'
      : 'These captions are too closely timed for SRT. Adjust their timing before exporting.');
  };
  // All constraint edges point forward, so a backwards pass bounds every choice
  // by the room needed for later events, including events near the footage end.
  for (let index = times.length - 1; index >= 0; index--) {
    if (index + 1 < times.length) upper[index] = Math.min(upper[index], upper[index + 1]);
    for (const end of outgoing[index]) upper[index] = Math.min(upper[index], upper[end] - 1);
    if (lower[index] > upper[index]) infeasible();
  }
  const units: number[] = [];
  for (let index = 0; index < times.length; index++) {
    let minimum = Math.max(lower[index], index > 0 ? units[index - 1] : 0);
    for (const start of incoming[index]) minimum = Math.max(minimum, units[start] + 1);
    if (minimum > upper[index]) infeasible();
    units.push(Math.max(minimum, Math.min(Math.round(times[index] / quantumMs), upper[index])));
  }
  return new Map(times.map((time, index) => [time, units[index]]));
}

function srtRange(startMs: number, endMs: number, durationMs: number, timebase?: ReadonlyMap<number, number>) {
  const start = Math.max(0, Math.round(startMs));
  const end = Math.min(Math.floor(durationMs), Math.max(start + 1, Math.round(endMs)));
  if (timebase && end > start) return {
    startMs: timebase.get(Math.max(0, Math.min(durationMs, startMs)))!,
    endMs: timebase.get(Math.max(0, Math.min(durationMs, endMs)))!,
  };
  return { startMs: start, endMs: end };
}

function assRange(startMs: number, endMs: number, durationMs: number, timebase?: ReadonlyMap<number, number>) {
  const start = Math.max(0, Math.round(startMs / 10));
  const end = Math.min(Math.floor(durationMs / 10), Math.max(start + 1, Math.round(endMs / 10)));
  if (timebase && end > start) return {
    startCs: timebase.get(Math.max(0, Math.min(durationMs, startMs)))!,
    endCs: timebase.get(Math.max(0, Math.min(durationMs, endMs)))!,
  };
  return { startCs: start, endCs: end };
}

function srtTime(milliseconds: number) {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1_000);
  const millis = milliseconds % 1_000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

function assTime(centiseconds: number) {
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor(centiseconds % 360_000 / 6_000);
  const seconds = Math.floor(centiseconds % 6_000 / 100);
  return `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(centiseconds % 100, 2)}`;
}

function assColor(value: string, opacity = 1) {
  const hex = value.replace('#', '');
  const expanded = hex.length === 3 ? [...hex].map((character) => `${character}${character}`).join('') : hex.padEnd(6, 'F').slice(0, 6);
  const red = expanded.slice(0, 2);
  const green = expanded.slice(2, 4);
  const blue = expanded.slice(4, 6);
  const alpha = pad(Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255).toString(16).toUpperCase(), 2);
  return `&H${alpha}${blue}${green}${red}&`;
}

function assText(value: string) {
  return value
    .replace(/\t/g, '  ')
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function assTagText(value: string) {
  return value.replace(/[\\{}\r\n]/g, '').trim() || 'Arial';
}

function subtitleCanvasSize(project: CaptionProject) {
  const aspect = project.canvas.aspectWidth / project.canvas.aspectHeight;
  return aspect >= 1
    ? { width: Math.round(1080 * aspect), height: 1080 }
    : { width: 1080, height: Math.round(1080 / aspect) };
}

/** Blank lines delimit SRT cues; retain nonblank lines without changing project text. */
function srtCaptionText(value: string) {
  return normalizeLineEndings(value).trim().split('\n')
    .filter((line) => line.trim()).join('\n');
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n?/g, '\n').replace(/\0/g, '');
}

function decimal(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function pad(value: number | string, length: number) {
  return String(value).padStart(length, '0');
}
