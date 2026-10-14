/**
 * 端末の入出力ループ（生モード・代替画面・差分描画・キー入力）。接続の作り方は呼び出し側が決める
 * （`Session5250` を直接使う `cli.ts`、サーバーの WebSocket を使う `ws-session.ts`）。
 */
import { renderFrame, paintDiff, type ColorMode } from "../render/frame.js";
import { KeyDecoder } from "../input/decode.js";
import { TerminalController, type SessionLike } from "../app/controller.js";
import type { ScreenSnapshot } from "@ts5250/tn5250";

export interface TerminalSource {
  session: SessionLike;
  onScreen(cb: (s: ScreenSnapshot) => void): void;
  onClosed(cb: (reason: string) => void): void;
}

export interface RunOptions {
  prefix: string;
  sbcsOnly: boolean;
}

export function colorMode(): ColorMode {
  const c = process.env["COLORTERM"] ?? "";
  if (c === "truecolor" || c === "24bit" || process.env["WT_SESSION"] || process.env["TERM_PROGRAM"] === "vscode") return "truecolor";
  return "256";
}

/** 端末を占有して操作を始める。終了（接頭キーの q・切断）で `onExit` を呼んでから process.exit する */
export function runTerminal(src: TerminalSource, opts: RunOptions, onExit?: () => void): void {
  const session = src.session;
  const ctl = new TerminalController(session, { prefix: opts.prefix, sbcsOnly: opts.sbcsOnly });
  const decoder = new KeyDecoder();
  const mode = colorMode();
  let prev: string[] | undefined;

  const out = (s: string): void => void process.stdout.write(s);
  const paint = (full = false): void => {
    const f = renderFrame(session.snapshot(), {
      viewport: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 25 },
      colorMode: mode,
      note: ctl.note,
      cursor: ctl.cursor,
      insert: ctl.insertMode
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
    onExit?.();
    process.exit(0);
  };

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  out("\x1b[?1049h\x1b[?7l\x1b[?2004h\x1b[2J");
  src.onScreen((s) => {
    ctl.onScreen(s);
    paint();
  });
  src.onClosed((reason) => {
    restore();
    process.stderr.write(`切断されました: ${reason}\n`);
    onExit?.();
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
