/**
 * PC Organizer（`STRPCCMD`）で届いたコマンドを**このサーバープロセスが動いている機械**で実行する。
 *
 * 実行先は「5250 セッションを持っているプロセスの機械」——
 * 自分の PC でサーバーを起動していれば（`start.sh` / Electron 版）**その PC**、
 * 別ホストのサーバーへブラウザで繋いでいれば**サーバー機**で動く。
 * ブラウザ側の PC では動かない（ブラウザからローカルコマンドは起動できない）。
 *
 * **これはホスト起点の任意コード実行**なので、AGENTS.md「アカウント・権限設計」の
 * 信頼境界に当たる。設定はサーバー設定（profiles.json）にしか置けず、既定は無効
 * （`config-types.ts` の `pcCommandSchema` と `config-routes.ts` / `config-resolver.ts` の各層）。
 */
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type { PcCommandRequest } from "@as400web/core";
import { childLog } from "./log.js";

const log = childLog({ component: "pc-command" });

/** PAUSE(*YES) で待つときの既定上限。超えたら kill してホストへは実行キーを返す */
export const DEFAULT_PC_COMMAND_TIMEOUT_MS = 60_000;

/** サーバー設定から解決した実行時設定（**信頼設定**。個人設定からは来ない） */
export interface PcCommandConfig {
  /** 実行を許可する。**既定 false**（オプトイン） */
  enabled?: boolean;
  /** `PAUSE(*YES)` のときの上限（ミリ秒。既定 60 秒） */
  timeoutMs?: number;
  /** 作業ディレクトリー */
  cwd?: string;
  /**
   * 許可パターン（正規表現・**全体一致**）。指定するとこれに合わないコマンドは実行しない。
   * 省略時は「有効ならすべて実行」。緩いパターンは緩い門にしかならない点は運用者の責任。
   */
  allow?: string[];
}

export type PcCommandOutcome =
  /** 実行して終了した（`PAUSE(*YES)`）。`exitCode` は kill 時に null になりうる */
  | { status: "ran"; exitCode: number | null; durationMs: number }
  /** 起動だけして待たなかった（`PAUSE(*NO)`） */
  | { status: "started" }
  /** 設定で無効（既定） */
  | { status: "disabled" }
  /** 許可パターンに一致しない */
  | { status: "denied" }
  /** 起動できなかった・上限で打ち切った */
  | { status: "failed"; error: string; durationMs: number };

/** 実行先の機械名。UI が「このPC / サーバー」を言い分けるために使う */
export function pcCommandHostname(): string {
  return hostname();
}

/**
 * 許可パターンの検査。**全体一致**でしか通さない（前方一致にすると
 * `notepad; rm -rf /` のような後置きが素通りする）。
 */
export function isAllowed(command: string, allow: readonly string[] | undefined): boolean {
  if (!allow || allow.length === 0) return true;
  return allow.some((p) => {
    try {
      return new RegExp(`^(?:${p})$`).test(command);
    } catch {
      // 壊れた正規表現は「一致しない」に倒す（保存前に検証しているが、手書き編集もありうる）
      log.warn({ pattern: p }, "invalid allow pattern — treated as no match");
      return false;
    }
  });
}

/** `allow` に書けるか（保存前の検証用。壊れた正規表現を永続化しない） */
export function invalidAllowPattern(patterns: readonly string[]): string | undefined {
  for (const p of patterns) {
    try {
      new RegExp(`^(?:${p})$`);
    } catch {
      return p;
    }
  }
  return undefined;
}

/**
 * コマンドを実行する。**例外を投げない**——呼び出し側（core の `runPcCommand`）は
 * 結果に関わらずホストへ実行キーを返す必要があり、ここで投げても得が無い。
 *
 * `shell: true` で OS のシェルに渡す（Windows は `cmd.exe /c`、POSIX は `/bin/sh -c`）。
 * ACS / PCOMM が PC 側でコマンド行として解釈するのと同じ意味論にするため。
 * 標準出力・標準エラーは**保持しない**（返す先が無く、業務データが混ざりうる）。
 */
export async function runPcCommand(
  req: PcCommandRequest,
  cfg: PcCommandConfig | undefined
): Promise<PcCommandOutcome> {
  const command = req.command.trim();
  if (!cfg?.enabled) return { status: "disabled" };
  if (command === "") return { status: "failed", error: "empty command", durationMs: 0 };
  if (!isAllowed(command, cfg.allow)) return { status: "denied" };

  const started = Date.now();
  const opts = {
    shell: true as const,
    windowsHide: true,
    stdio: "ignore" as const,
    ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {})
  };
  return new Promise<PcCommandOutcome>((resolve) => {
    let child;
    try {
      child = spawn(command, opts);
    } catch (err) {
      return resolve({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started
      });
    }
    if (!req.wait) {
      // PAUSE(*NO): **成否を見ずに返す**。GUI アプリの起動が主用途で、待つとホストが
      // （＝業務 CL が）その分止まる。起動に失敗しても分かるのはログだけ——
      // ホストへ返す道が無い以上、待たない指定で待つ理由が無い
      child.once("error", (err) => log.warn({ err: err.message, command }, "PC command failed to start"));
      child.unref();
      return resolve({ status: "started" });
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      resolve({
        status: "failed",
        error: `timed out after ${cfg.timeoutMs ?? DEFAULT_PC_COMMAND_TIMEOUT_MS}ms`,
        durationMs: Date.now() - started
      });
    }, cfg.timeoutMs ?? DEFAULT_PC_COMMAND_TIMEOUT_MS);
    timer.unref?.();
    child.once("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: "failed", error: err.message, durationMs: Date.now() - started });
    });
    child.once("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: "ran", exitCode: code, durationMs: Date.now() - started });
    });
  });
}
