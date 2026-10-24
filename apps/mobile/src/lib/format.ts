import { t } from './i18n';

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(ms: number, now: number = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return t('just now');
  if (minutes < 60) return t('{n} min ago', { n: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 24 ? t('{n} h ago', { n: hours }) : t('{n} d ago', { n: Math.round(hours / 24) });
}
