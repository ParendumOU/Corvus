/**
 * Corvus's own prompt for a card's CVV before "Fill card" fills it, as on the computer: the page
 * cannot see what is typed until the fill. The CVV lives in this dialog's state only: it is handed to
 * the fill once and cleared when the dialog closes; it is never stored, synced or logged.
 */
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { TextField } from '@/components/fields';
import { ThemedText } from '@/components/themed-text';
import { Elevation, Radius, Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { cardTitle, cleanCvv, type SavedCard } from '@/lib/autofill-cards';
import { t } from '@/lib/i18n';

export function CvvDialog({ card, onAnswer }: { card: SavedCard | null; onAnswer: (cvv: string | null) => void }) {
  const theme = useTheme();
  const [typed, setTyped] = useState('');
  const { cvv, ready } = cleanCvv(typed);

  useEffect(() => {
    setTyped('');
  }, [card]);

  const answer = (value: string | null): void => {
    setTyped('');
    onAnswer(value);
  };
  const fill = (): void => {
    if (ready) answer(cvv);
  };

  if (!card) return null;
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={() => answer(null)}>
      <Pressable style={[styles.scrim, { backgroundColor: theme.scrim }]} onPress={() => answer(null)} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <KeyboardAvoidingView style={styles.wrap} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} pointerEvents="box-none">
        <View style={[styles.dialog, { backgroundColor: theme.surfaceRaised }, Elevation.overlay]} accessibilityViewIsModal testID="cvv-dialog">
          <ThemedText type="title" accessibilityRole="header">
            {t('Fill card')}
          </ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            {t('Enter the CVV of {card}', { card: cardTitle(card) })}
          </ThemedText>
          <TextField
            label={t('CVV')}
            help={t('The 3 or 4 digits on the card. Corvus forgets it right after filling.')}
            value={cvv}
            onChangeText={setTyped}
            secureTextEntry
            keyboardType="number-pad"
            maxLength={4}
            autoComplete="off"
            autoCorrect={false}
            autoFocus
            returnKeyType="go"
            onSubmitEditing={fill}
            testID="cvv-input"
          />
          <View style={styles.actions}>
            <Button label={t('Cancel')} kind="text" onPress={() => answer(null)} testID="cvv-cancel" />
            <Button label={t('Fill')} onPress={fill} disabled={!ready} testID="cvv-fill" />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Space.xxl,
  },
  dialog: {
    width: '100%',
    maxWidth: 400,
    gap: Space.lg,
    paddingTop: Space.xxl,
    paddingHorizontal: Space.xxl,
    paddingBottom: Space.lg,
    borderRadius: Radius.xl,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Space.sm,
    marginTop: Space.xs,
  },
});
