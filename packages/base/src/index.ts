/**
 * `@as400web/base` 公開 API。
 *
 * IBM i を相手にする各パッケージ（`@as400web/core` = TN5250、`@as400web/hostserver` =
 * ホストサーバー群）が**共有する語彙**だけを置く。ここは「共通で使うものの物置」ではない——
 * **複製すると壊れるもの**の置き場所である。
 *
 * - `log.ts` はモジュールスコープに可変の `factory` を持つ。複製すると `setLogSink` が
 *   片方にしか効かず、もう片方のログが黙って消える
 * - `errors.ts` の `As400Error` は `instanceof` で判定される。クラスが 2 つになると
 *   パッケージ境界を跨いだ判定が false になる
 *
 * この 2 点が「core に残す」でも「両方に複製する」でもなく独立パッケージにした理由で、
 * `packages/core/test/errors-compat.test.ts` と `log-sink-single-instance.test.ts` が
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
