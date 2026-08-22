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
import type { PcCommandRequest } from "@ts5250/tn5250";
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
 * `START` の直前の `CALL` を落とす（**Windows 実機の回避策**）。
 *
 * ## 実機で分かっていること（2026-07-30・Windows）
 *
 * `CMD /C "NET USE \\SERVER & CALL START "title" /B "app.exe" args…"` のように
 * **`CALL START` を含むコマンドは、起動した `app.exe` が直後に強制終了される**。
 * サーバーのログには `outcome: {status: "started"}` としか出ず、エラーは一切見えない
 * （利用者には「何も起きない」ように見える）。一方:
 *
 * - `CALL` を含まない `START "title" /B "app.exe"` は**毎回問題なく生き残る**
 * - 実行ファイルの直接指定も問題なく動く
 * - **同じ文字列を手でコマンドプロンプトから実行すると成功する**
 *   ——コマンド内容・環境・権限の問題ではなく、この Node.js プロセスが実行したときだけ再現する
 *
 * ## 分かっていないこと
 *
 * **根本原因は未特定**（当時の見立ては「Windows のジョブオブジェクト絡みで、`spawn()` の
 * 子プロセスが `CALL` 経由の入れ子で起動されると巻き添えで終了させられる」）。
 * `CALL` は本来バッチファイル・ラベル呼び出し用で、`START` のような内部コマンドに
 * 付けても意味は変わらないため、**実行前に安全に取り除ける**という回避策を採っている。
 *
 * ## 別の Windows 実機で測り直した（2026-08-23。**再現しない**）
 *
 * Windows 11 Pro（build 26200.9168 / `cmd.exe` 10.0.26100.8875）・Node 24.18・
 * Electron 32.3.3・Defender ＋ ESET の実機で **40 ケース**測り、
 * **`CALL START` でも起動したアプリは 1 件も消えなかった**
 * （`20260823-pccmd-windows-verify` の research.md に生の測定値）:
 *
 * | 振った軸 | 中身 | 結果 |
 * |---|---|---|
 * | コマンドの形（8） | `CALL START` / `START` / `CMD /C "…"` の入れ子 / `NET USE &` 連結 / 直接実行 | **全部生存**（唯一の例外は `START /B` に**タイトルを付けない**形——exe パスがタイトルとして食われ、**次のトークンがファイルの関連付けで開かれる**。`START` を組み立てる側の落とし穴） |
 * | spawn の指定（4） | 本番の指定 / `detached` 無し / `windowsHide` 無し / `stdio: "inherit"` | **全部生存** |
 * | アプリの種類（2） | コンソール（node.exe）/ GUI（notepad.exe） | **全部生存** |
 * | 親プロセス（3） | bash 起動の node / cmd.exe 起動の node / **Electron の main プロセス**（配布形と同じ経路） | **全部生存**。どれも**ジョブオブジェクトに入っていない**（`IsProcessInJob` で実測） |
 * | `CALL` の解析差 | 起動された側が受け取った `argv`（パスに空白を含む形も） | **`CALL` の有無で完全に同一**（引用符の剥がれも起きない） |
 *
 * → **「`CALL` が原因」はこの機械では成り立たない。** 原資料の機械で何が効いていたかは
 * 依然として分かっていない（あの環境には届かない）。**回避策は残す**——`CALL START` の
 * `CALL` は意味を持たないので落としても無害で、実機 1 台に「落とせば直った」という
 * 観測がある以上、外す理由が無い。**再発したらまず測るもの**: `ComSpec` の指す先・
 * `cmd.exe` の版・`Command Processor` の `AutoRun`・親がジョブに入っているか・
 * app.exe の置き場（UNC 共有か）。生存そのものの回帰は
 * `packages/server/test/pc-command-windows.test.ts`（Windows でだけ走る）。
 *
 * ## 効かなかった手（再調査の手戻り防止）
 *
 * | 試したこと | 結果 |
 * |---|---|
 * | `spawn()` に `detached: true` を足すだけ | 単体の再現スクリプトでは効くが、**実際のサーバープロセスからの実行では効かない**（原因不明） |
 * | `shell: true` を使わず `cmd.exe` を直接呼んで入れ子を 1 段減らす | 効果なし。さらに**「実行ファイル単体＋引数」ケースを壊す退行**を起こした（Node の `shell: true` が付ける外側の引用符が exe パス自身の引用符を守るクッションになっており、外すと `cmd.exe` の `/S` が「先頭と最後の引用符を剥がす」処理で exe パスの引用符ごと剥がす） |
 * | CCSID/EBCDIC のデコード起因の文字化け | 実機の生バイトを直接確認し、正しく変換されていた（**原因ではない**） |
 * | セキュリティソフト（EDR）によるブロック | `NET USE` の有無・ネットワーク共有の有無を変えても再現パターンが変わらず、**`CALL` の有無だけが唯一の分岐点**と判明したため否定 |
 *
 * ## 範囲
 *
 * - **全体を置換する**（`g`）——`&` で 2 つ以上並ぶ書き方が実際にあり、
 *   1 つ目だけ直すと 2 つ目が同じ不具合を起こす
 * - 大文字小文字を問わない（`i`）。`CALL` と `START` の間の空白は数・種類を問わない
 * - 語境界を見る（`MYCALL START` や `CALLSTART` は変えない）
 * - ⚠ **引用符の中の `CALL START` も落とす**（`echo "CALL START"`）。
 *   見分けるには cmd の構文解析が要り、釣り合わないので取らない
 */
export function stripCallBeforeStart(command: string): string {
  return command.replace(/\bCALL\s+START\b/gi, "START");
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
  // **置換は許可判定の後・実行の直前だけ**。順序を逆にすると、利用者が `CALL START …` を
  // 許可したのに `START …` で照合されることになり、**許可した文面と実際の判定がずれる**。
  // 記録とログ（`session-manager`）も元の文字列のままで、置換後の文字列は外に出さない
  const normalized = stripCallBeforeStart(command);
  const opts = {
    shell: true as const,
    windowsHide: true,
    stdio: "ignore" as const,
    // **効いているのは主に `stripCallBeforeStart` の方**（実機では `detached` 抜きでも
    // `CALL` を落とせば解消した）。ただし単体の再現では `detached` にも効果が見えており、
    // 起動したアプリを親から切り離す意図とも合うので**両方残す**（安全側）
    detached: true,
    ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {})
  };
  return new Promise<PcCommandOutcome>((resolve) => {
    let child;
    try {
      child = spawn(normalized, opts);
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
