/**
 * ブラウザから安全に import できる純粋な部品だけを集めた入口。
 *
 * **root（`@as400web/tn5250`）は使えない**——`transport/`（`node:net` / `node:tls`）を巻き込むため、
 * バンドラが node 組み込みを externalize し、実行時に落ちる（AGENTS.md「コメントの残し方」の例）。
 * ※ かつては `log.js` の pino も理由の 1 つだったが、pino は `20260719-core-debt-payoff` で
 *   server 側へ移した（core は `setLogSink` で注入・既定 no-op）。
 *
 * ここに置いてよいのは **`node:*` にも I/O にも触れないもの**に限る。
 * サイズも見ること——`@as400web/ebcdic` の変換表のように、純粋でも重いものはある
 * （だから `katakanaChar` は `katakana` サブパスから取っている。下記）。
 *
 * **`@as400web/hostserver` の型をここへ戻さないこと。** かつて `IfsEntry` などを
 * `export type` で中継していたが、その 1 点のために `packages/tn5250` が
 * `node:net` を含むパッケージを `dependencies` に持つことになっていた。
 * いまは **web-ui が hostserver を `devDependencies` に持って直接 `import type` する**
 * （`20260801-library-extraction-cleanup`）。型は実行時に消えるので、
 * ブラウザ向けパッケージが Node 専用パッケージを参照していても実体は届かない。
 * `test/hostserver-not-reexported.test.ts` が「`src` に hostserver 参照 0 件」で固定している。
 */
export {
  assertIdentifier,
  isValidIdentifier,
  IDENTIFIER_PATTERN
} from "@as400web/base";
/**
 * 埋め込み属性センチネル（SEU の色付き入力欄）。UI がオーバーレイの色分けと、入力欄の
 * 表示（センチネル→空白）に使う。属性バイト→色の解決に decodeAttribute も共有する。
 */
export {
  isAttrSentinel,
  isRawSentinel,
  attrSentinelByte,
  sentinelByte,
  stripSentinels,
  // バイト→センチネル（逆方向）。web-ui が編集の種値を作るときに、セルの属性バイトを
  // 値の中の 1 文字へ戻すために要る（これが無いと属性が空白に潰れて送信で失われる）
  attrSentinel,
  // 任意の生バイト→センチネル。Dup キーが複写文字（0x1C）を値に入れるのに使う
  // （表示できない制御コードなので、文字としては持てない）
  rawSentinel
} from "./screen/attr-sentinel.js";
export { decodeAttribute } from "./screen/attributes.js";
/** グリッド線の色コード表（5250 の属性バイトとは別物。DDS リファレンス GRDATR Table 14） */
export { GRID_COLOR } from "./protocol/wdsf-parser.js";
export type { ScreenColor } from "./screen/types.js";

/**
 * **画面を自己完結 HTML に描き出す**（自動操作のエビデンス）。
 * 純関数で `node:*` に触れないため、ブラウザ入口からも出せる
 * （web-ui から「この画面を HTML で保存」を作るときに使える）。
 */
export {
  renderScreenHtml,
  renderScreenHistoryHtml,
  type ScreenHtmlMeta,
  type ScreenHistoryEntry
} from "./screen-html.js";
