import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';

import { createFontLibraryController } from '@/lib/font-library-controller';
import {
  importFontFromDevice,
  loadFontLibrary,
  saveFontFavorites,
  saveRecentFonts,
} from '@/services/font-storage';

export function useFontLibrary(visible: boolean) {
  const [controller] = useState(() => createFontLibraryController(
    { importFontFromDevice, loadFontLibrary, saveFontFavorites, saveRecentFonts },
    (title, message) => Alert.alert(title, message),
  ));
  const library = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Layout cleanup revokes ownership at close/unmount before passive effects.
  useLayoutEffect(() => {
    if (visible) return controller.open();
  }, [controller, visible]);
  return {
    ...library,
    importFont: controller.importFont,
    rememberFont: controller.rememberFont,
    toggleFavorite: controller.toggleFavorite,
  };
}
