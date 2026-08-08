/**
 * Mengubah assets/avatar.(jpg|png) menjadi assets/avatar.svg:
 * potret line-art vektor yang menggambar dirinya sendiri.
 *
 * Dua lapis garis, sengaja digabung supaya wajahnya tetap kenal:
 *   1. SHADING  - tiap baris horizontal adalah satu garis bergelombang.
 *                 Amplitudo & rapatnya gelombang mengikuti gelap-terang foto,
 *                 jadi tonalitas (bayangan pipi, rambut, jas) ikut terbawa.
 *   2. KONTUR   - deteksi tepi Canny yang ditelusuri jadi polyline, dipakai
 *                 menegaskan mata, hidung, mulut, dan garis rambut.
 *
 * Semua murni <path>, tanpa bitmap, jadi ukurannya kecil dan bisa dianimasikan
 * lewat stroke-dashoffset.
 *
 * Ganti foto:  taruh file baru di assets/avatar.jpg (atau .png), lalu
 *              npm run avatar
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

// ─────────────────────────── setelan ───────────────────────────
// Bingkai potret, dalam pecahan lebar foto asli. Atur ini kalau ganti foto:
// perbesar CROP agar lebih banyak badan, geser CX/CY untuk memusatkan wajah.
const CROP = 0.64;     // sisi kotak yang diambil
const CX = 0.50;       // titik pusat mendatar
const CY = 0.54;       // titik pusat menegak (di bawah tengah = kepala + bahu)

const SIZE = 440;      // sisi kanvas kerja (piksel)
const ROW_GAP = 3.4;   // jarak antar garis shading
const STEP = 1.6;      // jarak sampel saat garis sedang bergelombang
const FLAT_STEP = 14;  // jarak sampel saat garis nyaris lurus (menghemat ukuran)
const GAMMA = 0.80;    // < 1 memucatkan warna tengah, menyisakan yang benar-benar gelap
const CONTRAST = 1.40; // kurva S: terang makin terang, bayangan makin pekat
const BRIGHT = 0.05;   // angkat keseluruhan supaya kulit tidak ikut jadi hitam
const EDGE_LO = 0.16;  // ambang bawah histeresis Canny
const EDGE_HI = 0.34;  // ambang atas histeresis Canny
const MIN_EDGE_LEN = 9;// buang serpihan tepi yang lebih pendek dari ini
const RDP_EPS = 0.7;   // toleransi penyederhanaan polyline

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────── muat & normalkan ──────────────────────
function loadPixels() {
  const names = ['avatar.png', 'avatar.jpg', 'avatar.jpeg'];
  const path = names.map((n) => join(root, 'assets', n)).find((p) => existsSync(p));
  if (!path) {
    console.error(`Tidak menemukan sumber avatar. Taruh salah satu di assets/: ${names.join(', ')}`);
    process.exit(1);
  }
  const buf = readFileSync(path);
  const img = path.endsWith('.png') ? PNG.sync.read(buf) : jpeg.decode(buf, { useTArray: true });
  return { data: img.data, w: img.width, h: img.height, path };
}

/** Potong bingkai potret -> abu-abu -> diperkecil ke SIZE, dengan rata-rata area. */
function toGray({ data, w, h }) {
  const side = Math.round(Math.min(w, h) * CROP);
  const ox = Math.min(w - side, Math.max(0, Math.round(w * CX - side / 2)));
  const oy = Math.min(h - side, Math.max(0, Math.round(h * CY - side / 2)));
  const scale = side / SIZE;
  const out = new Float32Array(SIZE * SIZE);

  for (let y = 0; y < SIZE; y++) {
    const y0 = oy + Math.floor(y * scale);
    const y1 = Math.max(y0 + 1, oy + Math.floor((y + 1) * scale));
    for (let x = 0; x < SIZE; x++) {
      const x0 = ox + Math.floor(x * scale);
      const x1 = Math.max(x0 + 1, ox + Math.floor((x + 1) * scale));
      let sum = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * w + sx) * 4;
          sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          n++;
        }
      }
      out[y * SIZE + x] = sum / n / 255;
    }
  }
  return out;
}

/** Regangkan kontras memakai persentil 2%/98% supaya foto apa pun kebagian rentang penuh. */
function autoLevels(g) {
  const hist = new Int32Array(256);
  for (const v of g) hist[Math.min(255, Math.max(0, Math.round(v * 255)))]++;
  const lowCut = g.length * 0.02;
  const highCut = g.length * 0.98;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= lowCut) { lo = i; break; }
  }
  acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= highCut) { hi = i; break; }
  }
  const span = Math.max(1, hi - lo) / 255;
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) {
    out[i] = Math.min(1, Math.max(0, (g[i] - lo / 255) / span));
  }
  return out;
}

/**
 * Kurva S di sekitar warna tengah. Tanpa ini semua bagian foto dapat jatah
 * gelombang yang mirip-mirip, dan potretnya jadi rata tanpa bentuk.
 */
function curve(g) {
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) {
    out[i] = Math.min(1, Math.max(0, (g[i] - 0.5) * CONTRAST + 0.5 + BRIGHT));
  }
  return out;
}

function blur(src, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;

  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const at = (x, n) => Math.min(n - 1, Math.max(0, x));

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * src[y * SIZE + at(x + i, SIZE)];
      tmp[y * SIZE + x] = v;
    }
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * tmp[at(y + i, SIZE) * SIZE + x];
      out[y * SIZE + x] = v;
    }
  }
  return out;
}

/**
 * Bobot radial: makin ke tepi lingkaran makin diredam, supaya latar belakang
 * meluruh jadi garis tenang dan wajah tetap jadi pusat perhatian.
 */
function vignette(x, y) {
  // elips, bukan lingkaran: subjeknya lebih tinggi daripada lebar, jadi tiang
  // dan bangunan di kiri-kanan ikut teredam sementara kepalanya tetap utuh
  const dx = (x - SIZE * 0.5) / (SIZE * 0.30);
  const dy = (y - SIZE * 0.47) / (SIZE * 0.42);
  const r = Math.hypot(dx, dy);
  if (r < 0.72) return 1;
  if (r > 1.06) return 0.02;
  const t = (r - 0.72) / 0.34;
  return Math.max(0.02, 1 - 0.98 * t * t);
}

// ────────────────────────── lapis 1: shading ─────────────────────────
/**
 * Tiap baris jadi satu garis utuh yang melintasi bingkai. Bagian terang tetap
 * kebagian garis (nyaris lurus), bagian gelap bergelombang rapat dan tinggi --
 * itu yang membuat tonalitas wajahnya terbaca, bukan cuma tepinya.
 */
function shadingPaths(gray) {
  const sample = (x, y) => {
    const xi = Math.min(SIZE - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(SIZE - 1, Math.max(0, Math.round(y)));
    return gray[yi * SIZE + xi];
  };
  const paths = [];

  for (let y = ROW_GAP; y < SIZE - ROW_GAP; y += ROW_GAP) {
    const pts = [];
    let phase = 0;
    let x = 0;

    while (x <= SIZE) {
      const ink = Math.pow(1 - sample(x, y), 1 / GAMMA) * vignette(x, y);
      // gelap -> gelombang lebih rapat dan lebih tinggi
      phase += STEP * (0.5 + 1.7 * ink);
      const amp = ink * ROW_GAP * 1.18;
      pts.push([x, y + Math.sin(phase) * amp]);
      // di daerah datar cukup sedikit titik; hemat ukuran berkas
      x += ink < 0.06 ? FLAT_STEP : STEP;
    }
    if (pts.length > 3) paths.push(pts);
  }
  return paths;
}

// ─────────────────────── lapis 2: kontur (Canny) ──────────────────────
function cannyPolylines(gray) {
  const g = blur(gray, 1.35);
  const mag = new Float32Array(SIZE * SIZE);
  const dir = new Uint8Array(SIZE * SIZE);

  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const i = y * SIZE + x;
      const gx =
        -g[i - SIZE - 1] - 2 * g[i - 1] - g[i + SIZE - 1] +
        g[i - SIZE + 1] + 2 * g[i + 1] + g[i + SIZE + 1];
      const gy =
        -g[i - SIZE - 1] - 2 * g[i - SIZE] - g[i - SIZE + 1] +
        g[i + SIZE - 1] + 2 * g[i + SIZE] + g[i + SIZE + 1];
      mag[i] = Math.hypot(gx, gy) * vignette(x, y);
      // bulatkan arah gradien ke 0/45/90/135 derajat
      let a = (Math.atan2(gy, gx) * 180) / Math.PI;
      if (a < 0) a += 180;
      dir[i] = a < 22.5 || a >= 157.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3;
    }
  }

  // penekanan non-maksimum: sisakan puncak tepi selebar 1 piksel
  const thin = new Float32Array(SIZE * SIZE);
  const off = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const i = y * SIZE + x;
      const [dx, dy] = off[dir[i]];
      const m = mag[i];
      if (m >= mag[i + dy * SIZE + dx] && m >= mag[i - dy * SIZE - dx]) thin[i] = m;
    }
  }

  // histeresis: piksel kuat jadi benih, piksel lemah ikut kalau nyambung
  const keep = new Uint8Array(SIZE * SIZE);
  const stack = [];
  for (let i = 0; i < thin.length; i++) {
    if (thin[i] >= EDGE_HI) { keep[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % SIZE;
    const y = (i / SIZE) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 1 || ny < 1 || nx >= SIZE - 1 || ny >= SIZE - 1) continue;
        const j = ny * SIZE + nx;
        if (!keep[j] && thin[j] >= EDGE_LO) { keep[j] = 1; stack.push(j); }
      }
    }
  }

  // telusuri piksel tepi jadi polyline, mulai dari ujung-ujung dulu
  const used = new Uint8Array(SIZE * SIZE);
  const neighbours = (i) => {
    const x = i % SIZE;
    const y = (i / SIZE) | 0;
    const out = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const j = ny * SIZE + nx;
        if (keep[j]) out.push(j);
      }
    }
    return out;
  };

  const walk = (start) => {
    const pts = [];
    let i = start;
    while (i !== undefined && !used[i]) {
      used[i] = 1;
      pts.push([i % SIZE, (i / SIZE) | 0]);
      i = neighbours(i).find((j) => !used[j]);
    }
    return pts;
  };

  const lines = [];
  const seeds = [];
  for (let i = 0; i < keep.length; i++) {
    if (keep[i] && neighbours(i).length === 1) seeds.push(i);
  }
  for (const s of [...seeds, ...keep.keys()].filter((i) => keep[i] && !used[i])) {
    const pts = walk(s);
    if (pts.length >= MIN_EDGE_LEN) lines.push(rdp(pts, RDP_EPS));
  }
  return lines;
}

/** Ramer-Douglas-Peucker: buang titik yang tidak mengubah bentuk garis. */
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  let maxD = -1;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

// ───────────────────────────── keluaran ────────────────────────────
const n = (v) => Math.round(v * 10) / 10;
const toPath = (pts) => `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join('L')}`;

const src = loadPixels();
const gray = curve(autoLevels(blur(toGray(src), 0.7)));
const shade = shadingPaths(gray);
const edges = cannyPolylines(gray);

// digambar dari atas ke bawah supaya animasinya terbaca seperti tangan menggores
const order = (pts) => pts[0][1];
shade.sort((a, b) => order(a) - order(b));
edges.sort((a, b) => order(a) - order(b));

const DRAW = 2.6; // detik untuk menyelesaikan seluruh gambar
const svgPaths = (list, cls, spanStart, spanEnd) =>
  list
    .map((pts, i) => {
      const delay = spanStart + (spanEnd - spanStart) * (i / Math.max(1, list.length - 1));
      return `<path class="${cls}" d="${toPath(pts)}" pathLength="100" style="animation-delay:${delay.toFixed(2)}s" />`;
    })
    .join('\n    ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="Potret garis Ryan Ramadhan">
  <defs>
    <clipPath id="circle"><circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2 - 40}" /></clipPath>
    <!--
      userSpaceOnUse, bukan objectBoundingBox: baris shading yang lurus sempurna
      punya kotak pembatas setinggi nol, dan gradien objectBoundingBox di atas
      kotak sedegenerat itu membuat elemennya tidak dirender sama sekali.
      Koordinat ruang-pengguna juga membuat gradiennya satu arah untuk seluruh
      potret, bukan mengulang per garis.
    -->
    <linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${SIZE * 0.45}" y2="${SIZE}">
      <stop offset="0%" stop-color="#C7D2FE" />
      <stop offset="55%" stop-color="#A78BFA" />
      <stop offset="100%" stop-color="#38BDF8" />
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366F1" />
      <stop offset="50%" stop-color="#8B5CF6" />
      <stop offset="100%" stop-color="#0EA5E9" />
    </linearGradient>
    <radialGradient id="glow">
      <stop offset="55%" stop-color="#8B5CF6" stop-opacity="0" />
      <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0.30" />
    </radialGradient>
    <style>
      /*
        Keadaan diam sengaja dibuat "sudah tergambar" (dashoffset 0), lalu
        animasinya berangkat MUNDUR dari panjang garis lewat backwards.
        Kalau dibalik -- diam = tersembunyi, ditahan pakai forwards -- gambarnya
        lenyap lagi begitu animasinya kelar.
      */
      .shade, .edge {
        fill: none; stroke: url(#ink); stroke-linecap: round; stroke-linejoin: round;
        stroke-dasharray: 100; stroke-dashoffset: 0;
        animation: draw ${DRAW}s ease-out backwards;
      }
      .shade { stroke-width: 1.05; opacity: .82 }
      .edge  { stroke-width: 1.35; opacity: 1 }
      @keyframes draw { from { stroke-dashoffset: 100 } }

      .spin  { transform-origin: ${SIZE / 2}px ${SIZE / 2}px; animation: spin 16s linear infinite }
      .spin2 { transform-origin: ${SIZE / 2}px ${SIZE / 2}px; animation: spin 26s linear infinite reverse }
      .pulse { animation: pulse 4s ease-in-out infinite }
      @keyframes spin  { to { transform: rotate(360deg) } }
      @keyframes pulse { 0%,100% { opacity:.4 } 50% { opacity:.9 } }

      @media (prefers-reduced-motion: reduce) {
        .shade, .edge { animation: none }
        .spin, .spin2, .pulse { animation: none }
      }
    </style>
  </defs>

  <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2 - 4}" fill="url(#glow)" class="pulse" />

  <g clip-path="url(#circle)">
    ${svgPaths(shade, 'shade', 0, DRAW * 0.55)}
    ${svgPaths(edges, 'edge', DRAW * 0.35, DRAW * 0.8)}
  </g>

  <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2 - 27}" fill="none" stroke="url(#ring)" stroke-width="3"
          stroke-linecap="round" stroke-dasharray="170 70 100 70" class="spin" />
  <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2 - 12}" fill="none" stroke="url(#ring)" stroke-width="2"
          stroke-linecap="round" stroke-dasharray="26 50" opacity="0.55" class="spin2" />
</svg>
`;

writeFileSync(join(root, 'assets', 'avatar.svg'), svg);
console.log(
  `assets/avatar.svg dibuat dari ${src.path.split(/[\\/]/).pop()} — ` +
    `${shade.length} garis shading, ${edges.length} garis kontur, ` +
    `${(Buffer.byteLength(svg) / 1024).toFixed(0)} KB`,
);
