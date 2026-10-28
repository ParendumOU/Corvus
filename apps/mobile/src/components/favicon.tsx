import Constants from 'expo-constants';
import { useState } from 'react';
import { Image, Platform, StyleSheet, Text, View } from 'react-native';

import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { FaviconMemo, faviconCandidates, faviconUserAgent, pageSite, siteInitial } from '@/lib/favicon';

const memo = new FaviconMemo();

// Android's image loader sends no User-Agent of its own (see faviconUserAgent). The web build is a
// browser, and a custom header there would turn each icon into a CORS request most sites refuse.
const headers = Platform.OS === 'android' ? { 'User-Agent': faviconUserAgent(Constants.expoConfig?.version ?? '') } : undefined;

/**
 * A page's favicon from its own site on a light tile (so a dark icon stays visible on a dark page),
 * or the site's initial on a colored tile when it has none. Tries the site's usual icon addresses
 * in turn and remembers, per site, which one works.
 */
export function Favicon({ url, size = 36 }: { url: string; size?: number }) {
  const theme = useTheme();
  const candidates = faviconCandidates(url);
  const key = candidates[0] ?? ''; // one per page origin
  const [shown, setShown] = useState(() => ({ key, index: memo.first(key, candidates.length) }));
  const index = shown.key === key ? shown.index : memo.first(key, candidates.length);
  const src = candidates[index];
  const tile = { width: size, height: size, borderRadius: size > 24 ? Radius.sm + 2 : Radius.xs };
  if (!src) {
    const site = pageSite(url);
    return (
      <View style={[styles.tile, tile, { backgroundColor: siteColor(site) }]}>
        <Text style={[styles.initial, { fontSize: Math.round(size * 0.44) }]}>{siteInitial(url)}</Text>
      </View>
    );
  }
  const icon = size > 24 ? Math.round(size * 0.56) : size;
  return (
    <View style={[styles.tile, tile, size > 24 && { backgroundColor: theme.faviconTile }]}>
      <Image
        key={src}
        source={headers ? { uri: src, headers } : { uri: src }}
        style={{ width: icon, height: icon, borderRadius: 3 }}
        onLoad={() => memo.loaded(key, index)}
        onError={() => setShown({ key, index: memo.failed(key, index, candidates.length) })}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

const PALETTE = ['#5B5BD6', '#1A73E8', '#188038', '#C2185B', '#8E3FD8', '#007B83', '#D9620A', '#5F6368'];

function siteColor(site: string): string {
  let hash = 0;
  for (const ch of site) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? '#5B5BD6';
}

const styles = StyleSheet.create({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  initial: {
    color: '#ffffff',
    fontWeight: '700',
  },
});
