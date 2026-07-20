/**
 * この CLI から core のログを見えるようにする。
 *
 * core は**既定で黙る**（ライブラリが利用側にロガーを強制しないため。`setLogSink` で注入する）。
 * サーバーは `main.ts` が注入するが、**この CLI は注入していなかった**——
 * つまり `LOG_LEVEL=debug` にしてもフレームトレースが 1 行も出なかった。
 * **障害切り分け用のツールが、いちばん切り分けに使いたい情報を出せない**状態だったので、
 * 各サブコマンドの先頭で読み込む形にする。
 *
 * pino は使わない（この CLI に依存を増やさない）。stderr に素で出す
 * ——stdout は結果の出力に使うため汚さない。
 */
import { setLogSink } from "@as400web/core";

const enabled = (process.env["LOG_LEVEL"] ?? "info").toLowerCase() === "debug";

setLogSink((bindings) => {
  const name = String(bindings["component"] ?? "core");
  const write = (level: string, message: string): void => {
    process.stderr.write(`[${level}] ${name}: ${message}\n`);
  };
  return {
    debug: (m) => {
      if (enabled) write("debug", m);
    },
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
    isDebugEnabled: () => enabled
  };
});
