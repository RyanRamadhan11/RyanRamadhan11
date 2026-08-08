/**
 * Membuat assets/avatar.svg: foto dipotong lingkaran + cincin gradasi berputar.
 *
 * Gambar di-embed sebagai data URI karena SVG yang dimuat lewat <img>
 * (begitu cara GitHub merender README) tidak boleh mengambil berkas eksternal.
 *
 * Ganti foto:  taruh file baru di assets/avatar.jpg (atau .png), lalu
 *              node scripts/build-avatar.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = ['avatar.png', 'avatar.jpg', 'avatar.jpeg', 'avatar.webp'];
const source = candidates
  .map((name) => join(root, 'assets', name))
  .find((path) => existsSync(path));

if (!source) {
  console.error(`Tidak menemukan sumber avatar. Taruh salah satu di assets/: ${candidates.join(', ')}`);
  process.exit(1);
}

const mime = source.endsWith('.png')
  ? 'image/png'
  : source.endsWith('.webp')
    ? 'image/webp'
    : 'image/jpeg';

const dataUri = `data:${mime};base64,${readFileSync(source).toString('base64')}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400" role="img" aria-label="Ryan Ramadhan">
  <defs>
    <clipPath id="circle"><circle cx="200" cy="200" r="150" /></clipPath>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366F1" />
      <stop offset="50%" stop-color="#8B5CF6" />
      <stop offset="100%" stop-color="#0EA5E9" />
    </linearGradient>
    <radialGradient id="glow">
      <stop offset="60%" stop-color="#8B5CF6" stop-opacity="0" />
      <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0.35" />
    </radialGradient>
    <style>
      .spin  { transform-origin: 200px 200px; animation: spin 14s linear infinite; }
      .spin2 { transform-origin: 200px 200px; animation: spin 22s linear infinite reverse; }
      .pulse { animation: pulse 3.6s ease-in-out infinite; }
      .rise  { animation: rise 1s cubic-bezier(.2,.7,.3,1) both; }
      @keyframes spin  { to { transform: rotate(360deg); } }
      @keyframes pulse { 0%,100% { opacity:.35 } 50% { opacity:.85 } }
      @keyframes rise  { from { opacity:0; transform: translateY(14px) scale(.94) } to { opacity:1 } }
      @media (prefers-reduced-motion: reduce) {
        .spin, .spin2, .pulse, .rise { animation: none; }
      }
    </style>
  </defs>

  <circle cx="200" cy="200" r="196" fill="url(#glow)" class="pulse" />

  <g class="rise">
    <image href="${dataUri}" x="50" y="50" width="300" height="300"
           preserveAspectRatio="xMidYMid slice" clip-path="url(#circle)" />
    <circle cx="200" cy="200" r="150" fill="none" stroke="#0D1117" stroke-width="6" />
    <circle cx="200" cy="200" r="163" fill="none" stroke="url(#ring)" stroke-width="3"
            stroke-linecap="round" stroke-dasharray="150 60 90 60" class="spin" />
    <circle cx="200" cy="200" r="178" fill="none" stroke="url(#ring)" stroke-width="2"
            stroke-linecap="round" stroke-dasharray="24 46" opacity="0.6" class="spin2" />
  </g>
</svg>
`;

writeFileSync(join(root, 'assets', 'avatar.svg'), svg);
console.log(`assets/avatar.svg dibuat dari ${source.split(/[\\/]/).pop()}`);
