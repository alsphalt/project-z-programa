import type { Config } from 'tailwindcss';

/**
 * DARKNOTE CONTROL CENTER design tokens.
 *
 * Deep charcoal surfaces, a violet primary accent and a cyan secondary accent.
 * Glow is deliberately restrained: one soft shadow, one hairline highlight.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#05060a',
          900: '#080a12',
          850: '#0a0d16',
          800: '#0f1320',
          750: '#121728',
          700: '#151a2b',
          600: '#1d2438',
          500: '#2a3350',
        },
        accent: {
          DEFAULT: '#6d5efc',
          soft: '#8b7dff',
          deep: '#4c3ce0',
        },
        cyber: {
          DEFAULT: '#31d0f5',
          soft: '#6ee0ff',
        },
        brand: {
          blue: '#3b82f6',
          cyan: '#22d3ee',
          violet: '#8b5cf6',
          green: '#22c55e',
          amber: '#f59e0b',
          red: '#ef4444',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 0 rgba(255,255,255,0.04) inset, 0 20px 60px -30px rgba(0,0,0,0.9)',
        glow: '0 0 0 1px rgba(109,94,252,0.25), 0 10px 40px -12px rgba(109,94,252,0.35)',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSoft: {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.25s ease-out',
        slideUp: 'slideUp 0.22s ease-out',
        pulseSoft: 'pulseSoft 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
