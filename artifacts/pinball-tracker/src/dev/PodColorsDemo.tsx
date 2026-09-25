/**
 * DEV-ONLY demo for the pod color spike (docs/pod-colors.md). Routed at
 * /dev/pod-colors only when import.meta.env.DEV, so it never ships.
 * Delete this file and its route in App.tsx once pods have real UI.
 */
import { useState } from 'react';
import { LineChart, Line, Scatter, ComposedChart, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from 'recharts';
import PodChip from '../components/PodChip';
import {
  POD_PALETTE, DARK_SURFACE, LIGHT_SURFACE, podColorTokens, podColorVars,
  normalizePodColor, nearReservedColor, nextPodColor, contrastRatio,
} from '../lib/podColor';
import { useTheme, hslToHex } from '../lib/theme';

const SAMPLE_PODS = [
  { name: 'Tuesday League', color: POD_PALETTE[0] },
  { name: 'Work Crew', color: POD_PALETTE[1] },
  { name: 'Arcade Regulars', color: POD_PALETTE[2] },
  // Deliberately hard picks: navy on dark, pale yellow on light.
  { name: 'Navy (dark pick)', color: '#1e3a8a' },
  { name: 'Butter (pale pick)', color: '#fef08a' },
];

// Fake series: one line per pod, 10 plays each.
const LINE_DATA = Array.from({ length: 10 }, (_, i) => {
  const row: Record<string, number> = { x: i + 1 };
  SAMPLE_PODS.forEach((p, j) => { row[p.name] = 40 + j * 12 + Math.round(Math.sin(i / 1.6 + j) * 10 + i * 2); });
  return row;
});

function Panel({ surface, label }: { surface: string; label: string }) {
  const isDark = surface === DARK_SURFACE;
  const ink = isDark ? '#fafafa' : '#18181b';
  const muted = isDark ? '#71717a' : '#52525b';
  return (
    <div className="rounded-xl border p-5 flex flex-col gap-5" style={{ background: surface, color: ink, borderColor: isDark ? 'hsl(var(--border))' : '#e4e4e7' }}>
      <h2 className="text-sm font-black uppercase tracking-widest">{label} surface <span className="font-mono font-normal" style={{ color: muted }}>{surface}</span></h2>

      <div className="flex flex-wrap gap-2">
        {SAMPLE_PODS.map(p => <PodChip key={p.name} color={p.color} surface={surface}>{p.name}</PodChip>)}
      </div>
      <div className="flex flex-wrap gap-2">
        {SAMPLE_PODS.map(p => <PodChip key={p.name} color={p.color} surface={surface} solid>{p.name}</PodChip>)}
      </div>

      {/* Scoped vars used directly with Tailwind classes, as a real card would. */}
      <div className="flex flex-col gap-1 text-sm">
        {SAMPLE_PODS.map(p => (
          <div key={p.name} style={podColorVars(p.color, surface)} className="flex items-center gap-2 border-l-4 border-pod pl-2">
            <span className="font-bold text-pod-text">{p.name}</span>
            <span className="font-mono text-xs" style={{ color: muted }}>
              stored {p.color} → text {podColorTokens(p.color, surface).text} ({contrastRatio(podColorTokens(p.color, surface).text, podColorTokens(p.color, surface).tint).toFixed(1)}:1)
              · graphic {podColorTokens(p.color, surface).graphic} ({contrastRatio(podColorTokens(p.color, surface).graphic, surface).toFixed(1)}:1)
            </span>
          </div>
        ))}
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={LINE_DATA} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)'} />
          <XAxis dataKey="x" tick={{ fill: muted, fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fill: muted, fontSize: 11 }} tickLine={false} axisLine={false} width={32} />
          {SAMPLE_PODS.map(p => {
            const t = podColorTokens(p.color, surface);
            return (
              <Line key={p.name} type="monotone" dataKey={p.name} stroke={t.graphic} strokeWidth={2}
                dot={{ fill: t.graphic, r: 4, strokeWidth: 2, stroke: surface }} isAnimationActive={false} />
            );
          })}
        </LineChart>
      </ResponsiveContainer>

      <ResponsiveContainer width="100%" height={160}>
        <ComposedChart margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
          <XAxis dataKey="x" type="number" domain={[0, 11]} tick={{ fill: muted, fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis dataKey="y" type="number" tick={{ fill: muted, fontSize: 11 }} tickLine={false} axisLine={false} width={32} />
          {SAMPLE_PODS.map(p => (
            <Scatter key={p.name} dataKey="y" fill={podColorTokens(p.color, surface).graphic} isAnimationActive={false}
              data={LINE_DATA.map(r => ({ x: r.x, y: r[p.name] }))} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function PodColorsDemo() {
  const { colors } = useTheme();
  const [input, setInput] = useState('#1e3a8a');
  const normalized = normalizePodColor(input);
  const reserved = { 'You (username)': hslToHex(colors.username), 'All other players (field)': hslToHex(colors.field) };
  const clash = normalized ? nearReservedColor(normalized, reserved) : null;

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-black uppercase tracking-widest text-white">Pod colors (dev only)</h1>
        <p className="text-xs text-muted-foreground">Spike for runtime per-pod colors. See docs/pod-colors.md.</p>
      </div>

      <div className="rounded-xl border border-white/10 bg-card p-5 flex flex-col gap-3">
        <label className="text-sm font-bold text-white">Try a hex</label>
        <div className="flex items-center gap-3 flex-wrap">
          <input value={input} onChange={e => setInput(e.target.value)}
            className="bg-background border border-white/20 rounded-lg px-3 py-1.5 font-mono text-sm text-white w-36" />
          <input type="color" value={normalized ?? '#000000'} onChange={e => setInput(e.target.value)} className="w-9 h-9 bg-transparent" />
          {normalized
            ? <><PodChip color={normalized}>Dark card</PodChip><span className="rounded-full p-1" style={{ background: LIGHT_SURFACE }}><PodChip color={normalized} surface={LIGHT_SURFACE}>Light surface</PodChip></span>
                <span className="text-xs text-muted-foreground font-mono">→ {normalized}</span></>
            : <span className="text-xs text-red-400">Not a valid #rgb / #rrggbb color</span>}
        </div>
        {clash && <p className="text-xs text-amber-400">Looks a lot like the {clash} color — pod members may be hard to tell apart.</p>}
        <p className="text-xs text-muted-foreground">
          Palette: {POD_PALETTE.map(c => <span key={c} className="inline-block w-4 h-4 rounded align-middle mr-1" style={{ background: c }} title={c} />)}
          next free after first two used: <span className="font-mono">{nextPodColor([POD_PALETTE[0], POD_PALETTE[1]])}</span>
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Panel surface={DARK_SURFACE} label="Dark" />
        <Panel surface={LIGHT_SURFACE} label="Light" />
      </div>
    </div>
  );
}
