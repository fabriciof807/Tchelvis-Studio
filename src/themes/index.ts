export type ThemeId = 'tokyo-night' | 'gruvbox' | 'kanagawa' | 'github-dark';

export const THEME_STORAGE_KEY = 'game-hub:theme';

export const THEME_OPTIONS: Array<{
  id: ThemeId;
  name: string;
  swatches: [string, string, string];
}> = [
  { id: 'tokyo-night', name: 'Tokyo Night', swatches: ['#1a1b26', '#24283b', '#7aa2f7'] },
  { id: 'gruvbox', name: 'Gruvbox', swatches: ['#1d2021', '#282828', '#fe8019'] },
  { id: 'kanagawa', name: 'Kanagawa', swatches: ['#1f1f28', '#2a2a37', '#7e9cd8'] },
  { id: 'github-dark', name: 'GitHub Dark', swatches: ['#0d1117', '#161b22', '#58a6ff'] },
];

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return (
    value === 'tokyo-night' ||
    value === 'gruvbox' ||
    value === 'kanagawa' ||
    value === 'github-dark'
  );
}

export function getInitialTheme(): ThemeId {
  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (isThemeId(saved)) {
        return saved;
      }
    } catch {
      // ignore storage errors
    }
  }
  return 'tokyo-night';
}

export function applyTheme(theme: ThemeId): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore storage errors
    }
  }
}
