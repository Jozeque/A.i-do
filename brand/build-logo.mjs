// ─────────────────────────────────────────────────────────────────────────────
// SHYOW wordmark — generator (editable source of truth).
// Builds the "Threefold Y" wordmark as pure filled vector geometry (no fonts,
// no rasters) and renders the PNG family via sharp. Re-run: node brand/build-logo.mjs
// ─────────────────────────────────────────────────────────────────────────────
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

// ---- canvas + shared metrics ----
const VBW = 1200, VBH = 260;
const T = 7, H = T / 2;              // monoline stroke width (matches the Y bars)
const CAP_TOP = 65, BASE = 195, MID = 130;   // cap band: 130u tall, vertically centred

const f = (n) => Number(n.toFixed(2));
const rect = (x1, y1, x2, y2) => `M${f(x1)} ${f(y1)}H${f(x2)}V${f(y2)}H${f(x1)}Z`;
function bar(p1, p2, w) {                     // filled parallelogram bar of width w
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1], L = Math.hypot(dx, dy);
  const px = (-dy / L) * (w / 2), py = (dx / L) * (w / 2);
  return `M${f(p1[0] + px)} ${f(p1[1] + py)}L${f(p2[0] + px)} ${f(p2[1] + py)}` +
         `L${f(p2[0] - px)} ${f(p2[1] - py)}L${f(p1[0] - px)} ${f(p1[1] - py)}Z`;
}

// ---- letters (filled outlines) ----
// S : two 270° annular lobes (geometric double-circle S), ring thickness T
function letterS(cx) {
  const ro = 36, ri = 29, tcy = 97.5, bcy = 162.5;
  const top = `M${f(cx + ro)} ${tcy}A${ro} ${ro} 0 1 0 ${cx} ${tcy + ro}` +
              `L${cx} ${tcy + ri}A${ri} ${ri} 0 1 1 ${f(cx + ri)} ${tcy}Z`;
  const bot = `M${f(cx - ro)} ${bcy}A${ro} ${ro} 0 1 0 ${cx} ${bcy - ro}` +
              `L${cx} ${bcy - ri}A${ri} ${ri} 0 1 1 ${f(cx - ri)} ${bcy}Z`;
  return top + bot;
}
// H : two stems + crossbar
function letterH(left) {
  const w = 92, r = left + w;
  return rect(left, CAP_TOP, left + T, BASE) + rect(r - T, CAP_TOP, r, BASE) +
         rect(left + T, MID - H, r - T, MID + H);
}
// O : nearly-circular ring (even-odd)
function letterO(cx) {
  const rox = 64, roy = 65, rix = 57, riy = 58, cy = MID;
  const ell = (rx, ry) => `M${f(cx - rx)} ${cy}A${rx} ${ry} 0 1 1 ${f(cx + rx)} ${cy}` +
                          `A${rx} ${ry} 0 1 1 ${f(cx - rx)} ${cy}Z`;
  return ell(rox, roy) + ell(rix, riy);
}
// W : four monoline legs, sharp flat tips
function letterW(left) {
  const w = 150, cx = left + w / 2;
  const A = [left, CAP_TOP], C = [cx, CAP_TOP], E = [left + w, CAP_TOP];
  const B = [cx - 37.5, BASE], D = [cx + 37.5, BASE];
  return bar(A, B, T) + bar(B, C, T) + bar(C, D, T) + bar(D, E, T);
}
// Y : the custom Threefold Y — each of the 3 directions is a ribbon carrying a
// central slot (= two parallel rails). Rails open at the tips; slots stop short of
// the hub so the three arms merge into one clean, solid convergence. One even-odd
// path per arm (outer ribbon minus slot) so the arms can overlap without artefacts.
function letterY(cx) {
  const hub = [cx, 112], tipY = 60, spread = 52;
  const hw = 12, sHW = 5, cg = 12, ext = 5, opener = 4; // arm half-width, slot half, hub-gap, overshoot, tip opener
  const quad = (a, b, c, d) => `M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}L${f(c[0])} ${f(c[1])}L${f(d[0])} ${f(d[1])}Z`;
  const fork = (tip) => {
    const dx = hub[0] - tip[0], dy = hub[1] - tip[1], L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L, px = -uy, py = ux;
    const oH = [hub[0] + ux * ext, hub[1] + uy * ext];   // outer ribbon: tip .. just past hub
    const sA = [tip[0] - ux * opener, tip[1] - uy * opener]; // slot opens just past the tip
    const sB = [hub[0] - ux * cg, hub[1] - uy * cg];     // slot stops short of the hub (solid centre)
    const outer = quad([tip[0]+px*hw, tip[1]+py*hw], [oH[0]+px*hw, oH[1]+py*hw], [oH[0]-px*hw, oH[1]-py*hw], [tip[0]-px*hw, tip[1]-py*hw]);
    const slot  = quad([sA[0]+px*sHW, sA[1]+py*sHW], [sB[0]+px*sHW, sB[1]+py*sHW], [sB[0]-px*sHW, sB[1]-py*sHW], [sA[0]-px*sHW, sA[1]-py*sHW]);
    return outer + slot;
  };
  return [fork([cx, BASE]), fork([cx - spread, tipY]), fork([cx + spread, tipY])];
}

// ---- assembly ----
const LETTERS = [
  ['S', [letterS(204)], false],
  ['H', [letterH(330)], false],
  ['Y', letterY(548), true],    // 3 even-odd arms
  ['O', [letterO(752)], true],  // even-odd ring
  ['W', [letterW(882)], false],
];
function paths(fill) {
  return LETTERS.flatMap(([id, arr, eo]) =>
    arr.map((d) => `  <path d="${d}" fill="${fill}"${eo ? ' fill-rule="evenodd"' : ''}/>`)
  ).join('\n');
}
function svg(fill, pxW) {
  const w = pxW || VBW, h = pxW ? Math.round(pxW * VBH / VBW) : VBH;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
         `viewBox="0 0 ${VBW} ${VBH}" fill="none">\n${paths(fill)}\n</svg>\n`;
}
function master(fill) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VBW}" height="${VBH}" ` +
         `viewBox="0 0 ${VBW} ${VBH}" fill="none">\n` +
         `  <title>SHYOW</title>\n  <desc>SHYOW wordmark — Threefold Y. Outlined vector, no fonts.</desc>\n` +
         `${paths(fill)}\n</svg>\n`;
}
function previewSVG(pxW) {
  const vh = 460, ty = 100;
  const w = pxW, h = Math.round(pxW * vh / VBW);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
         `viewBox="0 0 ${VBW} ${vh}" fill="none">\n` +
         `  <rect width="${VBW}" height="${vh}" fill="#0A0A0B"/>\n` +
         `  <g transform="translate(0 ${ty})">\n${paths('#F1EDE4')}\n  </g>\n</svg>\n`;
}

// ---- write SVGs ----
const IVORY = '#F1EDE4', WHITE = '#FFFFFF', DARK = '#0A0A0B', BLACK = '#000000';
writeFileSync(join(OUT, 'shyow-wordmark-master.svg'), master(IVORY));
writeFileSync(join(OUT, 'shyow-wordmark-primary-ivory.svg'), svg(IVORY));
writeFileSync(join(OUT, 'shyow-wordmark-white.svg'), svg(WHITE));
writeFileSync(join(OUT, 'shyow-wordmark-dark.svg'), svg(DARK));
writeFileSync(join(OUT, 'shyow-wordmark-black.svg'), svg(BLACK));

// ---- render PNGs ----
const render = (str, file) => sharp(Buffer.from(str)).png({ compressionLevel: 9 }).toFile(join(OUT, file));
const sizes = [4096, 2048, 1024, 512];
const jobs = [];
for (const s of sizes) jobs.push(render(svg(IVORY, s), `shyow-wordmark-primary-ivory-${s}.png`).then(() => `ivory ${s}×${Math.round(s * VBH / VBW)}`));
for (const s of sizes) jobs.push(render(svg(DARK, s), `shyow-wordmark-dark-${s}.png`).then(() => `dark ${s}×${Math.round(s * VBH / VBW)}`));
jobs.push(render(previewSVG(2400), 'shyow-wordmark-preview-dark-background.png').then(() => 'preview 2400×920'));

const done = await Promise.all(jobs);
console.log('Rendered:\n  ' + done.join('\n  '));
console.log('\nSVGs: master, primary-ivory, white, dark, black');
