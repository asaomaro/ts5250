// **VT の実バイト列を回帰資産にする。**
//
// ⚠ **秘密を記録しない。** IBM i は**サインオン画面が出た時点で採り終える**——
// 資格情報を打つ前に閉じるので、トレースにパスワードが入る余地が無い。
//
// 実行:
//   node scripts/capture-vt-trace.mjs linux  > packages/vt/test/fixtures/linux-vi.jsonl
//   node --env-file=.env --env-file=.env.verify scripts/capture-vt-trace.mjs pub400 > packages/vt/test/fixtures/ibmi-signon.jsonl
import { VtSession, Trace, traced, TcpTransport } from "@ts5250/vt";

const mode = process.argv[2] ?? "linux";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trace = new Trace();

const opts = mode === "linux"
  ? { host: process.env.VT_HOST ?? "127.0.0.1", port: Number(process.env.VT_PORT ?? 2331), rows: 24, cols: 80 }
  : {
      host: process.env.PUB400_HOST,
      port: 23,
      rows: 24,
      cols: 80,
      terminalTypes: ["VT220"],
      ccsid: 37
    };
if (opts.host === undefined) { process.stderr.write("host が要ります\n"); process.exit(2); }

const s = new VtSession(opts);
s.attach(traced(await TcpTransport.connect({ host: opts.host, port: opts.port }), trace));

if (mode === "linux") {
  await sleep(1200);
  s.text("export PS1='$ '; stty -echo; clear\r");
  await sleep(900);
  s.text("printf 'MAIN \\343\\201\\202\\343\\201\\204|X\\033[38;5;208m ORANGE\\033[0m\\n'\r");
  await sleep(900);
  s.text("vi /etc/hostname\r");
  await sleep(1800);
  s.key({ key: "Escape" });
  await sleep(200);
  s.text(":q!\r");
  await sleep(1500);
} else {
  // **サインオン画面が出たら終わり**（資格情報は打たない）
  await sleep(4500);
}
s.close();
process.stdout.write(trace.toJsonl());
