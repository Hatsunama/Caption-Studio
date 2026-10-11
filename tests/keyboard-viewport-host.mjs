export function keyboardViewportHostProps(type, props, bottomInsetCovered = false) {
  if (type !== 'KeyboardViewport' || typeof props?.children !== 'function') return props;
  return {
    ...props,
    children: props.children({ safeAreaBottom: bottomInsetCovered ? 0 : props.safeAreaBottom ?? 0 }),
  };
}
