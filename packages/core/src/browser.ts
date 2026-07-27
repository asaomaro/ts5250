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
 * 半角カナ表示（ACS の表示コード切替の再現）。**`katakana` サブパスから取る**——
 * ここを `@as400web/ebcdic`（root）や `/codec` に向けると、CCSID 930/939 の変換表が
 * DBCS 部込みで丸ごとバンドルに入る（実測で約 600 KB）。実際に使うのは
 * 930 の SBCS 部 256 要素だけなので、それだけが届く入口を指す。
 */
export { katakanaChar } from "@as400web/ebcdic/katakana";
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
  attrSentinel
} from "./screen/attr-sentinel.js";
export { decodeAttribute } from "./screen/attributes.js";
export type { ScreenColor } from "./screen/types.js";
