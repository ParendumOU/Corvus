/**
 * The pieces of the Assist chat (app/chat/[id].tsx): the person's message as a bubble, the
 * computer's answer with its state, sources and follow-up questions, the composer pinned at the
 * bottom, and the picker of the computer that answers.
 */
import type { AskSource, DeviceInfo } from '@corvus/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, type TextStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AnswerText } from '@/components/answer-text';
import { Button } from '@/components/button';
import { Favicon } from '@/components/favicon';
import { CorvusMark, Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Elevation, Layout, Radius, Space, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { isOnline } from '@/lib/chat';
import { ago, platformName } from '@/lib/format';
import { t } from '@/lib/i18n';
import { openInApp, openInBrowser } from '@/lib/open-url';
import { tabHost } from '@/lib/replica';

/** Space above and under the composer's text, inside its box. */
const COMPOSER_PAD = 8;

const NO_OUTLINE = Platform.select<TextStyle>({ web: { outlineStyle: 'none' } as unknown as TextStyle, default: {} });

/** What the person asked, on the right. */
export function UserBubble({ text, testID }: { text: string; testID?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.userRow} testID={testID}>
      <View style={[styles.userBubble, { backgroundColor: theme.accentContainer }]}>
        <ThemedText type="body" style={{ color: theme.onAccentContainer }} selectable>
          {text}
        </ThemedText>
      </View>
    </View>
  );
}

/** Three dots that take turns lighting up, while a computer thinks. */
export function ThinkingDots({ color }: { color: string }) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(value, { toValue: 3, duration: 1200, useNativeDriver: Platform.OS !== 'web' }));
    loop.start();
    return () => loop.stop();
  }, [value]);
  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {[0, 1, 2].map((i) => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            { backgroundColor: color, opacity: value.interpolate({ inputRange: [0, i, i + 0.5, i + 1, 3], outputRange: [0.3, 0.3, 1, 0.3, 0.3], extrapolate: 'clamp' }) },
          ]}
        />
      ))}
    </View>
  );
}

export type AnswerTone = 'progress' | 'muted' | 'warning' | 'error';

/**
 * The computer's side of one turn: who answers and how it stands, the answer as it is written,
 * its sources as cards, and what to do when something went wrong.
 */
export function AnswerBlock({
  who,
  status,
  tone,
  thinking,
  answer,
  streaming,
  sources,
  note,
  actions,
  children,
  testID,
  statusTestID,
  answerTestID,
}: {
  who: string;
  status: string;
  tone: AnswerTone;
  thinking?: boolean;
  answer: string;
  streaming?: boolean;
  sources: readonly AskSource[];
  /** A small line under the answer (answered without the earlier messages). */
  note?: string;
  actions?: ReactNode;
  /** Follow-up questions, under everything else. */
  children?: ReactNode;
  testID?: string;
  statusTestID?: string;
  answerTestID?: string;
}) {
  const theme = useTheme();
  const color = tone === 'error' ? theme.danger : tone === 'warning' ? theme.warning : tone === 'progress' ? theme.accentText : theme.textSecondary;
  return (
    <View style={styles.answer} testID={testID}>
      <View style={styles.answerHead}>
        <View style={[styles.avatar, { backgroundColor: theme.accentSoft }]}>
          <CorvusMark size={18} />
        </View>
        <ThemedText type="smallStrong" numberOfLines={1} style={styles.shrink}>
          {who}
        </ThemedText>
      </View>
      <View style={styles.answerBody}>
        {(thinking || tone !== 'muted' || !answer) && (
          <View style={styles.status} accessibilityLiveRegion="polite">
            {thinking || tone === 'error' || tone === 'warning' ? (
              <View style={styles.statusMark}>{thinking ? <ThinkingDots color={theme.accent} /> : <Icon name="warning" size={16} color={color} />}</View>
            ) : null}
            <ThemedText type="small" style={[styles.shrink, { color }]} testID={statusTestID}>
              {status}
            </ThemedText>
          </View>
        )}
        {answer ? <AnswerText text={answer} sources={sources} streaming={streaming} testID={answerTestID} /> : null}
        {sources.length > 0 && !thinking && <SourceCards sources={sources} />}
        {note ? (
          <ThemedText type="caption" themeColor="textTertiary">
            {note}
          </ThemedText>
        ) : null}
        {tone === 'muted' && answer && !streaming ? (
          <ThemedText type="caption" themeColor="textTertiary" testID={statusTestID}>
            {status}
          </ThemedText>
        ) : null}
        {actions ? <View style={styles.actions}>{actions}</View> : null}
        {children}
      </View>
    </View>
  );
}

/** An answer's sources, numbered as it cites them, in a row that scrolls sideways. */
export function SourceCards({ sources }: { sources: readonly AskSource[] }) {
  const theme = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sources} style={styles.sourcesBleed} accessibilityLabel={t('Sources')}>
      {sources.map((s, i) => (
        <Pressable
          key={s.url}
          accessibilityRole="link"
          accessibilityLabel={t('Source {n}: {title}', { n: i + 1, title: s.title || tabHost(s.url) })}
          accessibilityHint={t('Opens the page. Long press to open it in your browser app.')}
          onPress={() => void openInApp(s.url)}
          onLongPress={() => void openInBrowser(s.url)}
          android_ripple={{ color: theme.ripple }}
          style={({ pressed }) => [styles.source, { backgroundColor: theme.surface, borderColor: theme.border }, pressed && Platform.OS !== 'android' && { opacity: 0.8 }]}
          testID={`ask-source-${s.url}`}>
          <View style={styles.sourceHead}>
            <Favicon url={s.url} size={20} />
            <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1} style={styles.shrink}>
              {tabHost(s.url)}
            </ThemedText>
            <View style={[styles.sourceNumber, { backgroundColor: theme.accentContainer }]}>
              <ThemedText type="caption" style={{ color: theme.onAccentContainer }}>
                {i + 1}
              </ThemedText>
            </View>
          </View>
          <ThemedText type="small" numberOfLines={2}>
            {s.title || s.url}
          </ThemedText>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** Questions to ask next: tapping one asks it in the same conversation. */
export function FollowUpChips({ questions, onAsk, disabled }: { questions: readonly string[]; onAsk: (q: string) => void; disabled?: boolean }) {
  const theme = useTheme();
  if (questions.length === 0) return null;
  return (
    <View style={styles.followUps}>
      {questions.map((q) => (
        <Pressable
          key={q}
          accessibilityRole="button"
          accessibilityLabel={t('Ask: {question}', { question: q })}
          accessibilityState={{ disabled: !!disabled }}
          disabled={disabled}
          onPress={() => onAsk(q)}
          android_ripple={{ color: theme.ripple }}
          style={[styles.followUp, { borderColor: theme.borderStrong, opacity: disabled ? 0.5 : 1 }]}
          testID={`follow-up-${q}`}>
          <Icon name="sparkle" size={16} color={theme.accentText} />
          <ThemedText type="small" style={styles.shrink}>
            {q}
          </ThemedText>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * The message box pinned at the bottom: grows with the text up to six lines, sends with its button
 * (and with Enter on a hardware keyboard on the web build).
 */
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  disabled,
  busy,
  note,
  autoFocus,
  keyboardUp,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  placeholder: string;
  disabled?: boolean;
  busy?: boolean;
  /** A line above the box (who answers, why sending is off). */
  note?: ReactNode;
  autoFocus?: boolean;
  /** The keyboard is up: it covers the gesture bar, so no room is kept for it. */
  keyboardUp?: boolean;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);
  const [focused, setFocused] = useState(false);
  const canSend = !disabled && !busy && value.trim() !== '';
  const lineHeight = Type.body.lineHeight;
  return (
    <View style={[styles.composerWrap, { backgroundColor: theme.background, borderTopColor: theme.divider, paddingBottom: (keyboardUp ? Space.sm : Math.max(insets.bottom, Space.sm)) + Space.xs }]}>
      {note ? <View style={styles.composerNote}>{note}</View> : null}
      <View style={[styles.composer, { backgroundColor: theme.surface, borderColor: focused ? theme.accent : theme.borderStrong }]}>
        <TextInput
          testID="ask-question"
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          accessibilityLabel={placeholder}
          placeholderTextColor={theme.textTertiary}
          selectionColor={theme.accent}
          cursorColor={theme.accent}
          multiline
          numberOfLines={Platform.OS === 'web' ? 1 : undefined}
          maxLength={1000}
          autoFocus={autoFocus}
          editable={!disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onContentSizeChange={(e) => setHeight(e.nativeEvent.contentSize.height)}
          onKeyPress={(e) => {
            const key = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };
            if (Platform.OS === 'web' && key.key === 'Enter' && !key.shiftKey) {
              (e as unknown as { preventDefault?: () => void }).preventDefault?.();
              if (canSend) onSend();
            }
          }}
          style={[Type.body, styles.composerInput, { color: theme.text, height: Math.min(Math.max(height, lineHeight + COMPOSER_PAD * 2), lineHeight * 6 + COMPOSER_PAD * 2) }, NO_OUTLINE]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('Send')}
          accessibilityState={{ disabled: !canSend, busy: !!busy }}
          aria-disabled={!canSend}
          disabled={!canSend}
          onPress={onSend}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          android_ripple={{ color: 'rgba(255,255,255,0.22)' }}
          style={[styles.send, { backgroundColor: canSend ? theme.accent : theme.disabledFill }]}
          testID="ask-submit">
          <Icon name="send" size={20} color={canSend ? theme.onAccent : theme.textDisabled} />
        </Pressable>
      </View>
    </View>
  );
}

/** The computer that answers, in the header: its name and a ▾; tapping it lists the others. */
export function ComputerButton({ computer, onPress, now }: { computer: DeviceInfo | undefined; onPress?: () => void; now: number }) {
  const theme = useTheme();
  const online = isOnline(computer, now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={computer ? t('Answered by {computer}. Change the computer', { computer: computer.name }) : t('Choose a computer')}
      onPress={onPress}
      disabled={!onPress}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      style={[styles.computerButton, { borderColor: theme.borderStrong }]}
      testID="chat-computer">
      <View style={[styles.onlineDot, { backgroundColor: online ? theme.success : theme.textTertiary }]} />
      <ThemedText type="label" numberOfLines={1} style={styles.shrink}>
        {computer?.name ?? t('No computer')}
      </ThemedText>
      {onPress ? <Icon name="chevronDown" size={18} color={theme.textSecondary} /> : null}
    </Pressable>
  );
}

/** A sheet from the bottom with the chain's computers; the chosen one is checked. */
export function ComputerSheet({
  open,
  computers,
  value,
  onPick,
  onClose,
  now,
}: {
  open: boolean;
  computers: readonly DeviceInfo[];
  value: string | undefined;
  onPick: (id: string) => void;
  onClose: () => void;
  now: number;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[styles.scrim, { backgroundColor: theme.scrim }]} onPress={onClose} accessibilityLabel={t('Close')} />
      <View style={[styles.sheet, { backgroundColor: theme.surfaceRaised, paddingBottom: insets.bottom + Space.lg }, Elevation.overlay]} accessibilityViewIsModal>
        <View style={[styles.grabber, { backgroundColor: theme.borderStrong }]} />
        <ThemedText type="title" style={styles.sheetTitle}>
          {t('Who answers')}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.sheetTitle}>
          {t('The computer answers with Corvus’s AI search and its own AI provider, while Corvus is open there.')}
        </ThemedText>
        {computers.map((c) => {
          const chosen = c.id === value;
          const online = isOnline(c, now);
          return (
            <Pressable
              key={c.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: chosen }}
              onPress={() => onPick(c.id)}
              android_ripple={{ color: theme.ripple }}
              style={[styles.sheetRow, chosen && { backgroundColor: theme.accentSoft }]}
              testID={`chat-to-${c.name}`}>
              <Icon name={(c.platform === 'darwin' || c.platform === 'win32' ? 'laptop' : 'screen') as IconName} size={22} color={theme.textSecondary} />
              <View style={styles.grow}>
                <ThemedText type="bodyStrong" numberOfLines={1}>
                  {c.name}
                </ThemedText>
                <ThemedText type="small" style={{ color: online ? theme.success : theme.textSecondary }} numberOfLines={1}>
                  {online ? t('Corvus is open · {platform}', { platform: platformName(c.platform) }) : t('Last seen {when} · {platform}', { when: ago(c.lastSeen, now), platform: platformName(c.platform) })}
                </ThemedText>
              </View>
              {chosen ? <Icon name="check" size={22} color={theme.accentText} /> : null}
            </Pressable>
          );
        })}
        <Button label={t('Close')} kind="text" onPress={onClose} style={styles.sheetClose} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  userRow: {
    alignItems: 'flex-end',
    paddingLeft: Space.huge,
  },
  userBubble: {
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm + 2,
    borderRadius: 20,
    borderBottomRightRadius: Radius.xs,
    maxWidth: '100%',
  },
  answer: {
    gap: Space.sm,
  },
  answerHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  answerBody: {
    gap: Space.md,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.sm,
    minHeight: 24,
  },
  /** The dots or the warning sign, centered on the status's first line. */
  statusMark: {
    height: 20,
    justifyContent: 'center',
  },
  dots: {
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 2,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  shrink: {
    flexShrink: 1,
  },
  grow: {
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Space.sm,
  },
  sourcesBleed: {
    marginHorizontal: -Layout.gutter,
    flexGrow: 0,
  },
  sources: {
    gap: Space.sm,
    paddingHorizontal: Layout.gutter,
  },
  source: {
    width: 188,
    minHeight: 84,
    padding: Space.md,
    gap: Space.xs + 2,
    borderRadius: Radius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  sourceHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  sourceNumber: {
    marginLeft: 'auto',
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  followUps: {
    gap: Space.sm,
    alignItems: 'flex-start',
  },
  followUp: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    minHeight: 40,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
    borderWidth: 1,
    borderRadius: Radius.pill,
    overflow: 'hidden',
    maxWidth: '100%',
  },
  composerWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Space.md,
    paddingTop: Space.sm,
    gap: Space.xs,
  },
  composerNote: {
    paddingHorizontal: Space.sm,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderWidth: 1,
    borderRadius: 24,
    paddingLeft: Space.lg,
    paddingRight: Space.xs + 2,
    paddingVertical: Space.xs + 2,
    width: '100%',
    maxWidth: Layout.maxWidth,
    alignSelf: 'center',
  },
  composerInput: {
    flex: 1,
    paddingTop: COMPOSER_PAD,
    paddingBottom: COMPOSER_PAD,
    textAlignVertical: 'top',
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  computerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs + 2,
    minHeight: 36,
    maxWidth: 210,
    paddingLeft: Space.md,
    paddingRight: Space.sm,
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  scrim: {
    ...StyleSheet.absoluteFill,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    paddingTop: Space.sm,
    paddingHorizontal: Space.sm,
    gap: Space.xs,
  },
  grabber: {
    width: 32,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: Space.sm,
  },
  sheetTitle: {
    paddingHorizontal: Space.lg,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.lg,
    minHeight: Layout.rowTwoLine,
    paddingHorizontal: Space.lg,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  sheetClose: {
    alignSelf: 'flex-end',
  },
});
