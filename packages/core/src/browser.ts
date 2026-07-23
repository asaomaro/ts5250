/**
 * ブラウザから安全に import できる純粋な部品だけを集めた入口。
 *
 * **root（`@as400web/core`）は使えない**——`log.js`(pino) と `transport/`(`node:net`/`node:tls`) を
 * 巻き込むため、バンドラが node 組み込みを externalize し、実行時に落ちる
 * （AGENTS.md の codec サブパスと同じ理由）。
 *
 * ここに置いてよいのは **`node:*` にも I/O にも触れないもの**に限る。
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
 * 文字コードの選択肢。**`codec.js`（DBCS の巨大な表）を引き込まない一覧だけ**を出す。
 * 実際の復号・符号化はサーバー側（`ccsid-text.ts`）が行う。
 */
export { TEXT_CCSIDS, ccsidLabel, type LineEnding } from "./codec/ccsid-catalog.js";
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
  stripSentinels
} from "./screen/attr-sentinel.js";
export { decodeAttribute } from "./screen/attributes.js";
export type { ScreenColor } from "./screen/types.js";
