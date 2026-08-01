// @as400web/hostserver 公開 API
//
// IBM i の**ホストサーバー群**（signon / database / command / network print / file /
// data queue / DDM）を相手にするクライアント。TN5250 の端末プロトコル（5250 データストリーム・
// 画面モデル・telnet ネゴシエーション）は**含まない**——「IBM i に SQL を投げたい／IFS を
// 読み書きしたいが、画面エミュレーションは要らない」利用者のために `@as400web/tn5250` から
// 切り出したパッケージだからである。
//
// **逆向きの依存（ここから `@as400web/tn5250` を import すること）を作ってはならない。**
// 切り出しの意味が消える。`test/no-core-dependency.test.ts` が src 全体を走査して検査している。
//
// **`export *` は使わない。** 公開面は列挙する（`@as400web/tn5250` の `index.ts` と同じ方針。
// 再輸出を機械的に広げると何が外に出ているのか目視できなくなり、`As400Error` 改名時に
// 旧名が外へ出なくなった事故と同じ轍を踏む）。

// signon サーバー（認証）
export {
  signon,
  SignonError,
  type SignonOptions,
  type SignonResult,
  type HostServerInfo,
  type HostServerTlsOptions
} from "./signon.js";
export {
  resolveServicePort,
  type HostService,
  type ResolvePortOptions,
  SERVICE_NAME,
  DEFAULT_PORT,
  PORT_MAPPER_PORT
} from "./port-mapper.js";
export {
  classifySignonReturnCode,
  describeSignonFailure,
  type SignonFailure,
  type SignonFailureKind
} from "./return-codes.js";

// database サーバー（SQL）
export { DbConnection, type DbConnectOptions } from "./db/db-connection.js";
export { openQuery } from "./db/query.js";
export { type LobOptions } from "./db/query.js";
export { retrieveLob, DEFAULT_LOB_MAX_BYTES, type RetrievedLob } from "./db/lob.js";
export { query, stream, SqlError, type Row, type QueryResult } from "./db/query.js";
// 上限つき取得。**ホストから取ってくる量**を抑える（`query` は全件取得）
export { queryLimited, type LimitedResult } from "./db/query.js";
export type { ColumnMeta, DbValue } from "./db/db-decode.js";
export { DB2, typeName, jsTypeOf, type JsType } from "./db/db-types.js";
// 結果を返さない文（DML / DDL）。判定は純関数で、実行は SQLCODE で成否を見る
export { executeStatement, type ExecuteResult } from "./db/execute.js";
export {
  isNonQueryStatement,
  isRowCountStatement,
  hasParameterMarker
} from "./db/statement-kind.js";

// コマンドサーバー（CL 実行とプログラム呼び出し）
export {
  CommandConnection,
  CommandError,
  type CommandConnectOptions,
  type CommandResult
} from "./command/command-connection.js";
export {
  classifySeverity,
  describeMessage,
  type HostMessage,
  type MessageKind
} from "./command/command-message.js";
export type { ProgramParameter } from "./command/command-datastream.js";

// スプール（一覧＝コマンドサーバー / 中身＝ネットワーク印刷サーバー）
export { listSpooledFiles, parseSpoolRecord, buildFilter } from "./spool/spool-list.js";
export {
  statusName,
  cyymmddToIso,
  hhmmssToReadable,
  type SpoolId,
  type SpoolEntry,
  type SpoolListFilter
} from "./spool/spool-types.js";
export {
  NetPrintConnection,
  type NetPrintConnectOptions,
  type SpoolMessage
} from "./spool/netprint-connection.js";
export {
  NP_ACTION,
  NP_CP,
  NP_ATTR,
  NP_RC,
  buildAttributeList,
  buildNpRequest,
  parseNpReply,
  findCodePoint,
  type NpAttribute
} from "./spool/netprint-datastream.js";

// file サーバー（IFS の読み書き）
export {
  IfsConnection,
  type IfsConnectOptions,
  type IfsListOptions,
  type IfsTextFile
} from "./ifs/ifs-connection.js";
export type { IfsEntry, IfsListResult } from "./ifs/ifs-types.js";

// データ待ち行列
export { DtaqConnection, type DtaqConnectOptions } from "./dtaq/dtaq-connection.js";
export { decodeEbcdic as dtaqDecodeEbcdic } from "./dtaq/dtaq-datastream.js";
export type {
  DtaqEntry,
  DtaqAttributes,
  DtaqType,
  CreateOptions as DtaqCreateOptions,
  ReadOptions as DtaqReadOptions,
  SearchOrder as DtaqSearchOrder
} from "./dtaq/dtaq-types.js";

// 各種一覧（QGY オープンリスト）
export { listObjects, type ObjectEntry, type ObjectListFilter } from "./list/object-list.js";
export { listUsers, type UserEntry, type UserListFilter } from "./list/user-list.js";
export { listJobs, type JobEntry, type JobListFilter } from "./list/job-list.js";

// DDM（レコードレベル書き込み）
export {
  DdmConnection,
  buildDdmRecord,
  type DdmRecord,
  buildRecordLayout,
  type DdmConnectOptions,
  type DdmFile,
  type WriteAllResult,
  maxBatchSize,
  effectiveBatchSizeFor,
  type ColumnLayoutInput,
  type RecordLayout
} from "./ddm/ddm-connection.js";
export { encodeChar, encodeInt, encodePacked, encodeZoned } from "./ddm/encode.js";
export { type FieldLayout } from "./ddm/record-layout.js";
export { fetchColumnLayout } from "./ddm/column-meta.js";

// 取り込み（CSV → 表）の下ごしらえと、SQL 経由の行追加
export {
  prepareUpload,
  type PrepareUploadArgs,
  type PrepareResult,
  type PreparedUpload,
  type UploadColumn,
  type UploadRejection
} from "./db/upload-prepare.js";
export {
  insertRows,
  batchSizeFor,
  InsertEncodeError,
  DEFAULT_MAX_BATCH_BYTES,
  type InsertResult,
  type InsertRowsArgs
} from "./db/insert.js";
export { parseMarkerFormat, type MarkerFormat, type MarkerField } from "./db/marker-format.js";
export {
  encodeMarkerRow,
  buildMarkerData,
  markerDataSize,
  MarkerEncodeError,
  type MarkerRow
} from "./db/marker-encode.js";
