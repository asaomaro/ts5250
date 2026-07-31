/**
 * ブラウザから安全に import できる純粋な部品だけを集めた入口。
 *
 * **root（`@as400web/core`）は使えない**——`transport/`（`node:net` / `node:tls`）を巻き込むため、
 * バンドラが node 組み込みを externalize し、実行時に落ちる（AGENTS.md「コメントの残し方」の例）。
 * ※ かつては `log.js` の pino も理由の 1 つだったが、pino は `20260719-core-debt-payoff` で
 *   server 側へ移した（core は `setLogSink` で注入・既定 no-op）。
 *
 * ここに置いてよいのは **`node:*` にも I/O にも触れないもの**に限る。
 * サイズも見ること——`@as400web/ebcdic` の変換表のように、純粋でも重いものはある
 * （だから `katakanaChar` は `katakana` サブパスから取っている。下記）。
 */
/** 全角判定（East Asian Width）。桁を数える側と描く側で表を分けないため core に置く */
export { isFullWidth, isCertainWideGlyph } from "./text/east-asian-width.js";
export { parseCsv, type CsvParseResult } from "./csv-parse.js";
/** SQL の複数文分割。純テキスト処理なので UI から直接使う（表も I/O も引き込まない） */
export {
  splitSqlStatements,
  summarizeSql,
  type SqlStatement
} from "./sql/split-statements.js";
/** 取り込みの拒否理由。UI が種類ごとに文言を組み立てるため型を共有する */
export type { UploadRejection } from "./hostserver/db/upload-prepare.js";
export {
  assertIdentifier,
  isValidIdentifier,
  IDENTIFIER_PATTERN
} from "./identifier.js";
/** IFS の一覧。UI がツリーと一覧を組み立てるため型を共有する（型だけ＝実行時依存は増えない） */
export type { IfsEntry, IfsListResult } from "./hostserver/ifs/ifs-types.js";
/**
 * 文字コードの選択肢。**表を引き込まない `catalog` サブパスから取る**——
 * `@as400web/ebcdic`（root）は EBCDIC の変換表を計 18,900 行・約 1.17 MB 同梱するので、
 * ここを root に向けるとブラウザのバンドルへ丸ごと入る。**しかもビルドもテストも通る**。
 * 実際の復号・符号化はサーバー側（`@as400web/ebcdic` の `ccsid-text`）が行う。
 */
export { TEXT_CCSIDS, ccsidLabel, type LineEnding } from "@as400web/ebcdic/catalog";
/**
 * 表示コード切替（ACS の半角カナ ⇔ 英小文字）の再現。**`katakana` サブパスから取る**——
 * ここを `@as400web/ebcdic`（root）や `/codec` に向けると、CCSID 930/939 の変換表が
 * DBCS 部込みで丸ごとバンドルに入る（実測で約 600 KB）。実際に使うのは
 * 930・939 の SBCS 部 256 要素ずつだけなので、それだけが届く入口を指す。
 *
 * **2 つで対**。切替とは「もう一方の表で読み直すこと」で、カタカナ系ホスト（930/5026）で
 * 英字を出すには 939 側の表が要る（`katakanaChar` だけだと 930 セッションで無反応になる）。
 */
export { katakanaChar, latinChar } from "@as400web/ebcdic/katakana";
/** データ待ち行列。UI が属性・送受信フォームを組み立てるため型を共有する */
export type {
  DtaqEntry,
  DtaqAttributes,
  DtaqType,
  SearchOrder as DtaqSearchOrder
} from "./hostserver/dtaq/dtaq-types.js";
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
} from "./html/screen-html.js";
