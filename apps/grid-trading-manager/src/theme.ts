// 主题管理：浅色 / 深色 / 跟随系统。选择持久化于 localStorage；解析结果写入 <html data-theme>。
export type ThemeChoice = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'grid-trading-manager:theme';

export function loadThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {
    /* 忽略：隐私模式等 */
  }
  return 'auto';
}

export function saveThemeChoice(c: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, c);
  } catch {
    /* 忽略 */
  }
}

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(c: ThemeChoice): ResolvedTheme {
  if (c === 'auto') return systemPrefersDark() ? 'dark' : 'light';
  return c;
}

export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
}
