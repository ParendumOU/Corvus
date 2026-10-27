import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { tabHost } from '@/lib/replica';

/**
 * A page's favicon from its own site on a light tile (so a dark icon stays visible on a dark page),
 * or the site's initial on a colored tile when it has none.
 */
export function Favicon({ url, size = 36 }: { url: string; size?: number }) {
  const theme = useTheme();
  const [failed, setFailed] = useState(false);
  const host = tabHost(url);
  const origin = host ? new URL(url).origin : '';
  const tile = { width: size, height: size, borderRadius: size > 24 ? Radius.sm + 2 : Radius.xs };
  if (failed || !origin) {
    return (
      <View style={[styles.tile, tile, { backgroundColor: hostColor(host) }]}>
        <Text style={[styles.initial, { fontSize: Math.round(size * 0.44) }]}>{(host[0] ?? '?').toUpperCase()}</Text>
      </View>
    );
  }
  const icon = size > 24 ? Math.round(size * 0.56) : size;
  return (
    <View style={[styles.tile, tile, size > 24 && { backgroundColor: theme.faviconTile }]}>
      <Image
        source={{ uri: `${origin}/favicon.ico` }}
        style={{ width: icon, height: icon, borderRadius: 3 }}
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

const PALETTE = ['#5B5BD6', '#1A73E8', '#188038', '#C2185B', '#8E3FD8', '#007B83', '#D9620A', '#5F6368'];

function hostColor(host: string): string {
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
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
