#!/usr/bin/env node
/**
 * アプリのマーク（`T` と、ブロックカーソル（■）に反転表示された `S`）を各形式に生成する。
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
 * **マークの定義はこのファイルだけ**（`GLYPHS` と地・下線）。ブラウザのファビコンと Electron の
 * アプリアイコンは同じ絵なので、**出力先が 2 つでも定義は 1 つに保つ**——バイナリを
 * 手で置くと、色を直したときに片方だけ古いまま残り、しかも見比べるまで気づかない。
 * web-ui から `electron/build/` に書き出しているのはそのため。
 *
 * 外部依存を持たない（画像ライブラリを 1 個のアイコンのために入れない）ので、
 * ラスタライズは自前。図形は「角丸矩形」（地・下線）と「輪郭」（字形。直線と 2 次・3 次ベジェ）の 2 種類で、
 * 輪郭は曲線を細かい折れ線にして、行ごとに交点を求めて非ゼロ規則で塗る。スーパーサンプルで縁をぼかす。
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
const FG = [0x00, 0xff, 0x00]; // 端末の緑（--t-green）。ブロックカーソルの色
const T_COLOR = [0xff, 0x00, 0xff]; // `T` の色（--t-pink）。利用者が示した図案どおり

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

const BG_RECT = { rect: [0, 0, 64, 64], r: 14 };

/**
 * 字形（大文字の `TS`）。**Noto Sans CJK JP Medium の `T` と `S` の輪郭**をそのまま使う（D28）。
 *
 * 経緯: 大文字の `TS`（D26）を矩形と円弧で組んだが、円弧だけの `S` は継ぎ目・傾き・上下の幅を直しても
 * 「バランスがおかしい」（利用者の指摘）。示された見本の `TS` は普通のサンセリフの字形なので、自作をやめて
 * 書体の字形を借りた。候補（Noto Regular / Medium / Bold・DejaVu）を見本と並べ、字形と太さが一番近い
 * Medium を選んだ（16px でも読める）。
 *
 * 取り方: fontkit で `font.layout("TS")` の輪郭を取り、キャップハイト 26 に縮めた。配置はカーソルの■に合わせて
 * 組み直してある（D29）——`T`・間 3・■（`S` の外形＋左右 3）の全体を x=32 に中心合わせし、字の縦の中心を y=32 に置いた。
 * 座標は viewBox（64）の値で、小数 3 桁に丸めてある。
 *
 * Noto Sans CJK は SIL Open Font License 1.1（© 2014-2021 Adobe）。字形の輪郭を図案に使うのはライセンスの
 * 範囲（書体ファイルそのものを配るのではない）。
 */
const GLYPHS = {
  T: "M16.211 45L20.373 45L20.373 22.458L27.994 22.458L27.994 19L8.626 19L8.626 22.458L16.211 22.458Z",
  S: "M43.237 45.494C48.917 45.494 52.374 42.072 52.374 37.909C52.374 34.099 50.187 32.194 47.082 30.889L43.519 29.372C41.438 28.49 39.357 27.679 39.357 25.421C39.357 23.41 41.05 22.105 43.696 22.105C45.989 22.105 47.824 22.987 49.446 24.433L51.528 21.823C49.623 19.812 46.765 18.542 43.696 18.542C38.722 18.542 35.158 21.611 35.158 25.704C35.158 29.513 37.91 31.454 40.45 32.512L44.048 34.064C46.447 35.122 48.176 35.863 48.176 38.227C48.176 40.414 46.447 41.896 43.343 41.896C40.802 41.896 38.263 40.661 36.393 38.827L33.994 41.649C36.358 44.047 39.674 45.494 43.237 45.494Z",
};

/**
 * ブロックカーソル（■）。**エミュレーターはカーソルを文字を反転した■で表す**ので、マークも `S` の上に■を置き、
 * `S` を地の色で抜く（利用者の要望と図案。D29。以前は下線のカーソルだった）。
 * `S` の外形に左右 3 の余白を足した幅で、縦は y 14〜50（字の縦の中心 y=32）。角は丸めない（端末のセル）
 */
const CURSOR = { rect: [30.994, 14.0, 24.38, 36.0] };

/** viewBox 座標の 1 点が角丸矩形の内側か（地・下線）。字形は `glyphEdges` の走査で塗る */
function inside(px, py, shape) {
  const [x, y, w, h] = shape.rect;
  if (px < x || py < y || px >= x + w || py >= y + h) return false;
  const rad = shape.r ?? 0;
  if (rad <= 0) return true;
  const cx = Math.min(Math.max(px, x + rad), x + w - rad);
  const cy = Math.min(Math.max(py, y + rad), y + h - rad);
  return (px - cx) ** 2 + (py - cy) ** 2 <= rad * rad;
}

/**
 * 輪郭（`M` `L` `Q` `C` `Z`。絶対座標だけ——`GLYPHS` はそう書き出してある）を折れ線の辺に崩す。
 * 曲線は 24 分割（viewBox で 1 辺 1 前後。1024px でも角は見えない）
 */
function pathEdges(d) {
  const tok = d.match(/[MLQCZ]|-?[\d.]+/g);
  const edges = [];
  let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0;
  const num = () => Number(tok[i++]);
  const line = (x1, y1) => {
    if (y1 !== y) edges.push([x, y, x1, y1]);
    x = x1;
    y = y1;
  };
  const N = 24;
  while (i < tok.length) {
    if (/[MLQCZ]/.test(tok[i])) cmd = tok[i++];
    if (cmd === "M") { x = sx = num(); y = sy = num(); cmd = "L"; }
    else if (cmd === "L") line(num(), num());
    else if (cmd === "Q") {
      const [x0, y0, x1, y1, x2, y2] = [x, y, num(), num(), num(), num()];
      for (let k = 1; k <= N; k++) {
        const t = k / N, u = 1 - t;
        line(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
      }
    } else if (cmd === "C") {
      const [x0, y0, x1, y1, x2, y2, x3, y3] = [x, y, num(), num(), num(), num(), num(), num()];
      for (let k = 1; k <= N; k++) {
        const t = k / N, u = 1 - t;
        line(
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
        );
      }
    } else if (cmd === "Z") { line(sx, sy); cmd = ""; }
    else throw new Error(`unsupported path command: ${cmd}`);
  }
  return edges;
}
const T_EDGES = pathEdges(GLYPHS.T);
const S_EDGES = pathEdges(GLYPHS.S);

/**
 * 横線 y で字形の内側になる区間（`[x0, x1]` の並び）。**非ゼロ規則**（書体の輪郭の決まり）——
 * 交点を x で並べ、辺の向き（上向き +1 / 下向き −1）を足して 0 でない間を内側とする
 */
function glyphSpans(edges, py) {
  const hits = [];
  for (const [x0, y0, x1, y1] of edges) {
    if ((py < y0) === (py < y1)) continue;
    hits.push([x0 + ((py - y0) * (x1 - x0)) / (y1 - y0), y1 > y0 ? 1 : -1]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  const spans = [];
  let wind = 0;
  for (const [hx, dir] of hits) {
    const was = wind;
    wind += dir;
    if (was === 0 && wind !== 0) spans.push([hx, hx]);
    else if (was !== 0 && wind === 0) spans[spans.length - 1][1] = hx;
  }
  return spans;
}

const inSpans = (spans, px) => spans.some(([a, b]) => px >= a && px < b);

/** viewBox 座標の 1 点の色（非プリマルチ RGBA）。`t`/`s` はその行の `T`/`S` の区間 */
function sample(px, py, t, s) {
  if (!inside(px, py, BG_RECT)) return [0, 0, 0, 0];
  if (inSpans(t, px)) return [...T_COLOR, 255];
  // ■の上の `S` は地の色で抜く（反転表示）
  if (inside(px, py, CURSOR)) return inSpans(s, px) ? [...BG, 255] : [...FG, 255];
  return [...BG, 255];
}

/** size×size の RGBA 走査行。ss×ss のスーパーサンプルを箱フィルタで畳む。 */
function render(size, ss = 8) {
  const step = VB / size / ss;
  const n = ss * ss;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 4);
    // 字形の区間はサブ行ごとに 1 回だけ求める（点ごとに全辺を見ると 1024px で遅すぎる）
    const subY = Array.from({ length: ss }, (_, sy) => (y * ss + sy + 0.5) * step);
    const tSpans = subY.map((py) => glyphSpans(T_EDGES, py));
    const sSpans = subY.map((py) => glyphSpans(S_EDGES, py));
    for (let x = 0; x < size; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let sy = 0; sy < ss; sy++) {
        const py = (y * ss + sy + 0.5) * step;
        for (let sx = 0; sx < ss; sx++) {
          const [r, g, b, a] = sample((x * ss + sx + 0.5) * step, py, tSpans[sy], sSpans[sy]);
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
  // 字形は書体の輪郭そのまま（非ゼロ規則。SVG の fill-rule の既定と同じ）。■の上に `S` を地の色で重ねる
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" role="img" aria-label="ts5250">`,
    `  ${rect(BG_RECT, ` fill="${hex(BG)}"`)}`,
    `  <path d="${GLYPHS.T}" fill="${hex(T_COLOR)}"/>`,
    `  ${rect(CURSOR, ` fill="${green}"`)}`,
    `  <path d="${GLYPHS.S}" fill="${hex(BG)}"/>`,
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
