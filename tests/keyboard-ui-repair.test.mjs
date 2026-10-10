import assert from 'node:assert/strict';
import test from 'node:test';
import { mountDual, mountFont, pairs } from './keyboard-ui-repair-host.mjs';

// Execute the complete TSX components using the same deterministic host pattern
// as font-color-picker-flow and dual-caption-editor-performance. These are UI
// budget and event/state regressions, not a native Yoga/IME screenshot test.
const layout = (node, width, height) => node.props.onLayout({ nativeEvent: { layout: { width, height } } });
const byId = (h, id) => h.all(n => n.props?.testID === id)[0];
const byLabel = (h, label) => h.all(n => n.props?.accessibilityLabel === label)[0];
const verticalPadding = s => (s.paddingTop ?? s.paddingVertical ?? s.padding ?? 0)
  + (s.paddingBottom ?? s.paddingVertical ?? s.padding ?? 0);

function expectFocusedLifecycle(h, input) {
  input.props.onLayout?.({ nativeEvent: { layout: { width: 200, height: 44 } } });
  input.props.onContentSizeChange?.({ nativeEvent: { contentSize: { width: 200, height: 220 } } });
  assert.equal(h.focusCalls.length, 0, 'unfocused fields must not steal reveal ownership');
  input.props.onFocus();
  const nativeInput = h.focusCalls[0];
  assert.ok(nativeInput, 'reveal must receive the mounted native input');
  assert.equal(typeof input.props.onLayout, 'function', 'rotation/keyboard relayout must re-reveal');
  assert.equal(typeof input.props.onContentSizeChange, 'function', 'typing/wrapping must re-reveal');
  input.props.onLayout({ nativeEvent: { layout: { width: 240, height: 44 } } });
  input.props.onContentSizeChange({ nativeEvent: { contentSize: { width: 240, height: 242 } } });
  assert.equal(h.focusCalls.length, 3);
  assert.ok(h.focusCalls.every(value => value === nativeInput));
  input.props.onBlur();
  assert.equal(h.blurCalls[0], nativeInput);
  input.props.onLayout({ nativeEvent: { layout: { width: 200, height: 44 } } });
  input.props.onContentSizeChange({ nativeEvent: { contentSize: { width: 200, height: 44 } } });
  assert.equal(h.focusCalls.length, 3, 'blur ends field lifecycle ownership');
}

test('Bungee label and unchanged 25dp preview fit a measured 75dp landscape result pane', () => {
  const h = mountFont('font-browser', 'FontBrowser', {
    visible: true, previewText: 'Make every word count', onClose() {}, onSelect() {},
  }, { resolveChildren: true, window: { width: 890, height: 400, fontScale: 1 }, bottomInsetCovered: true });
  layout(byId(h, 'font-browser-root'), 890, 431 / 3); h.render();
  const list = h.get('FlatList');
  const card = list.props.renderItem({ item: list.props.data[0] });
  assert.equal(card.props.style.flexDirection, 'row', 'short results need a horizontal card');
  assert.ok(card.props.style.minHeight + verticalPadding(list.props.contentContainerStyle) <= 75);
  const children = card.props.children;
  assert.equal(children[0].props.children[0].props.children[0].props.children, 'Bungee');
  // The FontPreview component itself supplies the text geometry; call it without
  // hooks to inspect its actual rendered text, not a source-string contract.
  const preview = children[1].type(children[1].props);
  assert.equal(preview.props.children[1].props.style.fontSize, 25);
  assert.equal(preview.props.children[1].props.children, 'Make every word count');
  assert.ok(preview.props.style.minHeight >= 36);
  layout(byId(h, 'font-browser-root'), 390, 844); h.render();
  const portrait = h.get('FlatList');
  assert.equal(portrait.props.renderItem({ item: portrait.props.data[0] }).props.style.minHeight, 94);
  assert.equal(portrait.props.contentContainerStyle.padding, 20);
});

test('Hex re-reveals after focus on layout and content changes, then releases on blur', () => {
  let saved, backs = 0;
  const choice = { name: 'Bungee', font: { id: 'bungee', family: 'Bungee' }, treatment: 'solid' };
  const h = mountFont('font-color-picker', 'FontColorPicker', {
    choice, previewText: 'Caption', onBack() { backs++; }, onSave(colors) { saved = colors; }, keyboardManaged: true,
  }, { resolveChildren: true });
  expectFocusedLifecycle(h, byLabel(h, 'Hex color'));
  byLabel(h, 'Hex color').props.onChangeText('#123456'); h.render();
  layout(byId(h, 'font-color-picker-root'), 890, 431 / 3); h.render();
  assert.equal(byLabel(h, 'Hex color').props.value, '#123456');
  const buttons = h.all(n => n.props?.accessibilityRole === 'button');
  assert.equal(buttons.length, 2);
  buttons[1].props.onPress(); assert.equal(saved.primary, '#123456');
  saved = undefined; buttons[0].props.onPress(); assert.equal(backs, 1); assert.equal(saved, undefined);
  byLabel(h, 'Hex color').props.onChangeText('#BAD'); h.render();
  byLabel(h, 'Hex color').props.onBlur(); h.render();
  assert.equal(byLabel(h, 'Hex color').props.value, '#123456', 'invalid hex does not replace the saved color');
});

for (const target of ['Chinese', 'Spanish']) {
  for (const paneHeight of [75, 80, 100]) {
    test(`${target}: both 44dp multiline regions fit the ${paneHeight}dp measured landscape pane`, async () => {
      const h = mountDual({ targetLanguageLabel: target }, { bottomInsetCovered: true }); await h.flush();
      layout(byId(h, 'dual-caption-root'), 890, 431 / 3); h.act(() => {});
      const viewport = h.all(n => n.props?.collapsable === false)[0];
      h.act(() => layout(viewport, 890, paneHeight));
      const list = h.all(n => n.type === 'FlatList')[0];
      const row = list.props.renderItem({ item: h.props.pairs[0], index: 0 });
      // Rendered native row is the actual child after expanding memo components.
      const nativeRow = list.props.children[1];
      assert.equal(nativeRow.props.style.flexDirection, 'row', 'metadata must not stack above the fields');
      const metadata = nativeRow.props.children[0];
      assert.equal(metadata.type, 'ScrollView', 'cue controls and warnings remain reachable');
      assert.equal(metadata.props.scrollEnabled, true);
      for (const language of ['English', target]) {
        const input = h.input(0, language);
        assert.equal(input.props.multiline, true); assert.equal(input.props.scrollEnabled, true);
        assert.equal(input.props.style.fontSize, 16); assert.equal(input.props.style.lineHeight, 22);
        assert.ok(input.props.style.height >= 44);
        const languageView = nativeRow.props.children[1].props.children[language === 'English' ? 0 : 1];
        const label = languageView.props.children[0];
        h.act(() => layout(label, 250, 16));
        const required = verticalPadding(list.props.contentContainerStyle)
          + verticalPadding(nativeRow.props.style) + 2 * nativeRow.props.style.borderWidth
          + 16 + languageView.props.style.gap + h.input(0, language).props.style.height;
        assert.ok(required <= paneHeight, `${required}dp of field chrome must fit ${paneHeight}dp`);
      }
      assert.ok(row.props.paired, 'both languages stay side by side');
    });
  }
}

test('dual focused lifecycle, wrapping, rotation, failed Save and retry retain both field identities and drafts', async () => {
  const h = mountDual(); await h.flush();
  expectFocusedLifecycle(h, h.input(0));
  h.focusCalls.length = 0; h.blurCalls.length = 0;
  expectFocusedLifecycle(h, h.input(0, 'Chinese'));
  h.edit(0, 'Long source '.repeat(35)); h.edit(0, 'Chinese draft '.repeat(30), 'Chinese');
  const first = h.input(0).identity, second = h.input(0, 'Chinese').identity;
  for (const [width, height] of [[890, 431 / 3], [390, 844], [890, 160]]) {
    h.act(() => layout(byId(h, 'dual-caption-root'), width, height));
    assert.equal(h.input(0).identity, first); assert.equal(h.input(0, 'Chinese').identity, second);
  }
  h.press('Save dual subtitle edits'); await h.flush();
  assert.equal(h.calls.saves.length, 1);
  assert.equal(h.input(0).props.value, 'Long source '.repeat(35));
  assert.equal(h.input(0, 'Chinese').props.value, 'Chinese draft '.repeat(30));
  const saved = [];
  h.update({ onSave: async edits => { saved.push(edits); return true; } });
  h.press('Save dual subtitle edits'); await h.flush();
  assert.equal(saved.length, 1); assert.ok(saved[0][0].primaryChanged); assert.ok(saved[0][0].translatedChanged);
  assert.equal(h.input(0).identity, first); assert.equal(h.input(0, 'Chinese').identity, second);
});

test('failed/stale/skip metadata does not change language ownership or block cancellation and close', async () => {
  const data = pairs(1); data[0].translation.status = 'failed'; data[0].translation.failureReason = 'offline';
  const h = mountDual({ pairs: data }); await h.flush();
  h.act(() => layout(byId(h, 'dual-caption-root'), 890, 143));
  h.edit(0, 'Edited source');
  assert.equal(h.input(0, 'Chinese').props.value, 'Translation 0');
  h.press('Close dual subtitle editor'); h.choose('Keep editing');
  assert.equal(h.calls.close, 0); assert.equal(h.input(0).props.value, 'Edited source');
  h.update({ busy: true }); h.press('Cancel'); assert.equal(h.calls.cancel, 1);
  h.update({ busy: false, errorMessage: 'Stopped', retryErrorAvailable: true });
  h.press('Retry interrupted translation'); h.press('Close');
  assert.equal(h.calls.retry, 1); assert.equal(h.calls.dismiss, 1);
  h.update({ errorMessage: undefined });
  h.press('Close dual subtitle editor'); h.choose('Discard'); await h.flush();
  assert.equal(h.calls.close, 1);
});

test('watermark has the same focused-field lifecycle and retains add/close semantics', () => {
  const added = []; let closed = 0;
  const h = mountFont('watermark-sheet', 'WatermarkSheet', {
    visible: true, watermarks: [], maxWatermarks: 5, onAdd: value => added.push(value),
    onSelect() {}, onRemove() {}, onClose() { closed++; },
  }, { resolveChildren: true });
  expectFocusedLifecycle(h, byLabel(h, 'Watermark words'));
  byLabel(h, 'Watermark words').props.onChangeText('  Label  '); h.render();
  layout(byId(h, 'watermark-sheet-root'), 890, 143); h.render();
  assert.equal(byLabel(h, 'Watermark words').props.value, '  Label  ');
  byLabel(h, 'Add watermark').props.onPress(); h.render();
  assert.deepEqual(added, ['Label']); assert.equal(byLabel(h, 'Watermark words').props.value, '');
  byLabel(h, 'Watermark words').props.onChangeText('discard'); h.render();
  byLabel(h, 'Close watermarks').props.onPress(); h.render();
  assert.equal(closed, 1); assert.equal(byLabel(h, 'Watermark words').props.value, '');
});
