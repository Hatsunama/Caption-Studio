import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { LEGAL_NOTICE_DOCUMENTS, type LegalNoticeDocument } from '@/services/legal-notices';
import { chrome } from '@/lib/ui-theme';

export default function NoticesScreen() {
  const [selected, setSelected] = useState<LegalNoticeDocument>(LEGAL_NOTICE_DOCUMENTS[0]);
  const [loaded, setLoaded] = useState({ documentId: '', content: '', error: '' });

  useEffect(() => {
    let active = true;
    void selected.load()
      .then((value) => { if (active) setLoaded({ documentId: selected.id, content: value, error: '' }); })
      .catch((caught) => { if (active) setLoaded({ documentId: selected.id, content: '', error: caught instanceof Error ? caught.message : 'The notice could not be loaded.' }); });
    return () => { active = false; };
  }, [selected]);

  const loading = loaded.documentId !== selected.id;

  return (
    <View style={{ flex: 1, backgroundColor: chrome.background }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 14, gap: 8 }}>
        {LEGAL_NOTICE_DOCUMENTS.map((document) => (
          <Pressable
            key={document.id}
            accessibilityRole="button"
            accessibilityState={{ selected: selected.id === document.id }}
            onPress={() => setSelected(document)}
            style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: chrome.radius.pill, backgroundColor: selected.id === document.id ? chrome.accent : chrome.surfaceRaised }}>
            <Text style={{ color: selected.id === document.id ? chrome.accentInk : chrome.text, fontSize: 13, fontWeight: '600' }}>{document.title}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 48 }}>
        <Text selectable style={{ color: chrome.text, fontSize: 22, fontWeight: '700', marginBottom: 14 }}>{selected.title}</Text>
        {loading ? <ActivityIndicator color={chrome.accent} /> : null}
        {!loading && loaded.error ? <Text selectable style={{ color: chrome.dangerText, fontSize: 14, lineHeight: 21 }}>{loaded.error}</Text> : null}
        {!loading && loaded.content ? <Text selectable style={{ color: chrome.muted, fontSize: 13, lineHeight: 20 }}>{loaded.content}</Text> : null}
      </ScrollView>
    </View>
  );
}
