import { useEffect, useState } from 'react';
import { Dimensions, Keyboard, Platform } from 'react-native';

/**
 * How much of the bottom of the screen the on-screen keyboard covers (0 when it is down), for a
 * screen that keeps something pinned above it (the chat's message box). The app draws edge to edge,
 * so the window is the whole screen and the keyboard's top is measured against it; the layout
 * KeyboardAvoidingView does is not enough there on Android.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (e) => {
      const screen = Dimensions.get('screen').height;
      const top = e.endCoordinates.screenY;
      setInset(Math.max(0, top > 0 && top < screen ? screen - top : e.endCoordinates.height));
    });
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setInset(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return inset;
}
