import Constants from 'expo-constants';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SectionHeader } from '@/components/card';
import { EmptyState, LoadingState } from '@/components/empty-state';
import { SearchField } from '@/components/fields';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Layout, Radius, Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import { filterNotices, noticeCount, reflowLicense, type NoticePackage, type NoticeSectionId, type Notices } from '@/lib/notices';
import { loadNotices } from '@/lib/notices-file';
import { openInApp } from '@/lib/open-url';

const SOURCE_URL = 'https://github.com/ParendumOU/Corvus';

function sectionTitle(id: NoticeSectionId): string {
  return id === 'js' ? t('JavaScript packages') : t('Android libraries');
}

function PackageRow({ p, texts, open, onToggle }: { p: NoticePackage; texts: string[]; open: boolean; onToggle: () => void }) {
  const theme = useTheme();
  const urls = p.texts.length === 0 ? (p.licenseUrls ?? []) : [];
  return (
    <View style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint={open ? t('Hides the licence') : t('Shows the licence')}
        android_ripple={{ color: theme.ripple }}
        style={styles.rowHead}
        testID={`notice-${p.name}`}>
        <View style={styles.grow}>
          <ThemedText type="bodyStrong" numberOfLines={open ? undefined : 1}>
            {p.name} <ThemedText type="small" themeColor="textSecondary">{p.version}</ThemedText>
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={open ? undefined : 1}>
            {[p.license || t('No licence declared'), p.copyright[0]].filter(Boolean).join(' · ')}
          </ThemedText>
        </View>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={20} color={theme.textTertiary} />
      </Pressable>
      {open ? (
        <View style={styles.body}>
          {p.copyright.slice(1).map((line) => (
            <ThemedText key={line} type="small" themeColor="textSecondary">
              {line}
            </ThemedText>
          ))}
          {p.homepage ? (
            <ThemedText type="small" themeColor="accentText" onPress={() => void openInApp(p.homepage)} accessibilityRole="link">
              {p.homepage}
            </ThemedText>
          ) : null}
          {p.texts.map((i) => (
            <ThemedText key={i} type="small" selectable style={[styles.text, { backgroundColor: theme.field }]}>
              {reflowLicense(texts[i] ?? '')}
            </ThemedText>
          ))}
          {p.texts.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              {urls.length > 0 ? t('Licence text: {url}', { url: urls.join(', ') }) : t('The package has no licence file; it is distributed under the licence named above.')}
            </ThemedText>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export default function LicensesScreen() {
  const insets = useSafeAreaInsets();
  const [notices, setNotices] = useState<Notices | null | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const version = Constants.expoConfig?.version ?? '';

  useEffect(() => {
    void loadNotices().then(setNotices);
  }, []);

  const sections = useMemo(
    () => (notices ? filterNotices(notices, query).map((s) => ({ id: s.id, title: `${sectionTitle(s.id)} (${s.packages.length})`, data: s.packages })) : []),
    [notices, query],
  );

  if (notices === undefined) return <LoadingState testID="licenses-loading" />;

  const intro = (
    <View style={styles.intro}>
      <ThemedText type="small" themeColor="textSecondary">
        {t('Corvus is free software under the Mozilla Public License 2.0; its source code is at {url}.', { url: SOURCE_URL })}
      </ThemedText>
      {notices ? (
        <>
          <ThemedText type="small" themeColor="textSecondary">
            {t('Corvus for mobile {version} includes the {n} third-party packages listed here. Each keeps its own licence, reproduced in full: tap a package to read it.', {
              version: notices.version || version,
              n: noticeCount(notices.sections),
            })}
          </ThemedText>
          <SearchField value={query} onChangeText={setQuery} placeholder={t('Search packages and licences')} testID="licenses-search" />
        </>
      ) : null}
    </View>
  );

  return (
    <SectionList
      testID="licenses"
      sections={sections}
      keyExtractor={(p) => `${p.name}@${p.version}`}
      ListHeaderComponent={intro}
      ListEmptyComponent={
        notices ? (
          <EmptyState icon="search" description={t('No package matches “{query}”.', { query })} compact />
        ) : (
          <EmptyState icon="info" description={t('The list of third-party licences ships with the Android app.')} compact testID="licenses-missing" />
        )
      }
      renderSectionHeader={({ section }) => (
        <View style={styles.sectionHeader}>
          <SectionHeader title={section.title} />
        </View>
      )}
      renderItem={({ item }) => {
        const key = `${item.name}@${item.version}`;
        return <PackageRow p={item} texts={notices?.texts ?? []} open={open === key} onToggle={() => setOpen(open === key ? null : key)} />;
      }}
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      initialNumToRender={20}
      style={styles.list}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Space.xxl }]}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: Layout.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: Layout.gutter,
    paddingTop: Space.lg,
    gap: Space.sm,
  },
  intro: {
    gap: Space.md,
    marginBottom: Space.sm,
  },
  sectionHeader: {
    marginTop: Space.md,
  },
  row: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: Layout.row,
  },
  body: {
    gap: Space.sm,
    paddingHorizontal: Space.lg,
    paddingBottom: Space.lg,
  },
  text: {
    padding: Space.md,
    borderRadius: Radius.sm,
  },
  grow: {
    flex: 1,
    gap: 2,
  },
});
