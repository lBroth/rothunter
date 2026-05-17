/**
 * Theme persistence + the class-toggle that drives Tailwind's `dark:`
 * variant. Reads `localStorage.rh-theme` first, falls back to the
 * browser's `prefers-color-scheme: dark` media query.
 */
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'rh-theme';

function detect(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(detect);

  useEffect(() => {
    apply(theme);
    window.localStorage.setItem(KEY, theme);
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
  };
}
