/**
 * ライブラリのログ出口。**利用側にロガーを強制しない**（既定は何もしない）。
 *
 * 以前は `pino` を直接 import しており、`@as400web/core` を値で触ると
 * pino がバンドルに入った。ライブラリとして切り出すときに
 * 「EBCDIC コーデックが欲しいだけなのにロガーが付いてくる」のは筋が悪い。
 *
 * **既定を no-op にしている以上、ログが要る側は明示的に注入する**
 * （アプリは起動時に `setLogSink` を呼ぶ。呼ばなければ黙る）。
 * なお `packages/server` は**自前のロガーを持っている**——
 * サーバーのログ（とくに監査証跡）が「注入し忘れ」で静かに消えないよう、
 * **消えて困る側を注入に依存させていない**。
 *
 * **このモジュールを複製してはならない。** 下の `factory` はモジュールスコープの可変状態で、
 * `setLogSink` はこれを書き換える。実体が 2 つになると注入は片方にしか効かず、
 * もう片方のログが**黙って消える**（型検査でもビルドでも気づけない）。
 * `@as400web/core` と `@as400web/hostserver` の両方から使われるため、
 * どちらにも属さない `@as400web/base` に置いてある。
 * `packages/core/test/log-sink-single-instance.test.ts` が実行時に固定している。
 */

/** ログ 1 メソッドの形。pino の `debug(msg)` 等がそのまま代入できる */
export type LogFn = (message: string) => void;

export interface CoreLogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  /**
   * debug を出す価値があるか。**重い整形を避けるための問い合わせ**——
   * フレームトレースは 1 フレームごとに文字列を組み立てるので、
   * 出力先が無い（既定の no-op）ときに作業ごと省くために要る。
   */
  isDebugEnabled: () => boolean;
}

const noop: LogFn = () => {};
const NO_OP_LOGGER: CoreLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  // 出力先が無いなら整形自体が無駄なので false
  isDebugEnabled: () => false
};

type LoggerFactory = (bindings: Record<string, unknown>) => CoreLogger;

let factory: LoggerFactory = () => NO_OP_LOGGER;

/**
 * ログの出力先を差し込む。アプリの起動時に 1 度だけ呼ぶ。
 * 呼ばなければライブラリは黙る（＝ライブラリ利用者に pino を強制しない）。
 */
export function setLogSink(next: LoggerFactory): void {
  factory = next;
}

/** 既定（no-op）に戻す。テスト用 */
export function resetLogSink(): void {
  factory = () => NO_OP_LOGGER;
}

/**
 * 部品名などを添えたロガーを得る。
 *
 * **呼び出しごとに factory を引く**——利用側はモジュールのトップレベルで
 * `const log = childLog({ component: "x" })` と束縛する形が多く、束縛時に確定させると
 * 「後から `setLogSink` しても取得済みのロガーには効かない」ことになるため。
 */
export function childLog(bindings: Record<string, unknown>): CoreLogger {
  return {
    debug: (m) => factory(bindings).debug(m),
    info: (m) => factory(bindings).info(m),
    warn: (m) => factory(bindings).warn(m),
    error: (m) => factory(bindings).error(m),
    isDebugEnabled: () => factory(bindings).isDebugEnabled()
  };
}

/** 部品名を持たない既定ロガー */
export const log: CoreLogger = childLog({});
