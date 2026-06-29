import { ShieldCheck, RotateCcw } from 'lucide-react';
import AdminNav from '../components/AdminNav';
import { useTheme, hslToHex, DEFAULT_COLORS, type ColorKey } from '../lib/theme';

const COLOR_CONFIG: { key: ColorKey; label: string; description: string }[] = [
  { key: 'primary',  label: 'Scores',   description: 'Score numbers, buttons, and primary accents' },
  { key: 'machine',  label: 'Machines', description: 'Machine names across all pages' },
  { key: 'venue',    label: 'Venues',   description: 'Venue names and venue-related UI' },
  { key: 'username', label: 'Players',  description: 'Usernames, trophies, and your card borders' },
];

function ColorRow({ item }: { item: typeof COLOR_CONFIG[number] }) {
  const { colors, setColor } = useTheme();
  const hex = hslToHex(colors[item.key]);
  const isDefault = colors[item.key] === DEFAULT_COLORS[item.key];

  return (
    <div className="flex items-center gap-4 py-4 border-b border-white/10 last:border-0">
      <div className="relative w-10 h-10 flex-shrink-0 cursor-pointer">
        <div
          className="w-10 h-10 rounded-lg border-2 border-white/20"
          style={{ background: hex }}
        />
        <input
          type="color"
          value={hex}
          onChange={e => setColor(item.key, e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
          aria-label={`Pick color for ${item.label}`}
        />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-white">{item.label}</p>
        <p className="text-xs text-muted-foreground">{item.description}</p>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="text-xs font-mono text-muted-foreground uppercase">{hex}</span>
        {!isDefault && (
          <button
            onClick={() => setColor(item.key, hslToHex(DEFAULT_COLORS[item.key]))}
            className="text-muted-foreground hover:text-white transition-colors"
            title="Reset to default"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

export default function AdminConfigPage() {
  const { resetColors, colors } = useTheme();
  const allDefault = Object.entries(DEFAULT_COLORS).every(
    ([k, v]) => colors[k as ColorKey] === v
  );

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <ShieldCheck className="w-7 h-7 text-primary" />
        <h1 className="text-3xl font-black uppercase tracking-widest text-white">Admin</h1>
      </div>

      <AdminNav />

      <section className="flex flex-col gap-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
          Configuration Settings
        </h2>

        <div className="rounded-xl border border-white/10 bg-card p-6">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-base font-black uppercase tracking-wider text-white">App Theme</h3>
            {!allDefault && (
              <button
                onClick={resetColors}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-white transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                Reset all
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground mb-5">
            Changes apply instantly across the app and persist across sessions.
          </p>
          <div>
            {COLOR_CONFIG.map(item => (
              <ColorRow key={item.key} item={item} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
