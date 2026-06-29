import { createContext, useContext, useLayoutEffect, useEffect, useState, type ReactNode } from 'react';

export function hexToHsl(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / delta + 6) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function hslToHex(hsl: string): string {
  const parts = hsl.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return '#000000';
  const h = parseFloat(parts[0]);
  const s = parseFloat(parts[1]) / 100;
  const l = parseFloat(parts[2]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export const DEFAULT_COLORS = {
  primary:  '295 80% 60%',
  machine:  '199 89% 60%',
  venue:    '84 81% 44%',
  username: '48 96% 53%',
} as const;

export type ColorKey = keyof typeof DEFAULT_COLORS;
type Colors = Record<ColorKey, string>;

interface ThemeContextValue {
  colors: Colors;
  setColor: (key: ColorKey, hex: string) => void;
  resetColors: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'tilttrack-theme';

function applyColors(colors: Colors) {
  for (const [key, value] of Object.entries(colors)) {
    document.documentElement.style.setProperty(`--${key}`, value);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [colors, setColors] = useState<Colors>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return { ...DEFAULT_COLORS, ...JSON.parse(saved) };
    } catch {}
    return { ...DEFAULT_COLORS };
  });

  useLayoutEffect(() => {
    applyColors(colors);
  }, [colors]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
  }, [colors]);

  function setColor(key: ColorKey, hex: string) {
    setColors(prev => ({ ...prev, [key]: hexToHsl(hex) }));
  }

  function resetColors() {
    setColors({ ...DEFAULT_COLORS });
  }

  return (
    <ThemeContext.Provider value={{ colors, setColor, resetColors }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
