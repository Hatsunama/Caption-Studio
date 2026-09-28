import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');

test('front trim drag presents its pending source time and edge progress outside the scrolling track', () => {
  assert.match(source, /const \[frontTrimPreview, setFrontTrimPreview\] = useState/);
  assert.match(source, /onTrimPreview=\{\(edge, targetSourceMs\) => \{[\s\S]*setFrontTrimPreview\(/);
  assert.match(source, /onTrimCommit=\{\(edge, targetSourceMs\) => \{[\s\S]*setFrontTrimPreview\(undefined\)/);

  const scrollEnd = source.indexOf('      </ScrollView>\n      {frontTrimPreview');
  assert.ok(scrollEnd > 0, 'feedback must follow the horizontal ScrollView so the right edge can be offscreen');

  const feedback = source.slice(scrollEnd, source.indexOf('{zoomNotice == null', scrollEnd));
  assert.doesNotMatch(feedback, /<ClipFrameThumb/);
  assert.match(feedback, /NEW START/);
  assert.match(feedback, /formatRulerTime\(frontTrimPreview\.sourceStartMs/);
  assert.match(feedback, /frontTrimPreview\.progress/);
  assert.match(feedback, /pointerEvents="none"/);
});
