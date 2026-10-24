import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { tabHost } from '@/lib/replica';

/** A page's favicon from its own site, or the site's initial when it has none. */
export function Favicon({ url, size = 20 }: { url: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const host = tabHost(url);
  const origin = host ? new URL(url).origin : '';
  const box = { width: size, height: size, borderRadius: size / 4 };
  if (failed || !origin) {
    return (
      <View style={[styles.letter, box, { backgroundColor: hostColor(host) }]}>
        <Text style={[styles.initial, { fontSize: size * 0.6 }]}>{(host[0] ?? '?').toUpperCase()}</Text>
      </View>
    );
  }
  return <Image source={{ uri: `${origin}/favicon.ico` }} style={box} onError={() => setFailed(true)} accessibilityIgnoresInvertColors />;
}

const PALETTE = ['#5B5BD6', '#1A73E8', '#188038', '#D01884', '#A142F4', '#007B83', '#E8710A', '#5F6368'];

function hostColor(host: string): string {
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? '#5B5BD6';
}

const styles = StyleSheet.create({
  letter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    color: '#ffffff',
    fontWeight: 700,
  },
});
