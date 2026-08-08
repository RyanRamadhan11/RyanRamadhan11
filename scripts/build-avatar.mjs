/**
 * Mengubah assets/avatar.(jpg|png) menjadi assets/avatar.svg:
 * potret line-art vektor yang menggambar dirinya sendiri.
 *
 * Tiga lapis garis, sengaja digabung supaya wajahnya tetap kenal:
 *   1. SUBJEK  - tiap baris horizontal adalah satu garis bergelombang, dipotong
 *                di batas orangnya. Amplitudo & rapatnya gelombang mengikuti
 *                terang foto, jadi tonalitas wajah ikut terbawa.
 *   2. KONTUR  - deteksi tepi Canny yang ditelusuri jadi polyline, dipakai
 *                menegaskan mata, hidung, mulut, dan garis rambut. Tanpa lapis
 *                ini wajahnya hilang sama sekali -- sudah diuji.
 *   3. LATAR   - lapis yang sama untuk luar subjek, tapi renggang dan redup,
 *                supaya bulatannya terisi penuh tanpa menenggelamkan potretnya.
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
// Bingkainya dihitung sendiri dari wajah yang terdeteksi. Kalau meleset --
// misalnya fotonya rombongan atau wajahnya menyamping -- isi FRAME di bawah
// ini dengan { crop, cx, cy } dalam pecahan lebar foto untuk memaksanya.
const FRAME = null;    // contoh: { crop: 0.66, cx: 0.5, cy: 0.52 }
const ZOOM = 2.0;      // sisi bingkai, dalam kelipatan tinggi wajah

const SIZE = 560;      // sisi kanvas kerja (piksel)
const ROW_GAP = 2.6;   // jarak antar garis shading
// Amplitudo maksimum HARUS di bawah setengah ROW_GAP. Kalau lebih, gelombang
// baris bertabrakan dengan tetangganya dan detail wajah saling menelan --
// itu yang bikin versi sebelumnya jadi bubur.
const AMP = 0.46;      // amplitudo puncak, dalam kelipatan ROW_GAP
const STEP = 1.5;      // jarak sampel saat garis sedang bergelombang
const FLAT_STEP = 13;  // jarak sampel saat garis nyaris lurus (menghemat ukuran)
const SCAN_STEP = 2;   // langkah pemindaian di luar subjek (mempertajam siluet)
const BG_INK = 0.34;   // seberapa kuat latar di dalam lingkaran ikut digambar
const SHARPEN = 0.45;  // penajaman lokal; ini yang membuat mata & bibir terbaca
const GAMMA = 1.0;     // 1 = pemetaan lurus dari terang ke kerapatan garis
const CONTRAST = 1.05; // kurva S ringan; terlalu keras bikin wajahnya cekung dan tua
const BRIGHT = 0.12;   // angkat keseluruhan supaya kulit terisi penuh, bukan berongga
const EDGE_LO = 0.14;  // ambang bawah histeresis Canny
const EDGE_HI = 0.30;  // ambang atas histeresis Canny
const MIN_EDGE_LEN = 26; // buang serpihan tepi yang lebih pendek dari ini
const RDP_EPS = 0.6;   // toleransi penyederhanaan polyline

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

/**
 * Cari wajah lewat warna kulit, lalu ambil gumpalan terbesar yang paling dekat
 * ke tengah-atas foto. Batas atas r-g menyingkirkan benda merah pekat seperti
 * selempang wisuda, yang sebaliknya lolos sebagai "kulit"; memilih satu
 * gumpalan juga membuang wajah orang lain yang ikut terpotret di tepi.
 */
function detectFace({ data, w, h }) {
  const isSkin = (r, g, b) =>
    r > 80 && g > 30 && b > 15 &&
    Math.max(r, g, b) - Math.min(r, g, b) > 12 &&
    r > g + 8 && r > b + 12 && r - g < 70;

  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < w * h; p++, i += 4) {
    if (isSkin(data[i], data[i + 1], data[i + 2])) mask[p] = 1;
  }

  // pelabelan komponen terhubung, iteratif supaya tumpukan panggilan aman
  const seen = new Uint8Array(w * h);
  let best = null;
  for (let p = 0; p < w * h; p++) {
    if (!mask[p] || seen[p]) continue;
    const stack = [p];
    seen[p] = 1;
    let x0 = w, x1 = 0, y0 = h, y1 = 0, area = 0;
    while (stack.length) {
      const q = stack.pop();
      const x = q % w;
      const y = (q / w) | 0;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const r = ny * w + nx;
          if (mask[r] && !seen[r]) { seen[r] = 1; stack.push(r); }
        }
      }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const aspect = bw / bh;
    if (area < w * h * 0.004 || aspect < 0.45 || aspect > 1.9) continue;
    // lebih suka yang besar, tegak, dan dekat sumbu tengah
    const offCentre = Math.abs((x0 + x1) / 2 / w - 0.5);
    const score = area * (1 - offCentre) * (1 - Math.abs(aspect - 0.8) / 2);
    if (!best || score > best.score) best = { score, x0, x1, y0, y1, bw, bh };
  }
  return best;
}

/**
 * Ukur rambutnya: piksel gelap yang menyambung ke tepi atas kotak wajah.
 * Elips tebakan selalu meleset -- kalau kelebaran ia menangkap latar dan
 * kepalanya jadi kotak, kalau kesempitan rambutnya terpotong. Lebarnya dibatasi
 * terhadap kotak wajah supaya, kalau warna gelapnya bocor ke bangunan di
 * belakang, kepalanya tidak ikut melar.
 */
function detectHead({ data, w, h }, face) {
  if (!face) return null;
  const luma = (i) => (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;

  // jendela pencarian: sedikit lebih lebar dari wajah, dari atas kepala sampai
  // sedikit di bawah garis mata
  const wx0 = Math.max(0, Math.round(face.x0 - face.bw * 0.45));
  const wx1 = Math.min(w - 1, Math.round(face.x1 + face.bw * 0.45));
  const wy0 = Math.max(0, Math.round(face.y0 - face.bh * 0.85));
  const wy1 = Math.min(h - 1, Math.round(face.y0 + face.bh * 0.3));

  const dark = 0.34;
  const cx = Math.round((face.x0 + face.x1) / 2);
  const isDark = (x, y) => luma((y * w + x) * 4) <= dark;

  // Pemindaian per baris keluar dari sumbu tengah, BUKAN flood fill. Rambutnya
  // menempel pada atap gelap di belakang, dan flood fill menembus lewat titik
  // sentuh itu lalu mengukur seluruh bangunan sebagai kepala.
  // Baris yang menabrak batas ini dianggap bocor ke latar gelap dan DIBUANG,
  // bukan ikut dirata-rata: kebocoran hanya bisa membesarkan ukuran, jadi
  // merata-ratakannya tetap menghasilkan kepala yang kelebaran.
  const limit = Math.round(face.bw * 0.72);
  const halves = [];
  for (let y = Math.round(face.y0 - face.bh * 0.42); y <= face.y0; y++) {
    if (y < wy0 || y > wy1 || !isDark(cx, y)) continue;
    let l = cx;
    while (l - 1 >= wx0 && cx - l < limit && isDark(l - 1, y)) l--;
    let r = cx;
    while (r + 1 <= wx1 && r - cx < limit && isDark(r + 1, y)) r++;
    if (cx - l >= limit || r - cx >= limit) continue;
    halves.push({ half: (r - l) / 2, mid: (l + r) / 2 });
  }
  if (halves.length < 3) return null;

  const mid = (arr) => arr.sort((a, b) => a - b)[arr.length >> 1];
  const half = mid(halves.map((s) => s.half));
  const centre = mid(halves.map((s) => s.mid));

  // puncak rambut: naik di sumbu tengah selama masih gelap, dengan batas tinggi
  // kepala yang masuk akal supaya tidak ikut naik ke atap
  const ceiling = Math.round(face.y0 - face.bh * 0.55);
  let top = face.y0;
  while (top - 1 >= ceiling && isDark(cx, top - 1)) top--;

  return { cx: centre, half, top };
}

/** Bingkai potret: dari wajah kalau terdeteksi, kalau tidak dari tengah foto. */
function frameFor(src, face) {
  const { w, h } = src;
  if (FRAME) {
    return { side: Math.round(Math.min(w, h) * FRAME.crop), cxPx: w * FRAME.cx, cyPx: h * FRAME.cy };
  }
  if (!face) {
    const side = Math.round(Math.min(w, h) * 0.8);
    return { side, cxPx: w / 2, cyPx: h / 2 };
  }
  const side = Math.min(Math.min(w, h), Math.round(face.bh * ZOOM));
  return {
    side,
    cxPx: (face.x0 + face.x1) / 2,
    // digeser ke bawah supaya rambut tidak terpotong dan bahunya ikut masuk
    cyPx: (face.y0 + face.y1) / 2 + face.bh * 0.28,
  };
}

/** Potong bingkai potret -> abu-abu -> diperkecil ke SIZE, dengan rata-rata area. */
function toGray({ data, w, h }, frame) {
  const side = frame.side;
  const ox = Math.min(w - side, Math.max(0, Math.round(frame.cxPx - side / 2)));
  const oy = Math.min(h - side, Math.max(0, Math.round(frame.cyPx - side / 2)));
  const scale = side / SIZE;
  frame.ox = ox;
  frame.oy = oy;
  frame.scale = scale;
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

/**
 * Unsharp mask: kurangi versi yang diburamkan lebar, sisanya detail halus lalu
 * dikuatkan. Tanpa ini mata, lubang hidung, dan garis bibir cuma jadi bercak
 * abu-abu yang seragam -- persis kenapa potretnya tadi tidak kelihatan mirip.
 */
function sharpen(g) {
  const low = blur(g, 7);
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) {
    out[i] = Math.min(1, Math.max(0, g[i] + SHARPEN * (g[i] - low[i])));
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

/** Diisi di bagian keluaran, begitu wajah dan bingkainya diketahui. */
let subject = () => 1;

/** 1 di bawah `inner`, 0 di atas `outer`, melandai halus di antaranya. */
function falloff(v, inner, outer) {
  if (v <= inner) return 1;
  if (v >= outer) return 0;
  const t = (v - inner) / (outer - inner);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Topeng subjek: elips kepala ditambah badan yang melebar ke bawah, keduanya
 * diturunkan dari kotak wajah hasil deteksi.
 *
 * Vignette elips tetap yang dipakai sebelumnya tidak cukup: latar bangunan itu
 * duduk TEPAT di kiri-kanan kepala, jadi jaraknya ke pusat sama dengan pipi --
 * tidak ada bentuk radial yang bisa memisahkan keduanya. Bentuk yang mengikuti
 * orangnya bisa.
 */
function makeSubjectMask(face, head, frame) {
  if (!face) return () => 1;
  const { ox, oy, scale } = frame;
  const fw = face.bw / scale;
  const chin = (face.y1 - oy) / scale;

  // Elipsnya dipasang pada rambut yang benar-benar terukur: lebarnya dari lebar
  // rambut, puncaknya dari puncak rambut, bawahnya dari dagu. Sebelumnya semua
  // itu ditebak dari kotak wajah, dan tebakan yang kelebaran itulah yang bikin
  // kepalanya terbaca sebagai kotak.
  // Hanya PUNCAK rambut yang diambil dari pengukuran: memindai ke atas di sumbu
  // tengah itu andal. Lebar dan pusatnya tidak -- di kiri-kanan kepala ada
  // bangunan yang sama gelapnya, jadi pemindaian mendatar ikut menelannya dan
  // kepalanya melenceng. Keduanya diambil dari kotak wajah yang jauh stabil.
  const hx = ((face.x0 + face.x1) / 2 - ox) / scale;
  const top = head ? (head.top - oy) / scale : (face.y0 - oy) / scale - fw * 0.3;
  const rx = fw * 0.46;
  const ry = Math.max(rx * 0.9, (chin - top) / 2);
  const hy = top + ry;
  const neckY = hy + ry * 0.86;

  return (x, y) => {
    const inHead = falloff(Math.hypot((x - hx) / rx, (y - hy) / ry), 0.90, 1.18);
    if (y < neckY) return inHead;
    const drop = (y - neckY) / Math.max(1, SIZE - neckY);
    const halfW = rx * (0.82 + 1.7 * drop);
    const body = falloff(Math.abs(x - hx) / halfW, 0.88, 1.14);
    return Math.max(inHead, body);
  };
}

// ────────────────────────── lapis 1: shading ─────────────────────────
/**
 * Tiap baris jadi satu garis utuh yang melintasi bingkai. Bagian terang tetap
 * kebagian garis (nyaris lurus), bagian gelap bergelombang rapat dan tinggi --
 * itu yang membuat tonalitas wajahnya terbaca, bukan cuma tepinya.
 */
function shadingPaths(gray, wantSubject) {
  const sample = (x, y) => {
    const xi = Math.min(SIZE - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(SIZE - 1, Math.max(0, Math.round(y)));
    return gray[yi * SIZE + xi];
  };
  const paths = [];
  // latar cukup digambar setengah rapat dan setengah teliti -- ia cuma alas,
  // dan kerapatan penuh di sana melipatgandakan ukuran berkas tanpa guna
  const gap = wantSubject ? ROW_GAP : ROW_GAP * 2;
  const step = wantSubject ? STEP : STEP * 1.9;

  for (let y = gap; y < SIZE - gap; y += gap) {
    let pts = null;
    let phase = 0;
    let x = 0;
    const flush = () => {
      if (pts && pts.length > 2) paths.push(pts);
      pts = null;
      phase = 0;
    };

    while (x <= SIZE) {
      const inside = subject(x, y);
      // Dua lapis terpisah, bukan satu. Kalau latar dan subjek digambar dengan
      // pena yang sama, teksturnya serba sama dan potretnya tenggelam; kalau
      // latarnya dibuang sama sekali, bulatannya jadi bolong dan nanggung.
      if (wantSubject ? inside < 0.10 : inside >= 0.10) {
        flush();
        // langkah kecil, bukan FLAT_STEP: langkah besar membuat titik masuk ke
        // subjek terkuantisasi, dan siluetnya jadi bertangga
        x += SCAN_STEP;
        continue;
      }
      // Tinta mengikuti TERANG, bukan gelap. Kartunya berlatar gelap dan
      // garisnya berwarna terang, jadi bagian yang banyak garis terbaca terang.
      // Dipetakan terbalik, wajahnya yang tersorot cahaya malah jadi lubang
      // kosong dan latar yang gelap justru dipenuhi garis.
      const tone = Math.pow(sample(x, y), 1 / GAMMA);
      const ink = wantSubject ? tone * inside : tone * BG_INK;
      // makin terang -> gelombang lebih rapat dan lebih tinggi
      phase += step * (0.5 + 1.7 * ink);
      const amp = ink * gap * AMP;
      if (!pts) pts = [];
      pts.push([x, y + Math.sin(phase) * amp]);
      // di daerah datar cukup sedikit titik; hemat ukuran berkas
      x += ink < 0.06 ? FLAT_STEP : step;
    }
    flush();
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
      mag[i] = Math.hypot(gx, gy) * subject(x, y);
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
const face = detectFace(src);
const frame = frameFor(src, face);
const gray = curve(sharpen(autoLevels(blur(toGray(src, frame), 0.6))));
const head = detectHead(src, face);
subject = makeSubjectMask(face, head, frame); // butuh ox/oy/scale yang diisi toGray

const shade = shadingPaths(gray, true);
const back = shadingPaths(gray, false);
const edges = cannyPolylines(gray);

// digambar dari atas ke bawah supaya animasinya terbaca seperti tangan menggores
const order = (pts) => pts[0][1];
shade.sort((a, b) => order(a) - order(b));
back.sort((a, b) => order(a) - order(b));
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
      <stop offset="0%" stop-color="#FFFFFF" />
      <stop offset="60%" stop-color="#F2F5FF" />
      <stop offset="100%" stop-color="#DCE3F5" />
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
      .shade, .edge, .bg {
        fill: none; stroke: url(#ink); stroke-linecap: round; stroke-linejoin: round;
        stroke-dasharray: 100; stroke-dashoffset: 0;
        animation: draw ${DRAW}s ease-out backwards;
      }
      .shade { stroke-width: 1.05; opacity: .82 }
      .edge  { stroke-width: 1.3; opacity: 1 }
      .bg    { stroke-width: 0.85; opacity: .26 }
      @keyframes draw { from { stroke-dashoffset: 100 } }

      .spin  { transform-origin: ${SIZE / 2}px ${SIZE / 2}px; animation: spin 16s linear infinite }
      .spin2 { transform-origin: ${SIZE / 2}px ${SIZE / 2}px; animation: spin 26s linear infinite reverse }
      .pulse { animation: pulse 4s ease-in-out infinite }
      @keyframes spin  { to { transform: rotate(360deg) } }
      @keyframes pulse { 0%,100% { opacity:.4 } 50% { opacity:.9 } }

      @media (prefers-reduced-motion: reduce) {
        .shade, .edge, .bg { animation: none }
        .spin, .spin2, .pulse { animation: none }
      }
    </style>
  </defs>

  <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2 - 4}" fill="url(#glow)" class="pulse" />

  <g clip-path="url(#circle)">
    ${svgPaths(back, 'bg', 0, DRAW * 0.45)}
    ${svgPaths(shade, 'shade', DRAW * 0.1, DRAW * 0.6)}
    ${svgPaths(edges, 'edge', DRAW * 0.4, DRAW * 0.85)}
  </g>

  <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2 - 27}" fill="none" stroke="url(#ring)" stroke-width="3"
          stroke-linecap="round" stroke-dasharray="170 70 100 70" class="spin" />
  <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2 - 12}" fill="none" stroke="url(#ring)" stroke-width="2"
          stroke-linecap="round" stroke-dasharray="26 50" opacity="0.55" class="spin2" />
</svg>
`;

writeFileSync(join(root, 'assets', 'avatar.svg'), svg);
console.log(`rambut terukur: ${head ? `setengah-lebar ${Math.round(head.half)}, pusat ${Math.round(head.cx)}, puncak ${Math.round(head.top)}` : "TIDAK ADA"}`);
console.log(`wajah terdeteksi: ${face ? `${face.bw}x${face.bh} @ ${(face.x0 + face.x1) / 2 | 0},${(face.y0 + face.y1) / 2 | 0}` : "TIDAK ADA -- pakai tengah foto"}`);
console.log(
  `assets/avatar.svg dibuat dari ${src.path.split(/[\\/]/).pop()} — ` +
    `${shade.length} subjek, ${back.length} latar, ${edges.length} kontur, ` +
    `${(Buffer.byteLength(svg) / 1024).toFixed(0)} KB`,
);
