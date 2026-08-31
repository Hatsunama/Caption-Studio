import { useEffect, useState } from 'react';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router/stack';
import { setVideoCacheSizeAsync } from 'expo-video';

import { FONT_ASSETS } from '@/lib/font-catalog';
import { chrome } from '@/lib/ui-theme';
import { captureHistoricalProcessExits } from '@/services/local-diagnostics';
import { loadFontLibrary } from '@/services/font-storage';
import { cleanupObsoletePickerCache } from '@/services/storage-policy';

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(FONT_ASSETS);
  const [importedFontsLoaded, setImportedFontsLoaded] = useState(false);

  useEffect(() => {
    void Promise.all([
      setVideoCacheSizeAsync(128 * 1024 * 1024),
      cleanupObsoletePickerCache(),
      captureHistoricalProcessExits(),
    ]).catch((error) => console.error('Caption Studio cache maintenance failed', error));
    void loadFontLibrary()
      .catch((error) => console.error('Imported fonts could not be restored', error))
      .finally(() => setImportedFontsLoaded(true));
  }, []);

  if ((!fontsLoaded && !fontError) || !importedFontsLoaded) return null;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: chrome.background },
        headerTintColor: chrome.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: chrome.background },
      }}>
      <Stack.Screen name="index" options={{ title: 'Caption Studio' }} />
      <Stack.Screen name="privacy" options={{ title: 'Privacy policy' }} />
      <Stack.Screen name="notices" options={{ title: 'Open-source notices' }} />
      <Stack.Screen
        name="editor"
        options={{
          title: 'Editor',
          headerBackButtonDisplayMode: 'minimal',
        }}
      />
    </Stack>
  );
}
