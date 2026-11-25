import { useCallback } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { translate, translatePlural, type PluralKey, type TranslationKey } from './index';

export function useI18n() {
  const locale = useWorkspaceStore((s) => s.locale);
  const setLocale = useWorkspaceStore((s) => s.setLocale);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) =>
      translate(locale, key, vars),
    [locale]
  );

  const tp = useCallback(
    (key: PluralKey, count: number, vars?: Record<string, string | number>) =>
      translatePlural(locale, key, count, vars),
    [locale]
  );

  return { locale, setLocale, t, tp };
}
