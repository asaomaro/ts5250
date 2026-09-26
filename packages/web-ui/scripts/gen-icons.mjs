#!/usr/bin/env node
/**
 * アプリのマーク（モノグラム `TS` ＋カーソル下線）を各形式に生成する。
 *
 *   npm run gen:icons          （リポジトリのルートから）
 *   node packages/web-ui/scripts/gen-icons.mjs --check
 *                              書き出さず、コミット済みのファイルが今の定義と一致するかだけ見る
 *                              （全サイズを描き直すので十数秒かかる。手で確かめる用）
 *
 * 書き出すたびに`icons.stamp.json`（このスクリプトと各出力の sha256）も書く。`test/app-icons.test.ts` は
 * これと突き合わせて**作り直し忘れ**（定義だけ変えた）と**手で差し替えた出力**を落とす——描き直しは重く、
 * 並列のテスト実行では 1 分を超えて他のテストをタイムアウトさせたので、テストでは描かない
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
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_OUT = join(HERE, "..", "public");
// electron-builder の buildResources。`icon.png` を置くだけで全プラットフォームの
// アイコン（exe / dmg / AppImage）に使われる
const ELECTRON_OUT = join(HERE, "..", "..", "..", "electron", "build");
// VSCode拡張機能のアイコン（`vscode-extension/package.json`の`icon`欄が指す）。
// VS Code Marketplaceの推奨は128×128以上（`vsce package`は指定サイズをそのまま使う。
// electron-builderのicns生成のような下限制約は無い）
const VSCODE_OUT = join(HERE, "..", "..", "..", "vscode-extension");
const REPO = join(HERE, "..", "..", "..");
const STAMP = join(HERE, "icons.stamp.json");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const VB = 64; // viewBox の一辺
// **「5250 端末 クラシック」の配色**（`styles.css`の`:root`の`--crt`と`--t-green`。ACSの標準色そのもの）。
// ts5250は5250端末ソフトなので、マークも既定の端末の画面と同じ色にする（利用者の要望）。
// 以前は「ソフト」寄りの`#0f1a12`/`#3ddc7f`だった。`test/app-icons.test.ts`が`styles.css`との一致を見る
const BG = [0x00, 0x00, 0x00]; // 端末の地（--crt）
const FG = [0x00, 0xff, 0x00]; // 端末の緑（--t-green）
const CURSOR_ALPHA = 0.55;
const W = 5; // 線幅（T と S で共通）

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

const BG_RECT = { rect: [0, 0, 64, 64], r: 14 };

/**
 * 字形（大文字の `TS`。利用者の要望で小文字の `ts` から替えた。D26）。
 *
 * 2 文字とも字高を揃える（上端 y=11・下端 y=45）。カーソル下線（y=51〜56）との間を 6 空け、
 * 左右の余白（T の左端 8・S の右端 55.5）もほぼ揃えて、下線の中心（x=32）に 2 文字の中心を合わせる。
 *
 * **`S` を矩形（上下バー＋左右の縦棒）で組まない**。それは数字の 5 と同じ形で、
 * `TS5250` という名前の中では特に「T5」と読み違える（小文字の試作で実際にそう見えた）。
 * 接する 2 円（中心間距離 = 2r）の弧でつなぐと、中央で接線が連続して S になる。
 * 字高 34 = 4r + W なので r = 7.25。
 */
const S_R = 7.25;
const S_CX = 45.75;
const S_TOP = 11 + W / 2 + S_R; // 上の円の中心 y
const SHAPES = [
  // T
  { rect: [8, 11, 22, W] }, //            横棒
  { rect: [16.5, 11, W, 34] }, //         縦棒
  // S（上の弧: 右上終端→上→左→下 / 下の弧: 上→右→下→左下終端）
  { arc: [S_CX, S_TOP, S_R], from: 40, to: 270 },
  { arc: [S_CX, S_TOP + 2 * S_R, S_R], from: -140, to: 90 },
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

const CHECK = process.argv.includes("--check");
const written = [];
const stale = [];
/** 出力（リポジトリ相対・`/`区切り）→ sha256 */
const hashes = {};
function emit(dir, name, data) {
  hashes[relative(REPO, join(dir, name)).split("\\").join("/")] = sha256(Buffer.from(data));
  const path = join(dir, name);
  if (CHECK) {
    const cur = existsSync(path) ? readFileSync(path) : undefined;
    if (!cur || !cur.equals(Buffer.from(data))) stale.push(path);
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, data);
  written.push(path);
}

emit(WEB_OUT, "favicon.svg", svg());
emit(WEB_OUT, "favicon.ico", ico([16, 32, 48].map((size) => ({ size, data: png(render(size), size) }))));
// iOS のホーム画面用。無いとページのスクリーンショットが使われる
emit(WEB_OUT, "apple-touch-icon.png", png(render(180, 4), 180));
// macOS は 512 未満だと electron-builder が icns を作れない。1024 で出しておく
emit(ELECTRON_OUT, "icon.png", png(render(1024, 2), 1024));
// Windows 用のマルチサイズ ico。electron-builder は icon.ico が無いと icon.png から 256px の 1 枚だけを作り、
// タスクバー・エクスプローラの 16/32px 表示が縮小でぼける。以前は`electron/scripts/make-icon-ico.ps1`
// （pwsh・System.Drawing）で別に焼いていたが、**生成の経路が 2 本あると片方だけ古い色で残る**のでここへ寄せた
emit(ELECTRON_OUT, "icon.ico", ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(render(size, size >= 128 ? 4 : 8), size) }))));
// VSCode拡張機能のアイコン（favicon・electronアイコンと同じ絵を使う。利用者の要望）
emit(VSCODE_OUT, "icon.png", png(render(128, 4), 128));

if (CHECK) {
  for (const f of stale) process.stderr.write(`stale: ${f}\n`);
  process.exitCode = stale.length > 0 ? 1 : 0;
} else {
  const stamp = { script: sha256(readFileSync(fileURLToPath(import.meta.url))), files: hashes };
  writeFileSync(STAMP, `${JSON.stringify(stamp, null, 2)}\n`);
  for (const f of [...written, STAMP]) process.stderr.write(`generated: ${f}\n`);
}
