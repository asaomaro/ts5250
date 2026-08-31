/**
 * `@ts5250/base` 公開 API。
 *
 * IBM i を相手にする各パッケージ（`@ts5250/tn5250` = TN5250、`@ts5250/hostserver` =
 * ホストサーバー群）が**共有する語彙**だけを置く。ここは「共通で使うものの物置」ではない——
 * **複製すると壊れるもの**の置き場所である。
 *
 * - `log.ts` はモジュールスコープに可変の `factory` を持つ。複製すると `setLogSink` が
 *   片方にしか効かず、もう片方のログが黙って消える
 * - `errors.ts` の `As400Error` は `instanceof` で判定される。クラスが 2 つになると
 *   パッケージ境界を跨いだ判定が false になる
 *
 * この 2 点が「core に残す」でも「両方に複製する」でもなく独立パッケージにした理由で、
 * `packages/tn5250/test/errors-compat.test.ts` と `log-sink-single-instance.test.ts` が
 * 実行時に検査している（`20260801-library-extraction-hostserver` decisions.md D4）。
 *
 * **`export *` は使わない。** 再輸出を機械的に広げると、何が外に出ているのかが目視できなくなる
 * （`As400Error` の改名時に re-export の一括置換で旧名が外へ出なくなった事故と同じ轍を踏まない）。
 */

// ログの差し込み口。**既定は no-op** で、利用側にロガーを強制しない
export {
  log,
  childLog,
  setLogSink,
  resetLogSink,
  type CoreLogger,
  type LogFn
} from "./log.js";

// エラー
export {
  As400Error,
  /** 旧名の互換シム（同一クラス）。新しいコードでは As400Error を使う */
  Tn5250Error,
  describeSocketError,
  withSocketHint,
  type ErrorCode
} from "./errors.js";

// IBM i のオブジェクト名の検証。サーバーとブラウザの両方が使う
export { assertIdentifier, isValidIdentifier, IDENTIFIER_PATTERN } from "./identifier.js";

/*
 * ここから下は **2 つ目の基準**——「複製すると壊れる」ではなく
 * **「複数のパッケージが要るが、どれにも属さない」**もの。
 *
 * - `east-asian-width` … `@ts5250/tn5250` の `screen/`（桁を数える）と
 *   `@ts5250/scs` の `spool-html`（描く）の**両方**が使う。どちらかに置くと他方が依存する
 * - `csv-parse` / `split-statements` … 取り込みと SQL 入力の下ごしらえ。
 *   `@ts5250/server` と `@ts5250/web-ui` が使い、TN5250 でもホストサーバーでもない
 *
 * **物置にしないための歯止め**: **片方しか使わないものは、使う側に置く。**
 * ここへ足す前に「本当に 2 つ以上のパッケージが要るか」を確かめること
 * （`20260801-library-extraction-tn5250` decisions.md D2）。
 */

/** 全角判定（East Asian Width）。桁を数える側と描く側で表を分けない */
export { isFullWidth, isCertainWideGlyph } from "./east-asian-width.js";

/**
 * 配布 HTML（エビデンス）で選べる等幅フォント。**画面 HTML と帳票 HTML が共有する**
 * ——2 か所に書き写すと候補がずれるため、土台に 1 つだけ置く。
 */
export {
  EVIDENCE_FONTS,
  STD_MONO_STACK,
  evidenceFontIndex,
  type EvidenceFont
} from "./evidence-fonts.js";

/**
 * RFC 2877 のデバイス属性（KBDTYPE/CODEPAGE/CHARSET）。**tn5250 / tn3270 / vt の 3 つが要る**
 * が、どれの持ち物でもないのでここに置く（`device-env.ts` の冒頭に経緯）。
 */
export { deviceEnvFor, type DeviceEnv } from "./device-env.js";
/** CSV 解析（取り込みの入口。web-ui と MCP が同じ実装を使う） */
export { parseCsv, type CsvParseResult } from "./csv-parse.js";
/** SQL の複数文分割。純テキスト処理なので UI から直接使う（表も I/O も引き込まない） */
export { splitSqlStatements, summarizeSql, type SqlStatement } from "./split-statements.js";
