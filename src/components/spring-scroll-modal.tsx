import { Modal, Platform, type ModalProps } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

/** Android Modals have a separate native window. Keep the original modal and
 * its lifecycle; install its local gesture root without changing the child tree.
 * https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/fundamentals/installation/
 */
export function SpringScrollModal({ children, ...props }: ModalProps) {
  return <Modal {...props}>
    {Platform.OS === 'android'
      ? <GestureHandlerRootView style={{ flex: 1 }}>{children}</GestureHandlerRootView>
      : children}
  </Modal>;
}
