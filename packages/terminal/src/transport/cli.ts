#!/usr/bin/env node
/**
 * `ts5250-term` — 文字端末で 5250 を操作する。tty の読み書きと引数・環境変数だけを持つ薄い層
 * （Node API はここ＝`transport/` に隔離する決まり。描画・キー解釈・制御は純ロジック）。
 *
 * 接続は @ts5250/tn5250 の `Session5250` をそのまま使う（サーバー越しにしない）。
 * 資格情報は引数に出さない: パスワードは環境変数名を指す（`--password-env`、既定 `AS400_PASSWORD`）。
 */
import { readFileSync } from "node:fs";
import { Session5250, ReplayTransport, parseTraceJsonl } from "@ts5250/tn5250";
import { renderFrame, paintDiff, type ColorMode } from "../render/frame.js";
import { KeyDecoder } from "../input/decode.js";
import { TerminalController, PREFIX_DEFAULT } from "../app/controller.js";

const USAGE = `使い方: ts5250-term --host <ホスト> [--port N] [--tls] [--ccsid N] [--size 24x80|27x132]
                    [--user U] [--password-env 環境変数名] [--device 装置名] [--prefix 文字]
      ts5250-term --replay <記録.jsonl> [--ccsid N]   （記録の再生。ホスト不要。画面確認・試験用）
  操作: 矢印=移動 Tab/Shift+Tab=欄移動 Enter・F1〜F12・Shift+F1〜F12(=F13〜F24)・PageUp/Down=AID
        Esc=リセット  Ctrl+${PREFIX_DEFAULT} の次: a=Attn s=SysReq h=Help p=Print c=Clear r=Reset e=FieldExit 1-3=PA q=終了
  第 1 段: SBCS の上書き入力のみ（挿入・全角・DBCS 欄の入力は未対応）`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function colorMode(): ColorMode {
  const c = process.env["COLORTERM"] ?? "";
  if (c === "truecolor" || c === "24bit" || process.env["WT_SESSION"] || process.env["TERM_PROGRAM"] === "vscode") return "truecolor";
  return "256";
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  const host = arg("host");
  const replay = arg("replay");
  if (!host && !replay) {
    process.stderr.write(USAGE + "\n");
    process.exitCode = 2;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("標準入出力が端末ではありません\n");
    process.exitCode = 2;
    return;
  }
  const pwEnv = arg("password-env") ?? "AS400_PASSWORD";
  const size = arg("size");
  const port = arg("port");
  const ccsid = arg("ccsid");
  const user = arg("user");
  const device = arg("device");
  const password = process.env[pwEnv];
  const session = await Session5250.connect({
    ...(replay
      ? { transport: new ReplayTransport(parseTraceJsonl(readFileSync(replay, "utf8"))) }
      : { host: host! }),
    ...(port ? { port: Number(port) } : {}),
    ...(ccsid ? { ccsid: Number(ccsid) } : {}),
    ...(size === "27x132" || size === "24x80" ? { screenSize: size } : {}),
    ...(device ? { deviceName: device } : {}),
    ...(user && password ? { user, password } : {}),
    ...(process.argv.includes("--tls") ? { tls: true } : {}),
    warn: () => {}
  });

  const ctl = new TerminalController(session, { prefix: arg("prefix") ?? PREFIX_DEFAULT });
  const decoder = new KeyDecoder();
  const mode = colorMode();
  let prev: string[] | undefined;

  const out = (s: string): void => void process.stdout.write(s);
  const paint = (full = false): void => {
    const f = renderFrame(session.snapshot(), {
      viewport: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 25 },
      colorMode: mode,
      note: ctl.note,
      cursor: ctl.cursor
    });
    out(paintDiff(full ? undefined : prev, f));
    prev = f.rows;
  };
  const restore = (): void => {
    // 代替画面・折返し・括弧付きペースト・カーソルを元へ
    out("\x1b[0m\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };
  const finish = (): void => {
    restore();
    session.disconnect();
    process.exit(0);
  };

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  out("\x1b[?1049h\x1b[?7l\x1b[?2004h\x1b[2J");
  session.on("screen", (s) => {
    ctl.onScreen(s);
    paint();
  });
  session.on("closed", (reason) => {
    restore();
    process.stderr.write(`切断されました: ${reason}\n`);
    process.exit(0);
  });
  process.stdout.on("resize", () => {
    out("\x1b[2J");
    paint(true);
  });

  // ESC 単独は続きの有無を待って確定する（25ms。sodashitsu の端末版と同じ値）
  let escTimer: ReturnType<typeof setTimeout> | undefined;
  process.stdin.on("data", (chunk: string) => {
    if (escTimer) clearTimeout(escTimer);
    void (async () => {
      for (const ev of decoder.feed(chunk)) {
        await ctl.handle(ev);
        if (ctl.quit) return finish();
      }
      paint();
      escTimer = setTimeout(() => {
        void (async () => {
          for (const ev of decoder.flush()) await ctl.handle(ev);
          paint();
        })();
      }, 25);
    })();
  });
  process.on("SIGTERM", finish);
  paint(true);
}

void main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
