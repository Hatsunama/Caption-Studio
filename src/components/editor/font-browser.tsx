import { useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { chrome } from '@/lib/ui-theme';
import { useFontLibrary } from '@/hooks/use-font-library';
import { KeyboardViewport } from '@/components/editor/keyboard-viewport';
import { BUILT_IN_FONT_CHOICES, TWO_COLOR_FONT_COUNT, type FontChoice } from '@/lib/font-catalog';
import { type FontColors } from '@/lib/font-style-choice';
import { FontColorPicker } from './font-color-picker';


type Filter = 'all' | 'favorites' | 'recent' | 'imported';

export function FontBrowser(props: {
  visible: boolean;
  previewText: string;
  onClose: () => void;
  onSelect: (choice: FontChoice, colors: FontColors) => void;
  onBackRequestChange?: (request: (() => void) | undefined) => void;
}) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [rootSize, setRootSize] = useState<{ width: number; height: number }>();
  const [toolsOpen, setToolsOpen] = useState(false);
  const width = rootSize?.width ?? window.width;
  const height = (rootSize?.height ?? window.height) - Math.max(20, insets.top) - insets.bottom;
  const compact = height < 500 || width > height * 1.2;
  const [draftChoice, setDraftChoice] = useState<FontChoice>();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const { imported, favorites, recent, importFont: importLibraryFont, rememberFont, toggleFavorite } = useFontLibrary(props.visible);
  const shortWide = width >= 600 && height < 260;
  const allFonts = useMemo(() => [...imported, ...BUILT_IN_FONT_CHOICES], [imported]);
  const fonts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return allFonts.filter((choice) => {
      if (query && !`${choice.name} ${choice.mood}`.toLowerCase().includes(query)) return false;
      if (filter === 'favorites') return favorites.includes(choice.font.id);
      if (filter === 'recent') return recent.includes(choice.font.id);
      if (filter === 'imported') return choice.font.source === 'imported';
      return true;
    });
  }, [allFonts, favorites, filter, recent, search]);

  const closeBrowser = () => {
    setDraftChoice(undefined);
    props.onClose();
  };
  const goBack = () => {
    if (draftChoice) setDraftChoice(undefined);
    else if (compact && toolsOpen) setToolsOpen(false);
    else closeBrowser();
  };
  useEffect(() => {
    props.onBackRequestChange?.(props.visible ? goBack : undefined);
    return () => props.onBackRequestChange?.(undefined);
  });
  const saveFont = (choice: FontChoice, colors: FontColors) => {
    rememberFont(choice.font.id);
    setDraftChoice(undefined);
    props.onSelect(choice, colors);
  };

  const importFont = async () => {
    if (await importLibraryFont()) setFilter('imported');
  };

  const tools = (
    <View style={{ gap: 12 }}>
      {compact ? <Text style={{ color: chrome.muted, fontSize: 13 }}>{BUILT_IN_FONT_CHOICES.length} built-in choices. Only {TWO_COLOR_FONT_COUNT} use optional two-color styling.</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
        <FilterChip label="All" active={filter === 'all'} onPress={() => setFilter('all')} />
        <FilterChip label="★ Favorites" active={filter === 'favorites'} onPress={() => setFilter('favorites')} />
        <FilterChip label="Recent" active={filter === 'recent'} onPress={() => setFilter('recent')} />
        <FilterChip label="My Fonts" active={filter === 'imported'} onPress={() => setFilter('imported')} />
      </View>
      <Pressable accessibilityRole="button" onPress={importFont}
        style={{ minHeight: 48, padding: 16, borderRadius: chrome.radius.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: chrome.accent }}>
        <Text style={{ flex: 1, color: chrome.accentInk, fontWeight: '700' }}>Import unlimited .ttf or .otf fonts</Text>
        <Text style={{ color: chrome.accentInk, fontSize: 22 }}>＋</Text>
      </Pressable>
    </View>
  );

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={goBack}>
      <KeyboardViewport safeAreaBottom={insets.bottom} style={{ flex: 1 }}>
      {({ safeAreaBottom }) => (
      <View testID="font-browser-root" onLayout={({ nativeEvent: { layout } }) => setRootSize({ width: layout.width, height: layout.height })}
        style={{ flex: 1, minHeight: 0, backgroundColor: chrome.background, paddingTop: Math.max(shortWide ? 8 : 20, insets.top), paddingBottom: safeAreaBottom, paddingLeft: insets.left, paddingRight: insets.right }}>
        <View style={{ flex: 1, minHeight: 0, flexDirection: shortWide ? 'row' : 'column' }} pointerEvents={draftChoice ? 'none' : 'auto'} accessibilityElementsHidden={Boolean(draftChoice)} importantForAccessibility={draftChoice ? 'no-hide-descendants' : 'auto'}>
        <View style={{ paddingHorizontal: shortWide ? 8 : 20, gap: compact ? 4 : 12, width: shortWide ? Math.min(320 * window.fontScale, width * 0.5) : undefined, flexShrink: 0, flexDirection: 'column' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={shortWide ? 1 : undefined} style={{ color: chrome.text, fontSize: compact ? 22 : 26, fontWeight: '700' }}>All Fonts</Text>
              {!compact ? <Text style={{ color: chrome.muted, fontSize: 13 }}>{BUILT_IN_FONT_CHOICES.length} built-in choices. Only {TWO_COLOR_FONT_COUNT} use optional two-color styling.</Text> : null}
            </View>
            {compact ? <Pressable accessibilityRole="button" accessibilityLabel="Font filters and import" accessibilityState={{ expanded: toolsOpen }}
              onPress={() => setToolsOpen((value) => !value)} style={{ minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' }}>
              <Text style={{ color: chrome.accent, fontSize: 14, fontWeight: '700' }}>Filters</Text>
            </Pressable> : null}
            <Pressable accessibilityRole="button" onPress={closeBrowser} hitSlop={12} style={{ minHeight: 44, justifyContent: 'center' }}>
              <Text style={{ color: chrome.accent, fontSize: 16, fontWeight: '700' }}>Done</Text>
            </Pressable>
          </View>
          <TextInput
            disableFullscreenUI
            accessibilityLabel="Search fonts by name or mood"
            value={search}
            onChangeText={setSearch}
            placeholder="Search name or mood"
            placeholderTextColor={chrome.muted}
            style={{ minWidth: 0, height: 48, borderRadius: chrome.radius.md, paddingHorizontal: 15, color: chrome.text, backgroundColor: chrome.surface }}
          />
          {!compact ? tools : null}
        </View>

        <FlatList
          style={{ flex: 1, minHeight: 0, minWidth: 0 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListHeaderComponent={compact && toolsOpen ? tools : null}
          contentInsetAdjustmentBehavior="automatic"
          data={fonts}
          keyExtractor={(item) => item.font.id}
          contentContainerStyle={{ padding: shortWide ? 8 : 20, gap: 10, paddingBottom: shortWide ? 8 : 48 }}
          ListEmptyComponent={<Text style={{ color: chrome.muted, textAlign: 'center', padding: 30 }}>No fonts match this view.</Text>}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => setDraftChoice(item)}
              style={{ minHeight: shortWide ? 52 : 94, flexDirection: shortWide ? 'row' : 'column', alignItems: shortWide ? 'center' : undefined, justifyContent: 'center', gap: shortWide ? 12 : 7, paddingVertical: shortWide ? 4 : undefined, paddingHorizontal: shortWide ? 8 : 16, borderRadius: chrome.radius.lg, backgroundColor: chrome.surface }}>
              <View style={{ width: shortWide ? 164 : undefined, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1, minWidth: 0, flexDirection: shortWide ? 'column' : 'row', gap: shortWide ? 2 : 7, alignItems: shortWide ? 'flex-start' : 'center' }}>
                  <Text numberOfLines={shortWide ? 1 : undefined} style={{ color: chrome.text, fontSize: 12, fontWeight: '700' }}>{item.name}</Text>
                  {!shortWide ? <Text numberOfLines={1} style={{ flexShrink: 1, color: chrome.muted, fontSize: 10 }}>{item.mood}</Text> : null}
                  {item.treatment !== 'solid' ? (
                    <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: chrome.radius.pill, backgroundColor: chrome.purpleFill }}>
                      <Text style={{ color: chrome.purpleText, fontSize: 8, fontWeight: '700' }}>2 COLOR</Text>
                    </View>
                  ) : null}
                </View>
                <Pressable
                  hitSlop={12}
                  style={shortWide ? { minHeight: 44, justifyContent: 'center' } : undefined}
                  onPress={(event) => {
                    event.stopPropagation();
                    toggleFavorite(item.font.id);
                  }}>
                  <Text style={{ color: favorites.includes(item.font.id) ? chrome.accent : chrome.muted, fontSize: 20 }}>★</Text>
                </Pressable>
              </View>
              <FontPreview horizontal={shortWide} choice={item} text={props.previewText || 'Make every word count'} />
            </Pressable>
          )}
        />
        </View>
        {draftChoice ? (
          <FontColorPicker
            keyboardManaged
            safeAreaBottom={safeAreaBottom}
            choice={draftChoice}
            previewText={props.previewText}
            onBack={() => setDraftChoice(undefined)}
            onSave={(colors) => saveFont(draftChoice, colors)}
          />
        ) : null}
      </View>
      )}
      </KeyboardViewport>
    </Modal>
  );
}

function FontPreview(props: { choice: FontChoice; text: string; horizontal?: boolean }) {
  const primary = props.choice.colors?.primary ?? '#F7F8FA';
  const secondary = props.choice.colors?.secondary;
  return (
    <View style={{ flex: props.horizontal ? 1 : undefined, minWidth: 0, minHeight: 36, justifyContent: 'center' }}>
      {secondary ? (
        <Text
          numberOfLines={1}
          style={{ position: 'absolute', left: 2, top: 4, right: -2, color: secondary, fontFamily: props.choice.font.family, fontSize: 25, fontWeight: '400' }}>
          {props.text}
        </Text>
      ) : null}
      <Text numberOfLines={1} style={{ color: primary, fontFamily: props.choice.font.family, fontSize: 25, fontWeight: '400' }}>
        {props.text}
      </Text>
    </View>
  );
}

function FilterChip(props: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: props.active }} onPress={props.onPress} style={{ flexGrow: 1, minWidth: 60, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, borderRadius: chrome.radius.pill, backgroundColor: props.active ? '#1A3A48' : chrome.surfaceRaised }}>
      <Text style={{ color: props.active ? chrome.accent : chrome.text, fontSize: 12, fontWeight: props.active ? '700' : '500' }}>{props.label}</Text>
    </Pressable>
  );
}
