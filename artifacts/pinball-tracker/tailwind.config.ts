import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: 'hsl(var(--primary) / <alpha-value>)',
        machine: 'hsl(var(--machine) / <alpha-value>)',
        venue: 'hsl(var(--venue) / <alpha-value>)',
        username: 'hsl(var(--username) / <alpha-value>)',
        'muted-foreground': 'hsl(var(--muted-foreground) / <alpha-value>)',
        card: 'hsl(var(--card) / <alpha-value>)',
        border: 'hsl(var(--border) / <alpha-value>)',
      },
      fontFamily: {
        display: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [
    plugin(({ addUtilities }) => {
      addUtilities({
        '.text-glow-primary': {
          color: 'hsl(var(--primary))',
          textShadow: '0 0 8px hsl(var(--primary) / 0.8), 0 0 24px hsl(var(--primary) / 0.4)',
        },
      });
    }),
  ],
} satisfies Config;
