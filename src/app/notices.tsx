import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { LEGAL_NOTICE_DOCUMENTS, type LegalNoticeDocument } from '@/services/legal-notices';

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
    <View style={{ flex: 1, backgroundColor: '#090B0E' }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 14, gap: 8 }}>
        {LEGAL_NOTICE_DOCUMENTS.map((document) => (
          <Pressable
            key={document.id}
            accessibilityRole="button"
            accessibilityState={{ selected: selected.id === document.id }}
            onPress={() => setSelected(document)}
            style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 12, backgroundColor: selected.id === document.id ? '#DFFF35' : '#20262E' }}>
            <Text style={{ color: selected.id === document.id ? '#11140C' : '#F7F8FA', fontSize: 12, fontWeight: '800' }}>{document.title}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 48 }}>
        <Text selectable style={{ color: '#F7F8FA', fontSize: 20, fontWeight: '900', marginBottom: 14 }}>{selected.title}</Text>
        {loading ? <ActivityIndicator color="#DFFF35" /> : null}
        {!loading && loaded.error ? <Text selectable style={{ color: '#FFBBC8', fontSize: 14, lineHeight: 21 }}>{loaded.error}</Text> : null}
        {!loading && loaded.content ? <Text selectable style={{ color: '#B8C1CC', fontSize: 13, lineHeight: 20 }}>{loaded.content}</Text> : null}
      </ScrollView>
    </View>
  );
}
