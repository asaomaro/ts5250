#!/usr/bin/env node
/**
 * `ts5250-term` — 文字端末で 5250 を操作する。tty の読み書きと引数・環境変数だけを持つ薄い層
 * （Node API はここ＝`transport/` に隔離する決まり。描画・キー解釈・制御は純ロジック）。
 *
 * 接続は @ts5250/tn5250 の `Session5250` をそのまま使う（サーバー越しにしない）。
 * 資格情報は引数に出さない: パスワードは環境変数名を指す（`--password-env`、既定 `AS400_PASSWORD`）。
 */
import { readFileSync } from "node:fs";
import { Session5250, ReplayTransport, parseTraceJsonl, isDbcsCcsid } from "@ts5250/tn5250";
import { isKatakanaCcsid } from "@ts5250/ebcdic/katakana";
import { PREFIX_DEFAULT } from "../app/controller.js";
import { runTerminal } from "./run.js";
import { WsSession } from "./ws-session.js";

const USAGE = `使い方: ts5250-term --host <ホスト> [--port N] [--tls] [--ccsid N] [--size 24x80|27x132]
                    [--user U] [--password-env 環境変数名] [--device 装置名] [--prefix 文字]
      ts5250-term --ws ws://127.0.0.1:3400/ws [--session srv:名 | --system srv:名 | --attach セッションID | --host …]
      ts5250-term --replay <記録.jsonl> [--ccsid N]   （記録の再生。ホスト不要。画面確認・試験用）
  操作: 矢印=移動 Tab/Shift+Tab=欄移動 Enter・F1〜F12・Shift+F1〜F12(=F13〜F24)・PageUp/Down=AID
        Esc=リセット  Ctrl+${PREFIX_DEFAULT} の次: a=Attn s=SysReq h=Help p=Print c=Clear r=Reset e=FieldExit i=挿入 1-3=PA q=終了
        表示の切替（上部のパネルに現在値）: g=罫線 o=SO/SI k=カナ/英 u=カーソルの形 b=明滅 l=ルーラー m=ルーラーの形 f=固定 v=桁区切り w=パネル
  編集: 文字欄と O 欄（SO/SI 補完）。Insert または接頭キーの i で挿入。継続・語送り・J・E・G 欄は未対応`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  const host = arg("host");
  const replay = arg("replay");
  const wsUrl = arg("ws");
  if (!host && !replay && !wsUrl) {
    process.stderr.write(USAGE + "\n");
    process.exitCode = 2;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("標準入出力が端末ではありません\n");
    process.exitCode = 2;
    return;
  }
  if (wsUrl) {
    // サーバーの WebSocket へ繋ぐ（セッションはサーバーが持つ。ブラウザ・MCP と共有できる）
    const pw = process.env[arg("password-env") ?? "AS400_PASSWORD"];
    const ws = await WsSession.open(wsUrl, {
      ...(arg("session") ? { session: arg("session")! } : {}),
      ...(arg("system") ? { system: arg("system")! } : {}),
      ...(arg("attach") ? { sessionId: arg("attach")! } : {}),
      ...(host ? { host } : {}),
      ...(arg("port") ? { port: Number(arg("port")) } : {}),
      ...(process.argv.includes("--tls") ? { tls: true } : {}),
      ...(arg("ccsid") ? { ccsid: Number(arg("ccsid")) } : {}),
      ...(arg("size") === "27x132" || arg("size") === "24x80" ? { screenSize: arg("size") as "24x80" | "27x132" } : {}),
      ...(arg("device") ? { deviceName: arg("device")! } : {}),
      ...(arg("user") ? { user: arg("user")! } : {}),
      ...(arg("user") && pw ? { password: pw } : {})
    });
    runTerminal(
      { session: ws, onScreen: (cb) => ws.onScreen(cb), onClosed: (cb) => ws.onClosed(cb) },
      { prefix: arg("prefix") ?? PREFIX_DEFAULT, sbcsOnly: !isDbcsCcsid(ws.ccsid), hostKatakana: isKatakanaCcsid(ws.ccsid) }
    );
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

  runTerminal(
    {
      session,
      onScreen: (cb) => void session.on("screen", cb),
      onClosed: (cb) => void session.on("closed", cb)
    },
    { prefix: arg("prefix") ?? PREFIX_DEFAULT, sbcsOnly: !isDbcsCcsid(session.ccsid), hostKatakana: isKatakanaCcsid(session.ccsid) }
  );
}

void main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
