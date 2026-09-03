import { resolveCaptionStyle } from '@/lib/style-resolver';
import { assertVisibleTranslationTracksCompatible, resolveCaptionPairs, type CaptionPair } from '@/lib/caption-tracks';
import {
  captionLayoutText,
  captionSpokenTokenSpans,
  captionTokensNeedSpace,
} from '@/lib/caption-text-breaks';
import type { CaptionBlock, CaptionProject, CaptionStyle, WordToken } from '@/types/project';

export function serializeSrt(project: CaptionProject) {
  const translations = translationsByCaption(project);
  const events = visibleCaptions(project).flatMap((caption) => {
    const timing = srtRange(caption.startMs, caption.endMs);
    const pairs = translations.get(caption.id) ?? [];
    const aligned = pairs.filter((pair) => Math.round(pair.startMs) === timing.startMs && Math.round(pair.endMs) === timing.endMs);
    const independent = pairs.filter((pair) => !aligned.includes(pair));
    return [{
      startMs: timing.startMs,
      endMs: timing.endMs,
      text: [normalizeLineEndings(caption.text).trim(), ...aligned.map((pair) => normalizeLineEndings(pair.translation.text).trim())].join('\n'),
    }, ...independent.map((pair) => ({
      ...srtRange(pair.startMs, pair.endMs),
      text: normalizeLineEndings(pair.translation.text).trim(),
    }))];
  }).sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  return events.length > 0 ? `${events.map((event, index) => [
    String(index + 1),
    `${srtTime(event.startMs)} --> ${srtTime(event.endMs)}`,
    event.text,
  ].join('\n')).join('\n\n')}\n` : '';
}

export function serializeAss(project: CaptionProject) {
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
  const translations = translationsByCaption(project);
  const events = visibleCaptions(project).flatMap((caption) => {
    const style = resolveCaptionStyle(project.projectStyle, caption);
    const timing = assRange(caption.startMs, caption.endMs);
    return [
      assDialogue(0, timing, style, width, height, scale, assCaptionText(project, caption, style, scale)),
      ...(translations.get(caption.id) ?? []).map((pair, index) => assDialogue(
        index + 1,
        assRange(pair.startMs, pair.endMs),
        pair.style,
        width,
        height,
        scale,
        assText(transformText(normalizeLineEndings(pair.translation.text).trim(), pair.style.textTransform)),
      )),
    ];
  });
  return [...header, ...events, ''].join('\n');
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
  const x = Math.round(style.position.x * width);
  const y = Math.round(style.position.y * height);
  const alignment = style.alignment === 'left' ? 4 : style.alignment === 'right' ? 6 : 5;
  const tags = [
    assPaintTags(style, scale),
    `\\fsp${decimal(style.letterSpacing * scale)}`,
    `\\frz${decimal(style.rotation)}`,
    `\\an${alignment}`,
    `\\pos(${x},${y})`,
    '\\q0',
  ].join('');
  return `Dialogue: ${layer},${assTime(timing.startCs)},${assTime(timing.endCs)},Default,,0,0,0,,{${tags}}${text}`;
}

function translationsByCaption(project: CaptionProject) {
  assertVisibleTranslationTracksCompatible(project);
  const pairs = new Map<string, CaptionPair[]>();
  for (const track of project.captionTracks?.translations ?? []) {
    if (!track.visible) continue;
    const resolved = resolveCaptionPairs(project, track.id).filter((pair) => pair.timelineVisible);
    const unresolved = resolved.filter((pair) => (
      pair.translation.status === 'pending'
      || pair.translation.status === 'stale'
      || !pair.translation.text.trim()
    ));
    if (unresolved.length > 0) {
      throw new Error(
        `${track.displayName} has ${unresolved.length} subtitle${unresolved.length === 1 ? '' : 's'} that need translation. Refresh them or hide the second language before exporting.`,
      );
    }
    for (const pair of resolved) {
      const current = pairs.get(pair.source.id) ?? [];
      current.push(pair);
      pairs.set(pair.source.id, current);
    }
  }
  return pairs;
}

export function visibleCaptions(project: Pick<CaptionProject, 'captions'>) {
  return project.captions
    .filter((caption) => (
      caption.timelineVisible !== false
      && Number.isFinite(caption.startMs)
      && Number.isFinite(caption.endMs)
      && caption.endMs > Math.max(0, caption.startMs)
      && caption.text.trim()
    ))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id));
}

function assCaptionText(
  project: CaptionProject,
  caption: CaptionBlock,
  captionStyle: CaptionStyle,
  scale: number,
) {
  const sourceText = normalizeLineEndings(caption.text).trim();
  const wordsById = new Map(project.transcription?.words?.map((word) => [word.id, word]) ?? []);
  const words = caption.wordIds.flatMap((id) => {
    const word = wordsById.get(id);
    return word ? [word] : [];
  });
  if (words.length === 0 || comparableText(captionLayoutText(words.map((word) => word.text))) !== comparableText(sourceText)) {
    return assText(transformText(sourceText, captionStyle.textTransform));
  }

  const tokens = captionSpokenTokenSpans(sourceText);
  if (tokens.length !== words.length) {
    return words.map((word, index) => {
      const separator = index > 0 && captionTokensNeedSpace(words[index - 1].text, word.text) ? ' ' : '';
      return `${separator}${styledAssWord(word.text, project, caption, word, scale)}`;
    }).join('');
  }

  let cursor = 0;
  const styled = tokens.map((token, index) => {
    const separator = assWhitespace(sourceText.slice(cursor, token.start));
    cursor = token.end;
    return `${separator}${styledAssWord(token.text, project, caption, words[index], scale)}`;
  }).join('');
  return `${styled}${assWhitespace(sourceText.slice(cursor))}`;
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

function srtRange(startMs: number, endMs: number) {
  const start = Math.max(0, Math.round(startMs));
  const end = Math.max(start + 1, Math.round(endMs));
  return { startMs: start, endMs: end };
}

function assRange(startMs: number, endMs: number) {
  const start = Math.max(0, Math.round(startMs / 10));
  const end = Math.max(start + 1, Math.round(endMs / 10));
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
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function assWhitespace(value: string) {
  return value.replace(/\r?\n/g, '\\N').replace(/\t/g, '    ');
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
