// Builds TiltTrack's served brand assets (favicons, app icons, og-image) from the concept-D SVGs,
// plus the Instagram profile picture (kept out of the repo).
//
//   node build-icons.js <svgDir> <publicDir> <extrasDir> <fontDir>
//
// svgDir    — the D-*.svg sources (public/brand/ in the repo)
// publicDir — artifacts/pinball-tracker/public
// extrasDir — where instagram-profile-1080.png (+ a circle-masked preview) go
// fontDir   — a folder holding inter-latin-{700,900}-normal.woff2 (@fontsource/inter/files)
//
// Needs playwright-core (renders with Microsoft Edge) and sharp: installed next to this script, or
// in extra node_modules folders listed (';'-separated) after the four paths. Run it from a scratch
// copy (npm i playwright-core sharp @fontsource/inter), not from the repo.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
for (const d of (process.argv[6] || '').split(';').filter(Boolean)) module.paths.push(d);
const { chromium } = require('playwright-core');
const sharp = require('sharp');

const [svgDir, publicDir, extrasDir, fontDir] = process.argv.slice(2).map((p) => path.resolve(p));
if (!fontDir) { console.error('usage: node build-icons.js <svgDir> <publicDir> <extrasDir> <fontDir>'); process.exit(1); }

const BG = '#09090B';
const PINK = '#DD47EB';
const read = (f) => fs.readFileSync(path.join(svgDir, f), 'utf8');

// The inside of a 1024×1024 source SVG (defs + drawing), minus its <svg>, <title> and background rect.
function inner(svg) {
  return svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/<rect width="1024" height="1024" fill="#09090B"\/>/, '');
}

// The same drawing scaled by k about (cx, cy), re-centred on the canvas, on the app background.
function recentred(svg, k, cx, cy, { background = true } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">` +
    (background ? `<rect width="1024" height="1024" fill="${BG}"/>` : '') +
    `<g transform="translate(512 512) scale(${k.toFixed(4)}) translate(${(-cx).toFixed(2)} ${(-cy).toFixed(2)})">${inner(svg)}</g></svg>`;
}

async function render(page, svg, size, { transparent = false } = {}) {
  const sized = svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:${transparent ? 'transparent' : BG};overflow:hidden}svg{display:block}</style></head><body>${sized}</body></html>`);
  return page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
}

// Bounding box + furthest-from-centre radius of the solid strokes (alpha > 200 ignores the glow).
async function coreGeometry(page, transparentSvg) {
  const N = 1024;
  const png = await render(page, transparentSvg, N, { transparent: true });
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x1 = N, y1 = N, x2 = 0, y2 = 0;
  const pts = [];
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > 200) {
      if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
      if ((x + y) % 3 === 0) pts.push([x, y]);
    }
  }
  const cx = (x1 + x2 + 1) / 2, cy = (y1 + y2 + 1) / 2;
  let r = 0;
  for (const [x, y] of pts) r = Math.max(r, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
  return { x1, y1, x2, y2, cx, cy, r };
}

// A PNG as small as it'll go without visible banding: palette (with dithering) when that's no
// bigger than a lossless re-encode.
async function optimise(buf) {
  const lossless = await sharp(buf).png({ compressionLevel: 9, effort: 10 }).toBuffer();
  const palette = await sharp(buf).png({ palette: true, quality: 95, effort: 10, dither: 1, compressionLevel: 9 }).toBuffer();
  return palette.length < lossless.length ? palette : lossless;
}

// favicon.ico with PNG-encoded entries (supported by every browser that still asks for .ico).
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

(async () => {
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(extrasDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const out = async (dir, name, buf) => {
    const b = await optimise(buf);
    fs.writeFileSync(path.join(dir, name), b);
    console.log(name.padEnd(28), (b.length / 1024).toFixed(1), 'KB');
  };

  const icon = read('D-icon.svg');
  const iconT = read('D-icon-transparent.svg');
  const small = read('D-icon-small.svg');

  // favicon.svg: the small cut verbatim (no tick marks, thicker strokes), minus the fixed 1024 size.
  const favSvg = small.replace(' width="1024" height="1024"', '').replace(/\n\s*/g, '\n');
  fs.writeFileSync(path.join(publicDir, 'favicon.svg'), favSvg);
  console.log('favicon.svg'.padEnd(28), (favSvg.length / 1024).toFixed(1), 'KB');

  // favicon.ico (16/32/48) + favicon-32.png, from the small cut.
  const icoEntries = [];
  for (const size of [16, 32, 48]) {
    const png = await optimise(await render(page, small, size));
    icoEntries.push({ size, png });
    if (size === 32) { fs.writeFileSync(path.join(publicDir, 'favicon-32.png'), png); console.log('favicon-32.png'.padEnd(28), (png.length / 1024).toFixed(1), 'KB'); }
  }
  const icoBuf = ico(icoEntries);
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), icoBuf);
  console.log('favicon.ico'.padEnd(28), (icoBuf.length / 1024).toFixed(1), 'KB');

  // Opaque app icons from the full cut (iOS ignores transparency, so the background is baked in).
  await out(publicDir, 'apple-touch-icon.png', await render(page, icon, 180));
  await out(publicDir, 'icon-192.png', await render(page, icon, 192));
  await out(publicDir, 'icon-512.png', await render(page, icon, 512));

  // Maskable 512 and the Instagram picture: the solid strokes re-centred inside a circle.
  // Maskable safe zone = radius 40% of the icon; Instagram keeps ~10% clear inside its circle crop.
  const g = await coreGeometry(page, iconT);
  console.log('core bbox', g);
  const fit = (radiusFrac) => (radiusFrac * 1024) / g.r;
  await out(publicDir, 'icon-maskable-512.png', await render(page, recentred(iconT, fit(0.36), g.cx, g.cy), 512));
  const igSvg = recentred(iconT, fit(0.37), g.cx, g.cy);
  const ig = await render(page, igSvg, 1080);
  await out(extrasDir, 'instagram-profile-1080.png', ig);
  // Preview: what the circle crop leaves, with the 10%-margin ring drawn faintly for checking.
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><circle cx="540" cy="540" r="540" fill="#fff"/></svg>`);
  const ring = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><circle cx="540" cy="540" r="${540 * 0.9}" fill="none" stroke="#ffffff" stroke-opacity="0.25" stroke-width="2" stroke-dasharray="10 10"/></svg>`);
  const masked = await sharp(ig).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const preview = await sharp({ create: { width: 1200, height: 1200, channels: 4, background: '#ffffff' } })
    .composite([{ input: masked, left: 60, top: 60 }, { input: ring, left: 60, top: 60 }]).png().toBuffer();
  fs.writeFileSync(path.join(extrasDir, 'instagram-profile-preview.png'), preview);
  console.log('instagram-profile-preview.png written');

  // og-image.png, 1200×630: the trophy, the live-text wordmark (Inter 900, same as the logo's
  // outlined wordmark) and the /welcome hero headline.
  const font = (w) => pathToFileURL(path.join(fontDir, `inter-latin-${w}-normal.woff2`)).href;
  const ogTrophy = recentred(iconT, fit(0.47), g.cx, g.cy, { background: false })
    .replace('width="1024" height="1024"', 'width="380" height="380"');
  const ogHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:InterB;font-weight:900;src:url(${font(900)})}
    @font-face{font-family:InterB;font-weight:700;src:url(${font(700)})}
    html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:${BG};font-family:InterB}
    .wrap{position:relative;width:1200px;height:630px;display:flex;align-items:center;gap:36px;padding:0 80px 0 64px;box-sizing:border-box;
      background:radial-gradient(ellipse 620px 520px at 250px 300px, rgba(221,71,235,.16), transparent 70%)}
    svg{flex:none;display:block}
    .wm{font-weight:900;font-size:118px;letter-spacing:.02em;line-height:1;color:#fff;margin:0}
    .wm b{color:${PINK};font-weight:900;text-shadow:0 0 18px rgba(221,71,235,.55)}
    .tag{margin-top:34px;font-weight:700;font-size:42px;line-height:1.2;color:#fff}
    .tag span{color:${PINK};text-shadow:0 0 16px rgba(221,71,235,.5)}
    .url{margin-top:28px;font-weight:700;font-size:24px;color:#7a7a85;letter-spacing:.01em}
  </style></head><body><div class="wrap">${ogTrophy}<div>
    <p class="wm">Tilt<b>Track</b></p>
    <div class="tag">Snap your score.<br><span>See if you’re getting better.</span></div>
    <div class="url">tilttrack.vercel.app</div>
  </div></div></body></html>`;
  const ogFile = path.join(extrasDir, 'og-source.html');
  fs.writeFileSync(ogFile, ogHtml);
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.goto(pathToFileURL(ogFile).href);
  await page.evaluate(() => document.fonts.ready);
  await out(publicDir, 'og-image.png', await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 } }));

  await browser.close();
})();
