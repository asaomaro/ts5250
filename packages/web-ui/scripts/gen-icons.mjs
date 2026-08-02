#!/usr/bin/env node
/**
 * アプリのマーク（モノグラム `ts` ＋カーソル下線）を各形式に生成する。
 *
 *   npm run gen:icons          （リポジトリのルートから）
 *
 * **マークの定義はこのファイルだけ**（`SHAPES`）。ブラウザのファビコンと Electron の
 * アプリアイコンは同じ絵なので、**出力先が 2 つでも定義は 1 つに保つ**——バイナリを
 * 手で置くと、色を直したときに片方だけ古いまま残り、しかも見比べるまで気づかない。
 * web-ui から `electron/build/` に書き出しているのはそのため。
 *
 * 外部依存を持たない（画像ライブラリを 1 個のアイコンのために入れない）ので、
 * ラスタライズは自前。図形を「角丸矩形」と「円弧（太さ付き）」の 2 種類に絞ってあり、
 * どちらも点の内外判定が閉じた式で書けるため、スーパーサンプルするだけで済む。
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_OUT = join(HERE, "..", "public");
// electron-builder の buildResources。`icon.png` を置くだけで全プラットフォームの
// アイコン（exe / dmg / AppImage）に使われる
const ELECTRON_OUT = join(HERE, "..", "..", "..", "electron", "build");

const VB = 64; // viewBox の一辺
const BG = [0x0f, 0x1a, 0x12]; // 端末の地（--paper のダーク寄り）
const FG = [0x3d, 0xdc, 0x7f]; // 端末の緑（--accent のダーク側）
const CURSOR_ALPHA = 0.55;
const W = 5; // 線幅（t と s で共通）

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

const BG_RECT = { rect: [0, 0, 64, 64], r: 14 };

/**
 * 字形。
 *
 * **`s` を矩形（上下バー＋左右の縦棒）で組まない**。それは数字の 5 と同じ形で、
 * `ts5250` という名前の中では特に「t5」と読み違える（試作で実際にそう見えた）。
 * 接する 2 円（中心間距離 = 2r）の弧でつなぐと、中央で接線が連続して s になる。
 *
 * `t` の足も同じ半径の 1/4 円弧にして、2 文字の曲率を揃える。
 */
const SHAPES = [
  // t
  { rect: [18, 9, W, 28.5] }, //            縦棒（アセンダ〜足の付け根）
  { rect: [9, 18.5, 22, W] }, //            横棒
  { arc: [26, 37.5, 5.5], from: 180, to: 270 }, // 足の曲がり
  { rect: [26, 40.5, 5, W] }, //            足の先
  // s（上の弧: 右上終端→上→左→下 / 下の弧: 上→右→下→左下終端）
  { arc: [45.5, 26.5, 5.5], from: 40, to: 270 },
  { arc: [45.5, 37.5, 5.5], from: -140, to: 90 },
];

const CURSOR = { rect: [14, 51, 36, 5], r: 2.5 };

/** viewBox 座標の 1 点が図形の内側か。 */
function inside(px, py, shape) {
  if (shape.rect) {
    const [x, y, w, h] = shape.rect;
    if (px < x || py < y || px >= x + w || py >= y + h) return false;
    const rad = shape.r ?? 0;
    if (rad <= 0) return true;
    const cx = Math.min(Math.max(px, x + rad), x + w - rad);
    const cy = Math.min(Math.max(py, y + rad), y + h - rad);
    return (px - cx) ** 2 + (py - cy) ** 2 <= rad * rad;
  }
  const [cx, cy, rm] = shape.arc;
  const dx = px - cx;
  const dy = py - cy;
  const d = Math.hypot(dx, dy);
  if (d < rm - W / 2 || d > rm + W / 2) return false;
  // 画面座標は y が下向き。反転して数学の角度（反時計回りが正）に合わせる
  let ang = (Math.atan2(-dy, dx) * 180) / Math.PI;
  while (ang < shape.from) ang += 360;
  return ang <= shape.to;
}

/** viewBox 座標の 1 点の色（非プリマルチ RGBA）。 */
function sample(px, py) {
  if (!inside(px, py, BG_RECT)) return [0, 0, 0, 0];
  for (const s of SHAPES) if (inside(px, py, s)) return [...FG, 255];
  if (inside(px, py, CURSOR)) {
    const a = CURSOR_ALPHA;
    return [0, 1, 2].map((i) => Math.round(FG[i] * a + BG[i] * (1 - a))).concat(255);
  }
  return [...BG, 255];
}

/** size×size の RGBA 走査行。ss×ss のスーパーサンプルを箱フィルタで畳む。 */
function render(size, ss = 8) {
  const step = VB / size / ss;
  const n = ss * ss;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let sy = 0; sy < ss; sy++) {
        const py = (y * ss + sy + 0.5) * step;
        for (let sx = 0; sx < ss; sx++) {
          const [r, g, b, a] = sample((x * ss + sx + 0.5) * step, py);
          // **プリマルチで積む**。素の RGB を平均すると透明部の黒が混ざり、
          // 角丸の縁に黒い縁取りが出る
          ar += r * a; ag += g * a; ab += b * a; aa += a;
        }
      }
      const o = x * 4;
      if (aa > 0) {
        row[o] = Math.round(ar / aa);
        row[o + 1] = Math.round(ag / aa);
        row[o + 2] = Math.round(ab / aa);
        row[o + 3] = Math.round(aa / n);
      }
    }
    rows.push(row);
  }
  return rows;
}

// CRC32 は自前で持つ（`zlib.crc32` は Node 22 以降。このリポジトリは Node ≥ 20）
const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(rows, size) {
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.of(0), r]))); // フィルタ種別 0
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO は各サイズを PNG のまま格納する（Vista 以降・全ブラウザが解釈できる）。 */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = [];
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 256 は 0 で表す
    e[1] = e[0];
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

function svg() {
  const green = hex(FG);
  const rect = (s, extra = "") => {
    const [x, y, w, h] = s.rect;
    const rr = s.r ? ` rx="${s.r}"` : "";
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}"${rr}${extra}/>`;
  };
  const arc = (s) => {
    const [cx, cy, rm] = s.arc;
    const pt = (a) => {
      const t = (a * Math.PI) / 180;
      return [cx + rm * Math.cos(t), cy - rm * Math.sin(t)].map((v) => v.toFixed(3));
    };
    const [x0, y0] = pt(s.from);
    const [x1, y1] = pt(s.to);
    const large = Math.abs(s.to - s.from) > 180 ? 1 : 0;
    // 角度の増加＝画面上は反時計回り。SVG の sweep-flag は時計回りが 1 なので 0
    return `<path d="M${x0} ${y0}A${rm} ${rm} 0 ${large} 0 ${x1} ${y1}" fill="none" stroke="${green}" stroke-width="${W}"/>`;
  };
  const body = SHAPES.map((s) => (s.rect ? rect(s) : arc(s))).join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" role="img" aria-label="ts5250">`,
    `  ${rect(BG_RECT, ` fill="${hex(BG)}"`)}`,
    `  <g fill="${green}">${body}</g>`,
    `  ${rect(CURSOR, ` fill="${green}" opacity="${CURSOR_ALPHA}"`)}`,
    `</svg>`,
    "",
  ].join("\n");
}

const written = [];
function emit(dir, name, data) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), data);
  written.push(join(dir, name));
}

emit(WEB_OUT, "favicon.svg", svg());
emit(WEB_OUT, "favicon.ico", ico([16, 32, 48].map((size) => ({ size, data: png(render(size), size) }))));
// iOS のホーム画面用。無いとページのスクリーンショットが使われる
emit(WEB_OUT, "apple-touch-icon.png", png(render(180, 4), 180));
// macOS は 512 未満だと electron-builder が icns を作れない。1024 で出しておく
emit(ELECTRON_OUT, "icon.png", png(render(1024, 2), 1024));

for (const f of written) process.stderr.write(`generated: ${f}\n`);
