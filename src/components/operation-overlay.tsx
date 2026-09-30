import { useEffect, type ReactNode } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';

export function OperationOverlay(props: {
  visible: boolean;
  onRequestClose?: () => void;
  children: ReactNode;
}) {
  const { visible, onRequestClose } = props;
  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onRequestClose?.();
      return true;
    });
    return () => subscription.remove();
  }, [onRequestClose, visible]);

  if (!visible) return null;
  return (
    <View accessibilityViewIsModal style={[StyleSheet.absoluteFill, { zIndex: 1000, elevation: 1000 }]}>
      {props.children}
    </View>
  );
}
