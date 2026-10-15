import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');

function feedbackOutsideScrollers(text) {
  const ast = ts.createSourceFile('timeline.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const feedback = [];
  const scrollers = [];
  function visit(node) {
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement;
      if (opening.attributes.properties.some((property) => ts.isJsxAttribute(property) &&
        property.name.getText(ast) === 'testID' && property.initializer?.text === 'front-trim-feedback')) feedback.push(node);
      if (['ScrollView', 'TimelineNativeScrollView'].includes(opening.tagName.getText(ast))) scrollers.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(feedback.length, 1);
  for (let parent = feedback[0].parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent)) assert.ok(!['ScrollView', 'TimelineNativeScrollView'].includes(
      parent.openingElement.tagName.getText(ast)), 'feedback must not scroll with timeline content or labels');
  }
  assert.ok(scrollers.some((node) => node.end <= feedback[0].pos), 'feedback must follow the timeline scrollers');
  return feedback[0].getText(ast);
}

test('front trim drag presents its pending source time and edge progress outside the scrolling track', () => {
  assert.match(source, /const \[frontTrimPreview, setFrontTrimPreview\] = useState/);
  assert.match(source, /onTrimPreview=\{\(edge, targetSourceMs\) => \{[\s\S]*setFrontTrimPreview\(/);
  assert.match(source, /onTrimCommit=\{\(edge, targetSourceMs\) => \{[\s\S]*setFrontTrimPreview\(undefined\)/);

  const feedback = feedbackOutsideScrollers(source);
  assert.doesNotMatch(feedback, /<ClipFrameThumb/);
  assert.match(feedback, /NEW START/);
  assert.match(feedback, /formatRulerTime\(frontTrimPreview\.sourceStartMs/);
  assert.match(feedback, /frontTrimPreview\.progress/);
  assert.match(feedback, /pointerEvents="none"/);
});

for (const tag of ['ScrollView', 'TimelineNativeScrollView']) {
  test(`${tag}: the placement guard accepts a sibling overlay and rejects a nested overlay`, () => {
    assert.doesNotThrow(() => feedbackOutsideScrollers(`<View><${tag}></${tag}><View testID="front-trim-feedback"></View></View>`));
    assert.throws(() => feedbackOutsideScrollers(`<View><${tag}><View testID="front-trim-feedback"></View></${tag}></View>`),
      /feedback must not scroll/);
  });
}
