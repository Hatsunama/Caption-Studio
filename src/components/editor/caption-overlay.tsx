import { useMemo, useRef, useState } from 'react';
import {
  type GestureResponderEvent,
  PanResponder,
  type PanResponderGestureState,
  Pressable,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

import { reactionEmojis } from '@/lib/animation-presets';
import { spokenAnimationClock } from '@/lib/animation-timing';
import { resolveCaptionStyle } from '@/lib/style-resolver';
import type { CaptionAnimationId, CaptionBlock, CaptionStyle, CaptionStylePatch, WordToken } from '@/types/project';

type TouchPoint = { pageX: number; pageY: number };
type CanvasMetrics = { width: number; height: number; pageX: number; pageY: number };

export function CaptionOverlay(props: {
  caption?: CaptionBlock;
  words: WordToken[];
  projectStyle: CaptionStyle;
  currentMs: number;
  interactive?: boolean;
  onInteractionStart?: () => void;
  onTransform?: (patch: CaptionStylePatch) => void;
  onTransformEnd?: () => void;
  onDelete?: () => void;
}) {
  const { caption } = props;
  const canvasRef = useRef<View>(null);
  const canvas = useRef<CanvasMetrics>({ width: 1, height: 1, pageX: 0, pageY: 0 });
  const [canvasLayout, setCanvasLayout] = useState({ width: 360, height: 640 });
  const style = caption ? resolveCaptionStyle(props.projectStyle, caption) : props.projectStyle;
  const styleRef = useRef(style);
  const propsRef = useRef(props);
  styleRef.current = style;
  propsRef.current = props;

  const gestureStart = useRef({
    position: { x: 0.5, y: 0.78 },
    box: { width: 0.86, height: 0.2 },
    fontSize: 48,
    rotation: 0,
    touches: [] as TouchPoint[],
    touchCount: 0,
  });

  const rebaseGesture = (touches: TouchPoint[]) => {
    const current = styleRef.current;
    gestureStart.current = {
      position: { ...current.position },
      box: { ...current.box },
      fontSize: current.fontSize,
      rotation: current.rotation,
      touches,
      touchCount: touches.length >= 2 ? 2 : 1,
    };
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => Boolean(propsRef.current.interactive),
        onMoveShouldSetPanResponder: () => Boolean(propsRef.current.interactive),
        onPanResponderGrant: (event) => {
          propsRef.current.onInteractionStart?.();
          rebaseGesture(readTouches(event));
        },
        onPanResponderMove: (event) => {
          const touches = readTouches(event);
          if (touches.length === 0) return;
          const touchCount = touches.length >= 2 ? 2 : 1;
          if (gestureStart.current.touchCount !== touchCount) {
            rebaseGesture(touches);
            return;
          }

          const start = gestureStart.current;
          const size = canvas.current;
          if (touchCount === 2 && start.touches.length >= 2) {
            const initialDistance = distance(start.touches[0], start.touches[1]);
            const nextDistance = distance(touches[0], touches[1]);
            const scale = initialDistance > 8 ? nextDistance / initialDistance : 1;
            const initialCenter = midpoint(start.touches[0], start.touches[1]);
            const nextCenter = midpoint(touches[0], touches[1]);
            const rotation =
              start.rotation +
              shortestAngleDelta(angle(start.touches[0], start.touches[1]), angle(touches[0], touches[1]));
            const nextBox = {
              width: clamp(start.box.width * scale, 0.16, 1.5),
              height: clamp(start.box.height * scale, 0.06, 1.1),
            };

            propsRef.current.onTransform?.({
              position: clampPositionForBox(
                {
                  x: start.position.x + (nextCenter.pageX - initialCenter.pageX) / size.width,
                  y: start.position.y + (nextCenter.pageY - initialCenter.pageY) / size.height,
                },
                nextBox,
              ),
              box: nextBox,
              fontSize: clamp(start.fontSize * scale, 10, 240),
              rotation: normalizeDegrees(rotation),
            });
            return;
          }

          const initial = start.touches[0];
          propsRef.current.onTransform?.({
            position: clampPositionForBox(
              {
                x: start.position.x + (touches[0].pageX - initial.pageX) / size.width,
                y: start.position.y + (touches[0].pageY - initial.pageY) / size.height,
              },
              start.box,
            ),
          });
        },
        onPanResponderRelease: () => propsRef.current.onTransformEnd?.(),
        onPanResponderTerminate: () => propsRef.current.onTransformEnd?.(),
      }),
    [],
  );

  if (!caption) return null;

  const timedWords = caption.wordIds
    .map((id) => props.words.find((word) => word.id === id))
    .filter((word): word is WordToken => Boolean(word));
  const renderedWords = wordsMatchCaption(timedWords, caption.text) ? timedWords : fallbackWords(caption);
  const activeIndex = renderedWords.findIndex((word) => props.currentMs >= word.startMs && props.currentMs < word.endMs);
  const visibleWords = wordsForAnimation(renderedWords, activeIndex, style.animation.id);
  const activeWord = renderedWords[activeIndex];
  // Every effect restarts on the word's real speech window instead of looping
  // independently of the voice track.
  const { entryProgress, wordProgress } = spokenAnimationClock({
    currentMs: props.currentMs,
    captionStartMs: caption.startMs,
    captionEndMs: caption.endMs,
    animationDurationMs: style.animation.durationMs,
    activeWord,
  });
  const loopProgress = wordProgress;
  const fittedFontSize = fitCaptionFont(style, renderedWords, canvasLayout);
  const backgroundAlpha = Math.round(style.background.opacity * 255).toString(16).padStart(2, '0');
  const transformed = (text: string) => {
    if (style.textTransform === 'uppercase') return text.toUpperCase();
    if (style.textTransform === 'lowercase') return text.toLowerCase();
    return text;
  };

  return (
    <View
      ref={canvasRef}
      pointerEvents="box-none"
      collapsable={false}
      onLayout={({ nativeEvent }) => {
        const { width, height } = nativeEvent.layout;
        canvas.current = { ...canvas.current, width: Math.max(1, width), height: Math.max(1, height) };
        setCanvasLayout({ width: Math.max(1, width), height: Math.max(1, height) });
        canvasRef.current?.measureInWindow((pageX, pageY) => {
          canvas.current = { ...canvas.current, pageX, pageY };
        });
      }}
      style={{ position: 'absolute', inset: 0 }}>
      <View
        style={{
          position: 'absolute',
          left: `${(style.position.x - style.box.width / 2) * 100}%`,
          top: `${(style.position.y - style.box.height / 2) * 100}%`,
          width: `${style.box.width * 100}%`,
          height: `${style.box.height * 100}%`,
          minWidth: 52,
          minHeight: 34,
          alignItems: style.alignment === 'left' ? 'flex-start' : style.alignment === 'right' ? 'flex-end' : 'center',
          justifyContent: 'center',
          transform: [{ rotate: `${style.rotation}deg` }],
          borderWidth: props.interactive ? 2 : 0,
          borderColor: '#DFFF35',
          borderRadius: props.interactive ? 5 : 0,
        }}>
        {props.interactive ? (
          <View
            {...panResponder.panHandlers}
            collapsable={false}
            style={{ position: 'absolute', inset: 0, zIndex: 1 }}
          />
        ) : null}
        <View
          pointerEvents="none"
          style={[
            {
              width: '100%',
              height: '100%',
              justifyContent: 'center',
              borderRadius: style.background.radius,
              paddingHorizontal: style.background.paddingX,
              paddingVertical: style.background.paddingY,
              backgroundColor: `${style.background.color}${backgroundAlpha}`,
            },
            captionAnimationStyle(style.animation.id, entryProgress, loopProgress, style.animation.intensity),
          ]}>
          {style.textTreatment !== 'solid' ? (
            <WordLayer
              absolute
              colorOverride={style.secondaryTextColor}
              offset={treatmentOffset(style.textTreatment)}
              words={visibleWords}
              allWords={renderedWords}
              activeIndex={activeIndex}
              caption={caption}
              projectStyle={props.projectStyle}
              currentMs={props.currentMs}
              animationId={style.animation.id}
              loopProgress={loopProgress}
              fittedFontSize={fittedFontSize}
              transformed={transformed}
            />
          ) : null}
          <WordLayer
            words={visibleWords}
            allWords={renderedWords}
            activeIndex={activeIndex}
            caption={caption}
            projectStyle={props.projectStyle}
            currentMs={props.currentMs}
            animationId={style.animation.id}
            loopProgress={loopProgress}
            fittedFontSize={fittedFontSize}
            transformed={transformed}
          />
          {style.animation.id.startsWith('emoji-') ? (
            <EmojiEffects
              mode={style.animation.id}
              emojis={reactionEmojis(activeWord?.text ?? '', caption.text)}
              progress={loopProgress}
            />
          ) : null}
        </View>

        {props.interactive ? (
          <>
            <ResizeBar axis="width" side={-1} styleRef={styleRef} canvas={canvas} onStart={props.onInteractionStart} onChange={props.onTransform} onEnd={props.onTransformEnd} />
            <ResizeBar axis="width" side={1} styleRef={styleRef} canvas={canvas} onStart={props.onInteractionStart} onChange={props.onTransform} onEnd={props.onTransformEnd} />
            <ResizeBar axis="height" side={-1} styleRef={styleRef} canvas={canvas} onStart={props.onInteractionStart} onChange={props.onTransform} onEnd={props.onTransformEnd} />
            <ResizeBar axis="height" side={1} styleRef={styleRef} canvas={canvas} onStart={props.onInteractionStart} onChange={props.onTransform} onEnd={props.onTransformEnd} />
            <RotateScaleHandle styleRef={styleRef} canvas={canvas} onStart={props.onInteractionStart} onChange={props.onTransform} onEnd={props.onTransformEnd} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete this subtitle"
              hitSlop={10}
              onPress={props.onDelete}
              style={{
                position: 'absolute',
                left: -20,
                top: -20,
                zIndex: 30,
                width: 40,
                height: 40,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 20,
                borderWidth: 2,
                borderColor: '#11140C',
                backgroundColor: '#FF5267',
              }}>
              <Text style={{ color: '#FFFFFF', fontSize: 22, fontWeight: '900', lineHeight: 24 }}>×</Text>
            </Pressable>
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                right: 8,
                bottom: -28,
                paddingHorizontal: 7,
                paddingVertical: 3,
                borderRadius: 8,
                backgroundColor: 'rgba(9,11,14,0.9)',
              }}>
              <Text style={{ color: '#DFFF35', fontSize: 9, fontWeight: '800' }}>
                {Math.round(style.box.width * 100)} × {Math.round(style.box.height * 100)} • {Math.round(style.rotation)}°
              </Text>
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}

function WordLayer(props: {
  words: WordToken[];
  allWords: WordToken[];
  activeIndex: number;
  caption: CaptionBlock;
  projectStyle: CaptionStyle;
  currentMs: number;
  animationId: CaptionAnimationId;
  loopProgress: number;
  fittedFontSize: number;
  transformed: (text: string) => string;
  absolute?: boolean;
  colorOverride?: string;
  offset?: { x: number; y: number };
}) {
  const style = resolveCaptionStyle(props.projectStyle, props.caption);
  const justifyContent = style.alignment === 'left' ? 'flex-start' : style.alignment === 'right' ? 'flex-end' : 'center';
  return (
    <View
      style={{
        ...(props.absolute ? { position: 'absolute', inset: 0 } : null),
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignContent: 'center',
        justifyContent,
        transform: props.offset ? [{ translateX: props.offset.x }, { translateY: props.offset.y }] : undefined,
      }}>
      {props.words.map((word) => {
        const originalIndex = props.allWords.findIndex((candidate) => candidate.id === word.id);
        const isActive = originalIndex === props.activeIndex;
        const isKaraokeActive = props.animationId === 'karaoke' && props.activeIndex >= 0 && originalIndex <= props.activeIndex;
        const wordStyle = resolveCaptionStyle(props.projectStyle, props.caption, word);
        return (
          <View key={`${props.absolute ? 'back' : 'front'}-${word.id}`} style={wordAnimationStyle(props.animationId, isActive, originalIndex, props.loopProgress, style.animation.intensity)}>
            <Text
              allowFontScaling={false}
              style={{
                marginHorizontal: Math.max(1.5, props.fittedFontSize * 0.08),
                color: props.colorOverride ?? (isActive || isKaraokeActive ? wordStyle.activeWordColor : wordStyle.textColor),
                fontFamily: wordStyle.font.family,
                fontSize: props.fittedFontSize,
                fontWeight: wordStyle.font.family.startsWith('Caption-') ? '400' : wordStyle.fontWeight,
                fontStyle: wordStyle.italic ? 'italic' : 'normal',
                lineHeight: props.fittedFontSize * Math.max(1, wordStyle.lineHeight),
                letterSpacing: wordStyle.letterSpacing,
                textAlign: wordStyle.alignment,
                textShadowColor: props.animationId === 'glow-pulse' && !props.colorOverride ? wordStyle.activeWordColor : wordStyle.shadow.color,
                textShadowOffset: { width: wordStyle.shadow.offsetX, height: wordStyle.shadow.offsetY },
                textShadowRadius:
                  props.animationId === 'glow-pulse'
                    ? 7 + 8 * Math.abs(Math.sin(props.loopProgress * Math.PI * 2))
                    : Math.max(wordStyle.shadow.blur, wordStyle.stroke.width),
              }}>
              {props.transformed(word.text)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function wordsForAnimation(words: WordToken[], activeIndex: number, animationId: CaptionAnimationId) {
  if (animationId === 'single-word') return [words[Math.max(0, activeIndex)]].filter(Boolean);
  if (animationId === 'typewriter') return words.slice(0, Math.max(1, activeIndex + 1));
  return words;
}

function wordsMatchCaption(words: WordToken[], captionText: string) {
  if (words.length === 0) return false;
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return normalize(words.map((word) => word.text).join(' ')) === normalize(captionText);
}

function fitCaptionFont(style: CaptionStyle, words: WordToken[], canvas: { width: number; height: number }) {
  const availableWidth = Math.max(24, style.box.width * canvas.width - style.background.paddingX * 2);
  const availableHeight = Math.max(18, style.box.height * canvas.height - style.background.paddingY * 2);
  const maxLines = Math.max(1, style.maxLines);
  const text = words.map((word) => word.text).join(' ');
  const longestWord = Math.max(1, ...words.map((word) => word.text.length));
  const targetCharactersPerLine = Math.max(longestWord, Math.ceil((text.length + words.length * 0.8) / maxLines));
  const widthCap = availableWidth / Math.max(1, targetCharactersPerLine * 0.68);
  const longestWordCap = availableWidth / Math.max(1, longestWord * 0.72);
  const heightCap = availableHeight / Math.max(1, maxLines * Math.max(1, style.lineHeight));
  return clamp(Math.min(style.fontSize, widthCap, longestWordCap, heightCap), 9, style.fontSize);
}

function captionAnimationStyle(
  id: CaptionAnimationId,
  entry: number,
  loop: number,
  intensity: number,
): ViewStyle {
  const eased = 1 - Math.pow(1 - entry, 3);
  switch (id) {
    case 'fade-in':
      return { opacity: eased };
    case 'drop-in':
      return { opacity: entry, transform: [{ translateY: (1 - eased) * -(45 + intensity * 100) }] };
    case 'swing':
      return { opacity: entry, transform: [{ rotate: `${Math.sin((1 - entry) * Math.PI * 3) * (10 + intensity * 30)}deg` }] };
    case 'heartbeat':
      return { transform: [{ scale: 1 + Math.pow(Math.max(0, Math.sin(loop * Math.PI * 4)), 4) * (0.08 + intensity * 0.16) }] };
    case 'flicker':
      return { opacity: entry < 0.9 ? (Math.sin(entry * Math.PI * 9) > -0.15 ? 1 : 0.18) : 1 };
    case 'tilt-in':
      return { opacity: entry, transform: [{ translateX: (1 - eased) * (40 + intensity * 80) }, { rotate: `${(1 - eased) * (20 + intensity * 35)}deg` }] };
    case 'squash':
      return { opacity: entry, transform: [{ scaleX: 0.55 + eased * 0.45 }, { scaleY: 1.55 - eased * 0.55 }] };
    case 'stretch':
      return { opacity: entry, transform: [{ scaleX: 1.45 - eased * 0.45 }, { scaleY: 0.35 + eased * 0.65 }] };
    case 'slide-up':
      return { opacity: entry, transform: [{ translateY: (1 - eased) * (35 + intensity * 80) }] };
    case 'slide-left':
      return { opacity: entry, transform: [{ translateX: (1 - eased) * -(55 + intensity * 120) }] };
    case 'zoom-in':
      return { opacity: entry, transform: [{ scale: 0.15 + eased * 0.85 }] };
    case 'spin-in':
      return { opacity: entry, transform: [{ rotate: `${(1 - eased) * -270}deg` }, { scale: 0.5 + eased * 0.5 }] };
    case 'shake':
      return { transform: [{ translateX: Math.sin(loop * Math.PI * 12) * (4 + intensity * 16) }, { rotate: `${Math.sin(loop * Math.PI * 9) * 2}deg` }] };
    case 'glow-pulse':
      return { transform: [{ scale: 1 + Math.sin(loop * Math.PI * 2) * (0.02 + intensity * 0.06) }] };
    case 'elastic': {
      const wobble = Math.sin(entry * Math.PI * 5) * (1 - entry);
      return { opacity: Math.min(1, entry * 2.5), transform: [{ scaleX: 1 + wobble * (0.35 + intensity) }, { scaleY: 1 - wobble * 0.18 }] };
    }
    case 'flip':
      return { opacity: entry, transform: [{ perspective: 900 }, { rotateY: `${(1 - eased) * 95}deg` }] };
    case 'stomp':
      return { opacity: entry, transform: [{ translateY: (1 - eased) * -(50 + intensity * 100) }, { scale: 1 + Math.sin(entry * Math.PI) * intensity * 0.35 }] };
    default:
      return {};
  }
}

function wordAnimationStyle(
  id: CaptionAnimationId,
  active: boolean,
  index: number,
  loop: number,
  intensity: number,
): ViewStyle {
  if (id === 'wave') return { transform: [{ translateY: Math.sin(loop * Math.PI * 2 + index * 0.85) * (4 + intensity * 18) }] };
  if (!active) return {};
  const pulse = Math.sin(loop * Math.PI);
  if (id === 'pop') return { transform: [{ scale: 0.65 + pulse * (0.5 + intensity) }, { rotate: `${(1 - pulse) * -5}deg` }] };
  if (id === 'bounce') return { transform: [{ translateY: -Math.abs(Math.sin(loop * Math.PI * 2)) * (8 + intensity * 32) }] };
  if (id === 'punch') return { transform: [{ scale: 1 + pulse * (0.3 + intensity * 0.7) }, { rotate: `${Math.sin(loop * Math.PI * 2) * 3}deg` }] };
  if (id === 'word-spin') return { transform: [{ rotate: `${(1 - pulse) * -180}deg` }, { scale: 0.7 + pulse * 0.55 }] };
  if (id === 'word-slide') return { opacity: Math.min(1, pulse * 2), transform: [{ translateX: (1 - pulse) * -(24 + intensity * 70) }] };
  if (id === 'word-flash') return { opacity: 0.45 + pulse * 0.55, transform: [{ scale: 1 + pulse * (0.12 + intensity * 0.2) }] };
  if (id === 'word-jitter') return { transform: [{ translateX: Math.sin(loop * Math.PI * 18) * (2 + intensity * 8) }, { translateY: Math.cos(loop * Math.PI * 14) * (1 + intensity * 5) }] };
  return {};
}

function treatmentOffset(treatment: CaptionStyle['textTreatment']) {
  if (treatment === 'duotone-neon') return { x: -3, y: 1 };
  if (treatment === 'duotone-shadow') return { x: 4, y: 5 };
  return { x: 3, y: 2 };
}

function EmojiEffects(props: { mode: CaptionAnimationId; emojis: string[]; progress: number }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', inset: -42 }}>
      {props.emojis.map((emoji, index) => {
        const phase = (props.progress + index * 0.17) % 1;
        let style: ViewStyle;
        if (props.mode === 'emoji-rain') {
          style = { left: `${10 + index * 19}%`, top: `${phase * 105}%`, opacity: 0.95, transform: [{ rotate: `${phase * 240 - 80}deg` }, { scale: 0.8 + index * 0.08 }] };
        } else if (props.mode === 'emoji-orbit') {
          const angle = props.progress * Math.PI * 2 + (index * Math.PI * 2) / props.emojis.length;
          style = { left: '50%', top: '50%', opacity: 0.95, transform: [{ translateX: Math.cos(angle) * 92 - 13 }, { translateY: Math.sin(angle) * 45 - 13 }, { rotate: `${angle * 57.3 + 90}deg` }] };
        } else {
          const angle = (index * Math.PI * 2) / props.emojis.length;
          const radius = 24 + phase * 76;
          style = { left: '50%', top: '50%', opacity: 1 - phase, transform: [{ translateX: Math.cos(angle) * radius - 13 }, { translateY: Math.sin(angle) * radius - 13 }, { scale: 0.7 + phase * 0.8 }] };
        }
        return (
          <View key={`${emoji}-${index}`} style={[{ position: 'absolute' }, style]}>
            <Text style={{ fontSize: 25 }}>{emoji}</Text>
          </View>
        );
      })}
    </View>
  );
}

function ResizeBar(props: {
  axis: 'width' | 'height';
  side: -1 | 1;
  styleRef: React.RefObject<CaptionStyle>;
  canvas: React.RefObject<CanvasMetrics>;
  onStart?: () => void;
  onChange?: (patch: CaptionStylePatch) => void;
  onEnd?: () => void;
}) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const start = useRef({
    box: { width: 0.86, height: 0.2 },
    position: { x: 0.5, y: 0.78 },
    rotation: 0,
  });
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: () => {
          propsRef.current.onStart?.();
          const style = propsRef.current.styleRef.current;
          start.current = {
            box: { ...style.box },
            position: { ...style.position },
            rotation: style.rotation,
          };
        },
        onPanResponderMove: (_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
          const current = propsRef.current;
          const size = current.canvas.current;
          const radians = (start.current.rotation * Math.PI) / 180;
          const horizontal = current.axis === 'width';
          const axisX = horizontal ? Math.cos(radians) : -Math.sin(radians);
          const axisY = horizontal ? Math.sin(radians) : Math.cos(radians);
          const localDelta = gesture.dx * axisX + gesture.dy * axisY;
          const denominator = horizontal ? size.width : size.height;
          const minimum = horizontal ? 0.16 : 0.06;
          const maximum = horizontal ? 1.5 : 1.1;
          const original = horizontal ? start.current.box.width : start.current.box.height;
          const nextDimension = clamp(original + (localDelta * current.side) / denominator, minimum, maximum);
          const appliedHandleDelta = ((nextDimension - original) * denominator) / current.side;
          const centerPixelDelta = appliedHandleDelta / 2;
          const nextBox = horizontal
            ? { ...start.current.box, width: nextDimension }
            : { ...start.current.box, height: nextDimension };
          const position = clampPositionForBox(
            {
              x: start.current.position.x + (centerPixelDelta * axisX) / size.width,
              y: start.current.position.y + (centerPixelDelta * axisY) / size.height,
            },
            nextBox,
          );

          current.onChange?.(
            horizontal
              ? { box: { width: nextDimension }, position }
              : { box: { height: nextDimension }, position },
          );
        },
        onPanResponderRelease: () => propsRef.current.onEnd?.(),
        onPanResponderTerminate: () => propsRef.current.onEnd?.(),
      }),
    [],
  );

  const vertical = props.axis === 'width';
  return (
    <View
      {...responder.panHandlers}
      collapsable={false}
      style={{
        position: 'absolute',
        zIndex: 20,
        backgroundColor: 'rgba(0,0,0,0.001)',
        ...(vertical
          ? { width: 34, height: 78, top: '50%', marginTop: -39, [props.side < 0 ? 'left' : 'right']: -18 }
          : { width: 78, height: 34, left: '50%', marginLeft: -39, [props.side < 0 ? 'top' : 'bottom']: -18 }),
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <View
        pointerEvents="none"
        style={{
          width: vertical ? 7 : 44,
          height: vertical ? 44 : 7,
          borderRadius: 7,
          backgroundColor: '#DFFF35',
          borderWidth: 2,
          borderColor: '#11140C',
        }}
      />
    </View>
  );
}

function RotateScaleHandle(props: {
  styleRef: React.RefObject<CaptionStyle>;
  canvas: React.RefObject<CanvasMetrics>;
  onStart?: () => void;
  onChange?: (patch: CaptionStylePatch) => void;
  onEnd?: () => void;
}) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const start = useRef({
    distance: 1,
    angle: 0,
    box: { width: 0.86, height: 0.2 },
    fontSize: 48,
    rotation: 0,
  });
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: (event) => {
          propsRef.current.onStart?.();
          const style = propsRef.current.styleRef.current;
          const size = propsRef.current.canvas.current;
          const point = firstTouch(event);
          const center = {
            pageX: size.pageX + style.position.x * size.width,
            pageY: size.pageY + style.position.y * size.height,
          };
          start.current = {
            distance: Math.max(8, distance(center, point)),
            angle: angle(center, point),
            box: { ...style.box },
            fontSize: style.fontSize,
            rotation: style.rotation,
          };
        },
        onPanResponderMove: (event) => {
          const style = propsRef.current.styleRef.current;
          const size = propsRef.current.canvas.current;
          const point = firstTouch(event);
          const center = {
            pageX: size.pageX + style.position.x * size.width,
            pageY: size.pageY + style.position.y * size.height,
          };
          const nextDistance = distance(center, point);
          const scale = nextDistance / start.current.distance;
          const nextBox = {
            width: clamp(start.current.box.width * scale, 0.16, 1.5),
            height: clamp(start.current.box.height * scale, 0.06, 1.1),
          };
          propsRef.current.onChange?.({
            position: clampPositionForBox(style.position, nextBox),
            box: nextBox,
            fontSize: clamp(start.current.fontSize * scale, 10, 240),
            rotation: normalizeDegrees(
              start.current.rotation + shortestAngleDelta(start.current.angle, angle(center, point)),
            ),
          });
        },
        onPanResponderRelease: () => propsRef.current.onEnd?.(),
        onPanResponderTerminate: () => propsRef.current.onEnd?.(),
      }),
    [],
  );

  return (
    <View
      {...responder.panHandlers}
      collapsable={false}
      style={{
        position: 'absolute',
        zIndex: 25,
        right: -23,
        bottom: -23,
        width: 46,
        height: 46,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 23,
        borderWidth: 2,
        borderColor: '#11140C',
        backgroundColor: '#DFFF35',
      }}>
      <Text pointerEvents="none" style={{ color: '#11140C', fontSize: 19, fontWeight: '900' }}>↻</Text>
    </View>
  );
}

function readTouches(event: GestureResponderEvent): TouchPoint[] {
  return event.nativeEvent.touches.map((touch) => ({ pageX: touch.pageX, pageY: touch.pageY }));
}

function firstTouch(event: GestureResponderEvent): TouchPoint {
  const touch = event.nativeEvent.touches[0] ?? event.nativeEvent.changedTouches[0];
  return { pageX: touch?.pageX ?? event.nativeEvent.pageX, pageY: touch?.pageY ?? event.nativeEvent.pageY };
}

function midpoint(a: TouchPoint, b: TouchPoint): TouchPoint {
  return { pageX: (a.pageX + b.pageX) / 2, pageY: (a.pageY + b.pageY) / 2 };
}

function distance(a: TouchPoint, b: TouchPoint) {
  return Math.hypot(b.pageX - a.pageX, b.pageY - a.pageY);
}

function angle(a: TouchPoint, b: TouchPoint) {
  return (Math.atan2(b.pageY - a.pageY, b.pageX - a.pageX) * 180) / Math.PI;
}

function shortestAngleDelta(from: number, to: number) {
  return normalizeDegrees(to - from);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampPositionForBox(
  position: { x: number; y: number },
  box: { width: number; height: number },
) {
  const clampAxis = (value: number, dimension: number) => {
    const minimum = dimension / 2 + 0.025;
    const maximum = 1 - dimension / 2 - 0.025;
    return minimum >= maximum ? 0.5 : clamp(value, minimum, maximum);
  };
  return {
    x: clampAxis(position.x, box.width),
    y: clampAxis(position.y, box.height),
  };
}

function normalizeDegrees(value: number) {
  let result = value % 360;
  if (result > 180) result -= 360;
  if (result < -180) result += 360;
  return result;
}

function fallbackWords(caption: CaptionBlock): WordToken[] {
  const parts = caption.text.split(/\s+/).filter(Boolean);
  const duration = Math.max(1, caption.endMs - caption.startMs);
  return parts.map((text, index) => ({
    id: `${caption.id}-fallback-${index}`,
    text,
    startMs: caption.startMs + (duration * index) / parts.length,
    endMs: caption.startMs + (duration * (index + 1)) / parts.length,
  }));
}
