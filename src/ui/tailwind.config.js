/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Theme switching via `class="dark"` on <html>. CSS vars in index.css carry
  // the per-theme values so existing utilities (bg-bg, text-ink, etc.) keep
  // working across both modes.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg:          'rgb(var(--rh-bg) / <alpha-value>)',
        panel:       'rgb(var(--rh-panel) / <alpha-value>)',
        'panel-alt': 'rgb(var(--rh-panel-alt) / <alpha-value>)',
        border:      'rgb(var(--rh-border) / <alpha-value>)',
        'border-soft': 'rgb(var(--rh-border-soft) / <alpha-value>)',
        ink:         'rgb(var(--rh-ink) / <alpha-value>)',
        muted:       'rgb(var(--rh-muted) / <alpha-value>)',
        accent:      'rgb(var(--rh-accent) / <alpha-value>)',
        'accent-soft': 'rgb(var(--rh-accent-soft) / <alpha-value>)',
        // Severity tones — shared across light + dark.
        'high':      { DEFAULT: '#fb7185', soft: '#fda4af', wash: '#fecdd3' },
        'med':       { DEFAULT: '#fbbf24', soft: '#fde68a', wash: '#fef3c7' },
        'low':       { DEFAULT: '#34d399', soft: '#86efac', wash: '#d1fae5' },
        'info':      { DEFAULT: '#38bdf8', soft: '#bae6fd', wash: '#e0f2fe' },
        // Back-compat aliases used by the v1 components — phased out as
        // pages are rewritten to the new token names.
        ce: 'rgb(var(--rh-ink) / <alpha-value>)',
        purple: '#a371f7',
      },
      fontFamily: {
        serif: ['Newsreader', 'Iowan Old Style', 'Tiempos Headline', 'serif'],
        sans: ['Inter', '-apple-system', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', '"SF Mono"', 'Consolas', 'monospace'],
      },
      letterSpacing: {
        wider: '0.06em',
        widest: '0.12em',
      },
      borderRadius: {
        lg: '10px',
      },
    },
  },
  plugins: [],
};
