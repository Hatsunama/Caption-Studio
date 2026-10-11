import assert from 'node:assert/strict';
import test from 'node:test';
import { mountDual, mountFont, pairs } from './keyboard-ui-repair-host.mjs';
import { inputScrollOffset } from '../src/lib/input-viewport.ts';

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

test('Seeker measured 49dp keyboard pane keeps language labels and 44dp editors visible together', async () => {
  const h = mountDual({ targetLanguageLabel: 'Chinese (Simplified)' }, { bottomInsetCovered: true }); await h.flush();
  layout(byId(h, 'dual-caption-root'), 890, 431 / 3); h.act(() => {});
  const viewport = h.all(n => n.props?.collapsable === false)[0];
  h.act(() => layout(viewport, 890, 49));
  const list = h.all(n => n.type === 'FlatList')[0];
  const nativeRow = list.props.children[1];
  const fieldPane = nativeRow.props.children[1];
  for (const languageView of fieldPane.props.children) {
    const label = languageView.props.children[0];
    h.act(() => layout(label, 72, 30));
  }
  for (const [i, language] of ['English', 'Chinese (Simplified)'].entries()) {
    const row = h.all(n => n.type === 'FlatList')[0].props.children[1];
    const languageView = row.props.children[1].props.children[i];
    const input = h.input(0, language);
    assert.equal(languageView.props.style.flexDirection, 'row', 'labels must share a short pane with editors, not consume their vertical budget');
    assert.ok(input.props.style.height >= 44, 'keep an operable input instead of shrinking it');
    const required = verticalPadding(list.props.contentContainerStyle)
      + verticalPadding(row.props.style) + 2 * row.props.style.borderWidth
      + Math.max(30, input.props.style.height);
    assert.ok(required <= 49, `${required}dp must fit the measured native pane, including labels and row chrome`);
  }
  assert.equal(byLabel(h, 'Save dual subtitle edits').props.disabled, true);
});



 
// Keep the older lifecycle, draft, Save, Cancel and close assertions above.
// These regressions additionally prove that LanguageInput passes the enclosing
// native View to the real controller, rather than merely preserving an input ref.
function languageGroup(h, language) {
  const input = h.input(0, language);
  const group = h.all(node => node.type === 'View'
    && Array.isArray(node.props.children)
    && node.props.children.some(child => child?.identity === input.identity))[0];
  assert.ok(group, 'language label and input must have a common native View');
  assert.equal(group.props.children[0].type, 'Text');
  assert.equal(group.props.children[0].props.children, language.toUpperCase());
  return group;
}

async function measuredDual(paneHeight) {
  const h = mountDual({ pairs: pairs(1), targetLanguageLabel: 'Spanish' },
    { realReveal: true, bottomInsetCovered: true,
      window: { width: 890, height: 400, fontScale: 1 } });
  await h.flush();
  h.act(() => layout(byId(h, 'dual-caption-root'), 890, 431 / 3));
  // Select the viewport by its layout handler, before group Views can also
  // acquire collapsable=false. Existing viewport assertions remain untouched.
  const viewport = h.all(node => node.type === 'View'
    && node.props.collapsable === false && typeof node.props.onLayout === 'function')[0];
  assert.ok(viewport, 'editor exposes its measured list viewport');
  h.measure(viewport, { y: 200, height: paneHeight });
  h.act(() => layout(viewport, 890, paneHeight));
  for (const language of ['English', 'Spanish']) {
    h.act(() => layout(languageGroup(h, language).props.children[0], 250, 16));
  }
  return { h, viewport };
}

function clippedGroup(h, viewport, language, paneHeight) {
  const group = languageGroup(h, language), input = h.input(0, language);
  const inline = paneHeight === 49;
  assert.equal(group.props.style.flexDirection, inline ? 'row' : 'column');
  assert.equal(input.props.multiline, true);
  assert.equal(input.props.scrollEnabled, true);
  assert.ok(input.props.style.height >= 44, 'reflow retains an operable multiline editor');
  const groupHeight = inline ? Math.max(30, input.props.style.height)
    : 16 + group.props.style.gap + input.props.style.height;
  assert.ok(groupHeight + 2 <= paneHeight, 'entire group fits with both row borders');
  assert.ok(group.props.ref, 'the enclosing label/input View needs a native reveal ref');
  assert.equal(group.props.ref.current, group.identity, 'host attaches the actual group View');
  assert.notEqual(group.identity, input.identity, 'group measurement must not alias TextInput');
  assert.equal(typeof group.props.onLayout, 'function', 'group relayout renews focused reveal');
  h.reveal.onScroll({ nativeEvent: { contentOffset: { y: 100 } } });
  h.measure(viewport, { y: 200, height: paneHeight });
  const rect = { y: inline ? 196 : 184, height: groupHeight };
  h.measure(group, rect);
  // At 79dp only the stacked label is hidden; TextInput already fits.
  h.measure(input, { y: inline ? rect.y : rect.y + 16 + group.props.style.gap,
    height: input.props.style.height });
  return { group, input, rect, expected: inline ? 96 : 84 };
}

for (const paneHeight of [79, 49]) {
  for (const language of ['English', 'Spanish']) {
    test(`${language}: focus/layout/content reveal the whole label/input group in a ${paneHeight}dp pane`, async () => {
      const { h, viewport } = await measuredDual(paneHeight);
      let fixture = clippedGroup(h, viewport, language, paneHeight);
      const { group, input, rect, expected } = fixture;
      assert.equal(inputScrollOffset(rect, { y: 200, height: paneHeight }, 100), expected);
      if (paneHeight === 79) {
        assert.equal(inputScrollOffset({ y: 205, height: input.props.style.height },
          { y: 200, height: paneHeight }, 100), 100,
        'revealing only TextInput reproduces the clipped-label failure');
      }
      h.act(() => {
        layout(group, 250, rect.height);
        layout(input, 250, input.props.style.height);
        input.props.onContentSizeChange({ nativeEvent: { contentSize: { width: 250, height: 220 } } });
      });
      h.flushRevealFrames();
      assert.equal(h.focusCalls.length, 0, 'unfocused layout/content cannot acquire ownership');
      assert.deepEqual(h.scrollOffsets, []);

      h.act(() => input.props.onFocus());
      assert.equal(h.focusCalls.at(-1), group.identity, 'focus reveals the measured enclosing View');
      h.flushRevealFrames();
      assert.deepEqual(h.scrollOffsets, [expected]);
      const shiftedTop = rect.y - (expected - 100);
      assert.ok(shiftedTop >= 200 && shiftedTop + rect.height <= 200 + paneHeight,
        'computed scroll puts both label and input inside the pane');

      const nativeGroup = group.identity, nativeInput = input.identity;
      h.edit(0, `${language} draft with wrapping\nsecond line`, language);
      for (const event of ['input layout', 'content size', 'group layout']) {
        fixture = clippedGroup(h, viewport, language, paneHeight);
        const previous = h.focusCalls.length, scrolls = h.scrollOffsets.length;
        h.act(() => {
          if (event === 'input layout') layout(fixture.input, 240, fixture.input.props.style.height);
          else if (event === 'content size') fixture.input.props.onContentSizeChange({
            nativeEvent: { contentSize: { width: 240, height: 242 } },
          });
          else layout(fixture.group, 240, fixture.rect.height);
        });
        assert.ok(h.focusCalls.length > previous, `${event} must renew focused group reveal`);
        assert.equal(h.focusCalls.at(-1), nativeGroup);
        h.flushRevealFrames();
        assert.equal(h.scrollOffsets.length, scrolls + 1);
        assert.equal(h.scrollOffsets.at(-1), expected);
        assert.equal(h.input(0, language).identity, nativeInput);
        assert.equal(languageGroup(h, language).identity, nativeGroup);
        assert.equal(h.input(0, language).props.value, `${language} draft with wrapping\nsecond line`);
      }
      h.act(() => h.input(0, language).props.onBlur());
      assert.equal(h.blurCalls.at(-1), nativeGroup, 'blur releases the same group owner');
      const focuses = h.focusCalls.length, scrolls = h.scrollOffsets.length;
      h.act(() => {
        const currentGroup = languageGroup(h, language), currentInput = h.input(0, language);
        layout(currentGroup, 250, rect.height); layout(currentInput, 250, input.props.style.height);
        currentInput.props.onContentSizeChange({ nativeEvent: { contentSize: { width: 250, height: 264 } } });
      });
      h.flushRevealFrames();
      assert.equal(h.focusCalls.length, focuses, 'blur stops layout/content re-reveals');
      assert.equal(h.scrollOffsets.length, scrolls);
    });
  }
}

test('stacked/inline/portrait reflow keeps both group and input native identities and typed drafts', async () => {
  const { h, viewport } = await measuredDual(79);
  const identities = new Map();
  for (const language of ['English', 'Spanish']) {
    const fixture = clippedGroup(h, viewport, language, 79);
    identities.set(language, { group: fixture.group.identity, input: fixture.input.identity });
    h.edit(0, `Unsaved ${language}\nwrapped draft`, language);
  }
  h.act(() => h.input(0, 'Spanish').props.onFocus());
  h.flushRevealFrames();
  for (const paneHeight of [49, 79, 49, 79]) {
    h.act(() => layout(viewport, 890, paneHeight));
    const fixture = clippedGroup(h, viewport, 'Spanish', paneHeight);
    h.act(() => {
      layout(fixture.group, 240, fixture.rect.height);
      layout(fixture.input, 240, fixture.input.props.style.height);
      fixture.input.props.onContentSizeChange({ nativeEvent: { contentSize: { width: 240, height: 242 } } });
    });
    h.flushRevealFrames();
    assert.equal(h.scrollOffsets.at(-1), fixture.expected);
    for (const language of ['English', 'Spanish']) {
      assert.equal(languageGroup(h, language).identity, identities.get(language).group);
      assert.equal(h.input(0, language).identity, identities.get(language).input);
      assert.equal(h.input(0, language).props.value, `Unsaved ${language}\nwrapped draft`);
    }
  }
  h.act(() => layout(byId(h, 'dual-caption-root'), 390, 844));
  h.act(() => layout(byId(h, 'dual-caption-root'), 890, 431 / 3));
  for (const language of ['English', 'Spanish']) {
    assert.equal(languageGroup(h, language).identity, identities.get(language).group);
    assert.equal(h.input(0, language).identity, identities.get(language).input);
    assert.equal(h.input(0, language).props.value, `Unsaved ${language}\nwrapped draft`);
  }
  h.act(() => h.input(0, 'Spanish').props.onBlur());
  assert.equal(h.blurCalls.at(-1), identities.get('Spanish').group);
  // Root/viewport layout can queue frames; blur must cancel the latest owner.
  h.flushRevealFrames();
});

test('group reveal cancels queued frames on blur and drag and rejects a previous language frame', async () => {
  const { h, viewport } = await measuredDual(79);
  const english = clippedGroup(h, viewport, 'English', 79);
  const spanish = clippedGroup(h, viewport, 'Spanish', 79);
  h.act(() => english.input.props.onFocus());
  const staleFrame = h.takeRevealFrame();
  h.act(() => spanish.input.props.onFocus());
  staleFrame();
  assert.equal(h.measuredIdentities.length, 0, 'previous language frame cannot measure');
  h.act(() => english.input.props.onBlur());
  assert.equal(h.pendingRevealFrames, 1, 'old language blur cannot cancel new group ownership');
  h.flushRevealFrames();
  assert.deepEqual(h.scrollOffsets, [84]);
  assert.equal(h.measuredIdentities[0], spanish.group.identity);
  h.act(() => layout(spanish.input, 240, spanish.input.props.style.height));
  assert.equal(h.pendingRevealFrames, 1);
  h.reveal.onScrollBeginDrag();
  assert.equal(h.pendingRevealFrames, 0, 'drag cancels automatic reveal');
  h.act(() => spanish.input.props.onContentSizeChange({
    nativeEvent: { contentSize: { width: 240, height: 242 } },
  }));
  assert.equal(h.pendingRevealFrames, 1);
  h.act(() => spanish.input.props.onBlur());
  assert.equal(h.pendingRevealFrames, 0, 'blur cancels queued group reveal');
  h.flushRevealFrames();
  assert.deepEqual(h.scrollOffsets, [84]);
});

test('delayed group and viewport measurements cannot scroll after blur, focus transfer or detach', async () => {
  const { h, viewport } = await measuredDual(79);
  const english = clippedGroup(h, viewport, 'English', 79);
  const spanish = clippedGroup(h, viewport, 'Spanish', 79);
  const deliver = (callback, rect) => callback(0, rect.y, 250, rect.height);
  h.measure(english.group, english.rect, true);
  h.act(() => english.input.props.onFocus());
  h.flushRevealFrames();
  const afterBlur = h.takeMeasurement(english.group);
  h.act(() => english.input.props.onBlur());
  deliver(afterBlur, english.rect);
  assert.deepEqual(h.scrollOffsets, [], 'blur invalidates delayed group measurement');

  h.act(() => english.input.props.onFocus());
  h.flushRevealFrames();
  const afterTransfer = h.takeMeasurement(english.group);
  h.act(() => spanish.input.props.onFocus());
  deliver(afterTransfer, english.rect);
  assert.deepEqual(h.scrollOffsets, [], 'focus transfer invalidates old group callback');
  h.measure(viewport, { y: 200, height: 79 }, true);
  h.flushRevealFrames();
  const afterDetach = h.takeMeasurement(viewport);
  h.revealController.detach();
  deliver(afterDetach, { y: 200, height: 79 });
  assert.deepEqual(h.scrollOffsets, [], 'detach invalidates delayed viewport measurement');
});
