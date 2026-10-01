// Generates the TiltTrack logo SVGs (hand-authored geometry; wordmarks outlined to paths).
// Concept D is the chosen logo — its D-*.svg files are what public/brand/ holds; A–C are the
// rejected concepts, still generated for comparison.
//
// Run it from a scratch copy, not from the repo (its fonts come from node_modules next to it):
//   npm i opentype.js @fontsource/inter @fontsource/audiowide @fontsource/russo-one
//   node gen.js <outDir>          (default ../svg)
// then copy the D-*.svg files into public/brand/ and run build-icons.js for the PNGs/ICO/og-image.
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'svg'));
fs.mkdirSync(OUT, { recursive: true });

const C = {
  pink: '#DD47EB',   // hsl(295 80% 60%) — app `primary`
  light: '#F49CFC',  // hsl(295 95% 80%)
  core: '#FCD6FF',   // hsl(295 100% 92%) — neon tube core
  dark: '#AA20B6',   // hsl(295 70% 42%)
  deep: '#74127D',   // hsl(295 75% 28%)
  bg: '#09090B',     // hsl(240 10% 4%) — app background
  white: '#FFFFFF',
};

const font = (f) => { const b = fs.readFileSync(path.join(__dirname, "node_modules/@fontsource", f)); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const F = {
  inter800: font('inter/files/inter-latin-800-normal.woff'),
  inter900i: font('inter/files/inter-latin-900-italic.woff'),
  audiowide: font('audiowide/files/audiowide-latin-400-normal.woff'),
  russo: font('russo-one/files/russo-one-latin-400-normal.woff'),
  inter900: font('inter/files/inter-latin-900-normal.woff'),
};

// Outline text to path data, centred on cx with baseline at y. Returns {d, bbox, width}.
function textPath(fnt, text, size, cx, baseline, letterSpacing = 0) {
  // lay out glyph by glyph so we can add tracking
  const glyphs = [...text].map((ch) => fnt.charToGlyph(ch));
  let x = 0;
  const parts = [];
  const scale = size / fnt.unitsPerEm;
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    parts.push({ g, x });
    x += g.advanceWidth * scale + letterSpacing;
    if (i < glyphs.length - 1) x += fnt.getKerningValue(g, glyphs[i + 1]) * scale;
  }
  // measure using real outlines
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of parts) {
    const bb = p.g.getPath(p.x, 0, size).getBoundingBox();
    if (bb.x1 === bb.x2) continue;
    minX = Math.min(minX, bb.x1); maxX = Math.max(maxX, bb.x2);
    minY = Math.min(minY, bb.y1); maxY = Math.max(maxY, bb.y2);
  }
  const dx = cx - (minX + maxX) / 2;
  const ds = parts.map((p) => p.g.getPath(p.x + dx, baseline, size).toPathData(2));
  return { ds, d: ds.join(' '), bbox: { x1: minX + dx, x2: maxX + dx, y1: baseline + minY, y2: baseline + maxY } };
}
// split "TiltTrack" into the two words' path data (for two-tone)
function twoTone(fnt, size, cx, baseline, ls = 0) {
  const t = textPath(fnt, 'TiltTrack', size, cx, baseline, ls);
  return { tilt: t.ds.slice(0, 4).join(' '), track: t.ds.slice(4).join(' '), bbox: t.bbox };
}

/* ---------- Trophy geometry (local space: x ~40..560, centre x=300; y ~ -30..560) ---------- */
const G = {
  cup: 'M140,60 H460 V130 C460,262 384,334 300,334 C216,334 140,262 140,130 Z',
  lip: { x: 124, y: 46, w: 352, h: 30, r: 12 },
  neck: 'M266,326 H334 L320,398 H280 Z',
  knot: { x: 246, y: 394, w: 108, h: 28, r: 12 },
  stem: 'M282,420 H318 L336,474 H264 Z',
  plinth: { x: 204, y: 470, w: 192, h: 40, r: 8 },
  slab: { x: 168, y: 506, w: 264, h: 52, r: 12 },
  ball: { cx: 300, cy: 30, r: 60 },
  // classic loop handles, ending on the cup wall (cup wall passes ~(165,246))
  handleL: 'M140,98 C62,90 46,222 165,246',
  handleR: 'M460,98 C538,90 554,222 435,246',
};
// TROPHY_BOX: visual bounds of the local drawing used for centring
const TB = { x1: 40, x2: 560, y1: -32, y2: 560 };

// flipper outline: tangent hull of two circles
function flipper(px, py, pr, tx, ty, tr) {
  const dx = tx - px, dy = ty - py, d = Math.hypot(dx, dy);
  const a = Math.atan2(dy, dx), b = Math.acos((pr - tr) / d);
  const p = (cx, cy, r, ang) => [cx + r * Math.cos(ang), cy + r * Math.sin(ang)].map((v) => v.toFixed(2)).join(',');
  return `M${p(px, py, pr, a + b)} A${pr},${pr} 0 1 1 ${p(px, py, pr, a - b)} L${p(tx, ty, tr, a - b)} A${tr},${tr} 0 0 1 ${p(tx, ty, tr, a + b)} Z`;
}
const FLIP = { L: [92, 104, 36, 196, 268, 14], R: [508, 104, 36, 404, 268, 14] };

const rr = (o, extra = '') => `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="${o.r}" ${extra}/>`;

/* ===================== Concept A — neon sign ===================== */
function trophyNeon(w, { small = false } = {}) {
  const shapes = small
    ? `
    <path d="${G.cup}"/>
    <path d="M118,60 H482"/>
    <path d="${G.handleL}"/><path d="${G.handleR}"/>
    <path d="M300,340 V470"/>
    <path d="M190,530 H410"/>
    <path d="M248,58 A52,52 0 1 1 352,58"/>`
    : `
    <path d="${G.cup}"/>
    <path d="M118,60 H482"/>
    <path d="${G.handleL}"/><path d="${G.handleR}"/>
    <path d="M278,336 L286,398 M322,336 L314,398"/>
    <path d="M252,410 H348"/>
    <path d="M288,422 L274,476 M312,422 L326,476"/>
    <rect x="212" y="480" width="176" height="24" rx="12"/>
    <rect x="178" y="520" width="244" height="30" rx="15"/>
    <path d="M206,124 C208,194 234,238 266,258"/>
    <path d="M248,58 A52,52 0 1 1 352,58"/>
    <path d="M271.8,33.7 A30,30 0 0 1 289.7,15.8"/>`;
  const tube = (extra) => `<g fill="none" stroke-linecap="round" stroke-linejoin="round" ${extra}>${shapes}</g>`;
  return (
    tube(`stroke="${C.pink}" stroke-width="${w * 2.2}" filter="url(#glowWide)" opacity="0.8"`) +
    tube(`stroke="${C.pink}" stroke-width="${w}" filter="url(#glowTight)"`) +
    tube(`stroke="${C.core}" stroke-width="${w * 0.38}"`)
  );
}
function neonDefs(scale = 1) {
  return `
  <filter id="glowWide" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">
    <feGaussianBlur stdDeviation="${22 * scale}"/>
  </filter>
  <filter id="glowTight" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceGraphic" stdDeviation="${4 * scale}" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="textGlow" x="-30%" y="-60%" width="160%" height="220%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="${16 * scale}" result="a"/>
    <feFlood flood-color="${C.pink}" flood-opacity="0.95"/>
    <feComposite in2="a" operator="in" result="g1"/>
    <feGaussianBlur in="SourceAlpha" stdDeviation="${5 * scale}" result="a2"/>
    <feFlood flood-color="${C.pink}"/>
    <feComposite in2="a2" operator="in" result="g2"/>
    <feMerge><feMergeNode in="g1"/><feMergeNode in="g2"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>`;
}

/* ===================== Concept B — solid crest ===================== */
function solidDefs() {
  return `
  <linearGradient id="cupGrad" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${C.light}"/><stop offset="0.45" stop-color="${C.pink}"/><stop offset="1" stop-color="${C.dark}"/>
  </linearGradient>
  <linearGradient id="baseGrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.pink}"/><stop offset="1" stop-color="${C.dark}"/>
  </linearGradient>
  <radialGradient id="ballGrad" cx="0.36" cy="0.32" r="0.75">
    <stop offset="0" stop-color="#F4F0F6"/><stop offset="0.18" stop-color="#9C93A3"/><stop offset="0.6" stop-color="#2A2530"/><stop offset="1" stop-color="#0E0C10"/>
  </radialGradient>
  <filter id="softGlow" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="26" result="a"/>
    <feFlood flood-color="${C.pink}" flood-opacity="0.55"/>
    <feComposite in2="a" operator="in" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>`;
}
function trophySolid({ small = false } = {}) {
  const b = G.ball;
  if (small) {
    // favicon cut: flat fills, no star/highlight, chunkier stem + base
    return `
    <path d="${flipper(70, 100, 42, 172, 262, 18)}" fill="${C.pink}"/>
    <path d="${flipper(530, 100, 42, 428, 262, 18)}" fill="${C.pink}"/>
    <circle cx="${b.cx}" cy="${b.cy - 4}" r="${b.r + 6}" fill="${C.white}"/>
    <path d="${G.cup}" fill="${C.pink}" stroke="${C.bg}" stroke-width="44" paint-order="stroke"/>
    ${rr({ x: 112, y: 40, w: 376, h: 40, r: 14 }, `fill="${C.pink}" stroke="${C.bg}" stroke-width="28" paint-order="stroke"`)}
    <path d="${G.cup}" fill="${C.pink}"/>
    <path d="M256,326 H344 L330,470 H270 Z" fill="${C.pink}"/>
    ${rr({ x: 160, y: 460, w: 280, h: 100, r: 18 }, `fill="${C.pink}"`)}`;
  }
  return `
    <path d="${flipper(...FLIP.L)}" fill="url(#baseGrad)"/>
    <path d="${flipper(...FLIP.R)}" fill="url(#baseGrad)"/>
    <circle cx="${FLIP.L[0]}" cy="${FLIP.L[1]}" r="11" fill="${C.bg}"/>
    <circle cx="${FLIP.R[0]}" cy="${FLIP.R[1]}" r="11" fill="${C.bg}"/>
    <circle cx="${b.cx}" cy="${b.cy}" r="${b.r}" fill="url(#ballGrad)" stroke="${C.pink}" stroke-width="8"/>
    <ellipse cx="${b.cx - 20}" cy="${b.cy - 24}" rx="14" ry="9" fill="#FFFFFF" opacity="0.9" transform="rotate(-30 ${b.cx - 20} ${b.cy - 24})"/>
    <path d="${G.cup}" fill="url(#cupGrad)"/>
    <path d="M196,92 C196,214 238,276 292,300 C246,290 176,240 170,92 Z" fill="${C.core}" opacity="0.55"/>
    <path d="M300,128 l16.5,33.4 36.9,5.4 -26.7,26 6.3,36.7 -33,-17.3 -33,17.3 6.3,-36.7 -26.7,-26 36.9,-5.4 Z" fill="${C.bg}" opacity="0.85"/>
    ${rr(G.lip, `fill="${C.light}"`)}
    <path d="${G.neck}" fill="${C.dark}"/>
    ${rr(G.knot, `fill="${C.pink}"`)}
    <path d="${G.stem}" fill="${C.dark}"/>
    ${rr(G.plinth, `fill="${C.pink}"`)}
    ${rr(G.slab, `fill="url(#baseGrad)"`)}
    <rect x="${G.slab.x + 18}" y="${G.slab.y + 16}" width="${G.slab.w - 36}" height="8" rx="4" fill="${C.bg}" opacity="0.35"/>`;
}

/* ===================== Concept C — monoline arcade ===================== */
function trophyMono(w, { small = false } = {}) {
  const color = C.pink;
  const ballR = small ? 54 : 44;
  return `
  <g fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M150,70 H450 V140 C450,258 382,322 300,322 C218,322 150,258 150,140 Z"/>
    <path d="M150,104 H108 C70,104 58,140 64,170 C74,222 120,248 172,250"/>
    <path d="M450,104 H492 C530,104 542,140 536,170 C526,222 480,248 428,250"/>
    <path d="M300,322 V420"/>
    <path d="M220,470 C220,436 250,420 300,420 C350,420 380,436 380,470"/>
    <path d="M190,520 H410"/>
  </g>
  <circle cx="300" cy="${70 - w / 2 - ballR - 2}" r="${ballR}" fill="${color}"/>
  ${small ? '' : `<g stroke="${color}" stroke-width="${w * 0.55}" stroke-linecap="round" opacity="0.9">
    <path d="M206,12 L232,30"/><path d="M394,12 L368,30"/><path d="M300,-86 V-64"/>
  </g>`}`;
}
function monoDefs(scale = 1) {
  return `
  <filter id="monoGlow" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="${14 * scale}" result="a"/>
    <feFlood flood-color="${C.pink}" flood-opacity="0.6"/>
    <feComposite in2="a" operator="in" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>`;
}

/* ===================== Assembly ===================== */
const svg = (defs, body, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<title>TiltTrack</title>
<defs>${defs}</defs>
${bg ? `<rect width="1024" height="1024" fill="${bg}"/>` : ''}
${body}
</svg>
`;
const place = (inner, tx, ty, s) => `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s})">${inner}</g>`;
// centre the trophy's visual box on (cx, cy) at scale s
const centred = (inner, cx, cy, s, box = TB) =>
  place(inner, cx - ((box.x1 + box.x2) / 2) * s, cy - ((box.y1 + box.y2) / 2) * s, s);

function write(name, content) { fs.writeFileSync(path.join(OUT, name), content); }
function pair(base, defs, body) {
  write(`${base}.svg`, svg(defs, body, C.bg));
  write(`${base}-transparent.svg`, svg(defs, body, null));
}
// vertical stack: trophy (height th) + gap + wordmark (cap height wh), centred in 1024
function stack(th, gap, wh, nudge = 0) {
  const top = (1024 - (th + gap + wh)) / 2 + nudge;
  return { trophyTop: top, textTop: top + th + gap };
}
// wordmark with its top edge at `top`
function wordmarkAt(fnt, size, top, ls = 0) {
  const probe = textPath(fnt, 'TiltTrack', size, 512, 0, ls);
  const t = textPath(fnt, 'TiltTrack', size, 512, top - probe.bbox.y1, ls);
  t.h = probe.bbox.y2 - probe.bbox.y1;
  return t;
}

// ---------- A ----------
{
  const s = 0.94, th = (TB.y2 - TB.y1) * s, size = 138;
  const h = textPath(F.inter800, 'TiltTrack', size, 512, 0, 2);
  const wh = h.bbox.y2 - h.bbox.y1;
  const L = stack(th, 64, wh);
  const wm = wordmarkAt(F.inter800, size, L.textTop, 2);
  const body = `
  ${centred(trophyNeon(13), 512, L.trophyTop + th / 2, s)}
  <path d="${wm.d}" fill="${C.core}" stroke="${C.pink}" stroke-width="3" filter="url(#textGlow)"/>`;
  pair('A-logo', neonDefs(), body);
  pair('A-icon', neonDefs(1.1), centred(trophyNeon(24), 512, 512, 1.36));
  pair('A-icon-small', neonDefs(1.0), centred(trophyNeon(62, { small: true }), 512, 512, 1.24));
}

// ---------- B ----------
{
  const shield = 'M512,70 C620,112 722,128 846,128 V470 C846,700 712,858 512,954 C312,858 178,700 178,470 V128 C302,128 404,112 512,70 Z';
  const inner = 'M512,104 C614,142 708,158 814,158 V470 C814,682 694,826 512,916 C330,826 210,682 210,470 V158 C316,158 410,142 512,104 Z';
  const s = 0.8;
  const by = 668, bh = 150, bx1 = 118, bx2 = 906;
  const wm = textPath(F.inter900i, 'TiltTrack', 118, 512, 0, 0);
  const wmH = wm.bbox.y2 - wm.bbox.y1;
  const wmt = textPath(F.inter900i, 'TiltTrack', 118, 512, by + bh / 2 - wm.bbox.y1 - wmH / 2, 0);
  const banner = `
    <path d="M${bx1 - 60},${by + 40} H${bx1 + 40} V${by + bh + 40} H${bx1 - 60} L${bx1 - 20},${by + bh / 2 + 40} Z" fill="${C.deep}"/>
    <path d="M${bx2 + 60},${by + 40} H${bx2 - 40} V${by + bh + 40} H${bx2 + 60} L${bx2 + 20},${by + bh / 2 + 40} Z" fill="${C.deep}"/>
    <path d="M${bx1 + 40},${by + bh} L${bx1 + 40},${by + bh + 40} L${bx1 + 80},${by + bh} Z" fill="#3E0844"/>
    <path d="M${bx2 - 40},${by + bh} L${bx2 - 40},${by + bh + 40} L${bx2 - 80},${by + bh} Z" fill="#3E0844"/>
    <rect x="${bx1 + 40}" y="${by}" width="${bx2 - bx1 - 80}" height="${bh}" fill="url(#bannerGrad)"/>
    <rect x="${bx1 + 40}" y="${by + 10}" width="${bx2 - bx1 - 80}" height="4" fill="${C.core}" opacity="0.6"/>
    <rect x="${bx1 + 40}" y="${by + bh - 14}" width="${bx2 - bx1 - 80}" height="4" fill="${C.deep}" opacity="0.6"/>`;
  const defs = solidDefs() + `
  <linearGradient id="bannerGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.light}"/><stop offset="0.5" stop-color="${C.pink}"/><stop offset="1" stop-color="${C.dark}"/></linearGradient>
  <linearGradient id="shieldGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1A1420"/><stop offset="1" stop-color="#0B0A0D"/></linearGradient>`;
  // trophy sits between shield top (~150) and banner (668)
  const body = `
  <g filter="url(#softGlow)"><path d="${shield}" fill="${C.pink}"/></g>
  <path d="${inner}" fill="url(#shieldGrad)"/>
  <path d="${inner}" fill="none" stroke="${C.deep}" stroke-width="3" transform="translate(512 512) scale(0.955) translate(-512 -512)"/>
  ${centred(trophySolid(), 512, 415, s)}
  ${banner}
  <path d="${wmt.d}" fill="${C.bg}"/>`;
  pair('B-logo', defs, body);
  pair('B-icon', solidDefs(), centred(trophySolid(), 512, 512, 1.42));
  pair('B-icon-small', solidDefs(), centred(trophySolid({ small: true }), 512, 512, 1.56));
}

// ---------- C ----------
{
  const tilt = -9, s = 0.84;
  const box = { x1: 40, x2: 560, y1: -90, y2: 535 };
  const th = (box.y2 - box.y1) * s;
  const size = 150;
  const probe = textPath(F.russo, 'TiltTrack', size, 512, 0, 4);
  const wh = probe.bbox.y2 - probe.bbox.y1;
  const L = stack(th, 70, wh);
  const t = textPath(F.russo, 'TiltTrack', size, 512, L.textTop - probe.bbox.y1, 4);
  const tilt_ = t.ds.slice(0, 4).join(' '), track = t.ds.slice(4).join(' ');
  const cy = L.trophyTop + th / 2;
  const body = `
  <g transform="rotate(${tilt} 512 ${cy})" filter="url(#monoGlow)">${centred(trophyMono(34), 512, cy, s, box)}</g>
  <path d="${tilt_}" fill="${C.white}"/>
  <path d="${track}" fill="${C.pink}" filter="url(#monoGlow)"/>`;
  pair('C-logo', monoDefs(), body);
  const ibox = { x1: 40, x2: 560, y1: -90, y2: 535 };
  pair('C-icon', monoDefs(), `<g transform="rotate(${tilt} 512 512)" filter="url(#monoGlow)">${centred(trophyMono(42), 512, 512, 1.18, ibox)}</g>`);
  const sbox = { x1: 40, x2: 560, y1: -60, y2: 535 };
  pair('C-icon-small', monoDefs(1.4), `<g transform="rotate(${tilt} 512 512)" filter="url(#monoGlow)">${centred(trophyMono(64, { small: true }), 512, 512, 1.32, sbox)}</g>`);
}
// ---------- D: C's trophy + Inter 900 two-tone wordmark ----------
{
  const tilt = -9, s = 0.84;
  const box = { x1: 40, x2: 560, y1: -90, y2: 535 };
  const th = (box.y2 - box.y1) * s;
  // match C's wordmark width (Russo One 150, +4 tracking)
  const ref = textPath(F.russo, 'TiltTrack', 150, 512, 0, 4).bbox;
  const refW = ref.x2 - ref.x1;
  const ls = 3;
  const w1 = textPath(F.inter900, 'TiltTrack', 100, 512, 0, ls).bbox;
  const size = Math.round(100 * refW / (w1.x2 - w1.x1) * 0.96);
  const probe = textPath(F.inter900, 'TiltTrack', size, 512, 0, ls);
  const wh = probe.bbox.y2 - probe.bbox.y1;
  const L = stack(th, 70, wh);
  const t = textPath(F.inter900, 'TiltTrack', size, 512, L.textTop - probe.bbox.y1, ls);
  console.log('D size', size, 'width', (t.bbox.x2 - t.bbox.x1).toFixed(1), 'C width', refW.toFixed(1), 'bbox', t.bbox);
  const cy = L.trophyTop + th / 2;
  const body = `
  <g transform="rotate(${tilt} 512 ${cy})" filter="url(#monoGlow)">${centred(trophyMono(34), 512, cy, s, box)}</g>
  <path d="${t.ds.slice(0, 4).join(' ')}" fill="${C.white}"/>
  <path d="${t.ds.slice(4).join(' ')}" fill="${C.pink}" filter="url(#monoGlow)"/>`;
  pair('D-logo', monoDefs(), body);
  const ibox = { x1: 40, x2: 560, y1: -90, y2: 535 };
  pair('D-icon', monoDefs(), `<g transform="rotate(${tilt} 512 512)" filter="url(#monoGlow)">${centred(trophyMono(42), 512, 512, 1.18, ibox)}</g>`);
  const sbox = { x1: 40, x2: 560, y1: -60, y2: 535 };
  pair('D-icon-small', monoDefs(1.4), `<g transform="rotate(${tilt} 512 512)" filter="url(#monoGlow)">${centred(trophyMono(64, { small: true }), 512, 512, 1.32, sbox)}</g>`);
}
console.log('ok');
