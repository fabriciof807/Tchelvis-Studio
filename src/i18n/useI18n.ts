import { useCallback } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { translate, type TranslationKey } from './index';

export function useI18n() {
  const locale = useWorkspaceStore((s) => s.locale);
  const setLocale = useWorkspaceStore((s) => s.setLocale);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) =>
      translate(locale, key, vars),
    [locale]
  );

  return { locale, setLocale, t };
}
