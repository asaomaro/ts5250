/**
 * **プログラム呼び出しの実機検証**（実機）。
 *
 *   node --env-file=.env scripts/verify-program-call.mjs
 *
 * ## なぜ `QCMDEXC` から通すのか
 *
 * IBM i の標準プログラムで**どの機にも必ずある**ので、フィクスチャの用意を待たずに
 * 経路を通せる。引数は `command char(N)` ＋ `length packed(15,5)` で、
 * **文字と詰め 10 進の入力**をそのまま使う。効果も観測できる（コマンドが実行される）。
 *
 * 出力引数の往復は `QUSRTVUS` 相当が要るので、ここでは
 * **`QSYS/QWCRSVAL`（システム値の取り出し）** を使う——受け取り域が out、長さが bin(4)。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
const LIB = process.env.AS400_LIB ?? "TESTLIB";

const PORT = 3495;
const TMP = "/tmp/ts5250-progcall";
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${String(d).slice(0, 140)}` : ""}\n`);
};

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
sys.signon = { user: sys.signon.user, passwordEnv: "AS400_PASSWORD" };
cfg.sessions = [];
writeFileSync(`${TMP}/cfg.json`, JSON.stringify(cfg));

const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(`${TMP}/cfg.json`),
  new PersonalConfigStore({ systems: [], sessions: [] })
);
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 400));

const callProgram = async (program, library, args) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/host/program`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { system: `srv:${sys.id}` }, program, library, args })
  });
  return { status: res.status, body: await res.json() };
};

try {
  // ---- 1. QCMDEXC（文字 in ＋ 詰め 10 進 in）----
  // 副作用の無いコマンドを選ぶ（実機なので）。CHGJOB は自分のジョブだけに効く
  const cmd = "CHGJOB LOG(4 00 *SECLVL)";
  const r1 = await callProgram("QCMDEXC", "QSYS", [
    { type: "char", value: cmd, length: cmd.length },
    { type: "packed", value: String(cmd.length), digits: 15, decimals: 5 }
  ]);
  check("**QCMDEXC を呼べた**（文字 ＋ 詰め 10 進）", r1.status === 200 && r1.body.success === true,
    `status=${r1.status} rc=${r1.body.returnCode} ${JSON.stringify(r1.body.messages?.[0] ?? "")}`);

  // ---- 2. 誤った長さを渡すと**ホストが失敗を返す**（黙って成功しない）----
  const r2 = await callProgram("QCMDEXC", "QSYS", [
    { type: "char", value: cmd, length: cmd.length },
    { type: "packed", value: "1", digits: 15, decimals: 5 }
  ]);
  check("**長さが違えば失敗が返る**（黙って成功にならない）", r2.body.success === false,
    `success=${r2.body.success} ${r2.body.messages?.[0]?.id ?? ""}`);

  // ---- 3. 存在しないプログラム ----
  const r3 = await callProgram("NOSUCHPGM", "QSYS", []);
  check("**無いプログラムは失敗が返る**", r3.body.success === false || r3.status >= 400,
    `status=${r3.status} ${r3.body.messages?.[0]?.id ?? r3.body.code ?? ""}`);

  // ---- 4. 出力引数の往復（QWCRSVAL でシステム値を取る）----
  // 受け取り域 out(char) / 長さ bin(4) / 値の数 bin(4) / 値名 char(10) / エラーコード inout
  const rcvLen = 100;
  const r4 = await callProgram("QWCRSVAL", "QSYS", [
    { type: "char", dir: "out", length: rcvLen },
    { type: "bin", value: String(rcvLen), bytes: 4 },
    { type: "bin", value: "1", bytes: 4 },
    { type: "char", value: "QCCSID", length: 10 },
    { type: "bytes", dir: "inout", value: "", length: 8 } // エラーコード（先頭 4 バイトが 0 = 例外で返す）
  ]);
  const rcv = r4.body.outputs?.[0];
  check("**出力引数が返る**（QWCRSVAL でシステム値）", typeof rcv === "string" && rcv.length === rcvLen,
    `success=${r4.body.success} 長さ=${rcv?.length} ${JSON.stringify(rcv?.slice(0, 30) ?? "")}`);
  if (typeof rcv === "string") {
    // 先頭 4 バイトは返した値の数（bin4）。文字として読んでいるので中身の判定は緩く
    check("**入力専用の位置は null**（読むものが無い）", r4.body.outputs?.[1] === null,
      JSON.stringify(r4.body.outputs?.slice(1, 3)));
  }

  // ---- 5. 変換の拒否が効く（黙って切らない・化けさせない）----
  const r5 = await callProgram("QCMDEXC", "QSYS", [
    { type: "char", value: "ABCDEFGHIJ", length: 3 },
    { type: "packed", value: "10", digits: 15, decimals: 5 }
  ]);
  check("**長すぎる文字は拒否**（黙って切らない）", r5.status === 400, `status=${r5.status} ${r5.body.code ?? ""}`);
  // ---- 5.5 **inout の往復**（数値と文字）----
  // TESTLIB/PGMTST は参照渡しの引数を書き換えるだけの CL（`scripts/build-pgmtst.mjs` で作る）:
  //   &NUM（詰め 10 進 15,5） = &NUM * 2
  //   &TXT（文字 20）        = 'ECHO:' + &TXT
  const r6 = await callProgram("PGMTST", LIB, [
    { type: "packed", dir: "inout", value: "21", digits: 15, decimals: 5 },
    { type: "char", dir: "inout", value: "ABC", length: 20 }
  ]);
  if (r6.body.success === false && r6.body.messages?.[0]?.id === "CPF9801") {
    check("（PGMTST 未作成 → skip。scripts/build-pgmtst.mjs で作れる）", true);
  } else {
    check("**inout の数値が往復する**（21 → 42）", r6.body.outputs?.[0] === "42.00000",
      `outputs[0]=${JSON.stringify(r6.body.outputs?.[0])}`);
    check("**inout の文字が往復する**（ABC → ECHO:ABC）",
      typeof r6.body.outputs?.[1] === "string" && r6.body.outputs[1].startsWith("ECHO:ABC"),
      `outputs[1]=${JSON.stringify(r6.body.outputs?.[1])}`);

    // **負の値**——符号ニブルの取り違えはここでだけ出る
    const r7 = await callProgram("PGMTST", LIB, [
      { type: "packed", dir: "inout", value: "-1.5", digits: 15, decimals: 5 },
      { type: "char", dir: "inout", value: "X", length: 20 }
    ]);
    check("**負の値も往復する**（-1.5 → -3）", r7.body.outputs?.[0] === "-3.00000",
      `outputs[0]=${JSON.stringify(r7.body.outputs?.[0])}`);

    // **小数**——桁合わせの取り違えはここで出る
    const r8 = await callProgram("PGMTST", LIB, [
      { type: "packed", dir: "inout", value: "0.00003", digits: 15, decimals: 5 },
      { type: "char", dir: "inout", value: "Y", length: 20 }
    ]);
    check("**小数も往復する**（0.00003 → 0.00006）", r8.body.outputs?.[0] === "0.00006",
      `outputs[0]=${JSON.stringify(r8.body.outputs?.[0])}`);
  }

  // ---- 5.7 **ゾーン 10 進の往復**（RPG。CL の *DEC は詰めなのでゾーンは表せない）----
  const z1 = await callProgram("PGMTSTZ", LIB, [
    { type: "zoned", dir: "inout", value: "21", digits: 7, decimals: 2 },
    { type: "char", dir: "inout", value: "AB", length: 20 }
  ]);
  if (z1.body.messages?.[0]?.id === "CPF9801") {
    check("（PGMTSTZ 未作成 → skip）", true);
  } else {
    check("**ゾーンの数値が往復する**（21 → 42）", z1.body.outputs?.[0] === "42.00",
      `outputs[0]=${JSON.stringify(z1.body.outputs?.[0])}`);
    const z2 = await callProgram("PGMTSTZ", LIB, [
      { type: "zoned", dir: "inout", value: "-1.5", digits: 7, decimals: 2 },
      { type: "char", dir: "inout", value: "C", length: 20 }
    ]);
    // **符号は最終バイトの上位ニブル**（詰めと位置が違う）。負でしか取り違えが出ない
    check("**ゾーンの負の値も往復する**（-1.5 → -3）", z2.body.outputs?.[0] === "-3.00",
      `outputs[0]=${JSON.stringify(z2.body.outputs?.[0])}`);
  }

  // ---- 5.8 **サービスプログラムの手続き**（QZRUCLSP 経由）----
  const callSrv = async (procedure, args, returns) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/host/service-program`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: { system: `srv:${sys.id}` },
        serviceProgram: "SRVTST",
        library: LIB,
        procedure,
        ...(returns ? { returns } : {}),
        args
      })
    });
    return { status: res.status, body: await res.json() };
  };

  const s1 = await callSrv("SRVADD", [
    { type: "bin", value: "20", bytes: 4, pass: "value" },
    { type: "bin", value: "22", bytes: 4, pass: "value" }
  ], "int");
  if (s1.body.messages?.[0]?.id === "CPF9801") {
    check("（SRVTST 未作成 → skip）", true);
  } else {
    check("**サービスプログラムの手続きが呼べる**（20+22=42）", s1.body.returnValue === 42,
      `returnValue=${s1.body.returnValue} ${s1.body.messages?.[0]?.id ?? ""}`);

    // 参照渡し（既定）。戻り値なし
    const s2 = await callSrv("SRVECHO", [{ type: "char", dir: "inout", value: "HI", length: 20 }]);
    check("**参照渡しの引数が書き換わる**（HI → S:HI）",
      typeof s2.body.outputs?.[0] === "string" && s2.body.outputs[0].startsWith("S:HI"),
      `outputs[0]=${JSON.stringify(s2.body.outputs?.[0])}`);

    // **4 バイトを超える型は参照渡しで受ける**（値渡しは 4 バイトまで。実機で確認）
    const s4 = await callSrv("SRVADD8R", [
      { type: "bin", value: "20", bytes: 8 },
      { type: "bin", value: "22", bytes: 8 },
      { type: "bin", dir: "out", bytes: 8 }
    ]);
    check("**8 バイト整数を参照渡しで往復**（20+22=42）", s4.body.outputs?.[2] === "42",
      `outputs[2]=${JSON.stringify(s4.body.outputs?.[2])} ${s4.body.messages?.[0]?.id ?? ""}`);

    // **値渡しが 4 バイトを超えたら断る**（通すと呼べてしまい結果が静かに壊れる）
    const s5 = await callSrv("SRVADD8", [
      { type: "bin", value: "20", bytes: 8, pass: "value" },
      { type: "bin", value: "22", bytes: 8, pass: "value" }
    ], "int");
    check("**値渡しで 4 バイト超は拒否**（黙って壊れた値を返さない）", s5.status === 400,
      `status=${s5.status} ${s5.body.code ?? ""}`);

    // 無い手続き
    const s3 = await callSrv("NOSUCHPROC", []);
    check("**無い手続きは失敗が返る**", s3.body.success === false,
      `${s3.body.messages?.[0]?.id ?? ""}`);
  }

  // ---- 6. 画面から呼べる ----
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
    await page.locator(".card", { hasText: sys.name }).first().getByRole("button", { name: "選択" }).click();
    await page.waitForTimeout(800);
    await page.locator(".fn", { hasText: "プログラム呼び出し" }).first().getByRole("button", { name: "開く" }).click();
    await page.waitForSelector(".pane[data-tab^='pgm:']", { timeout: 15_000 });
    await page.getByRole("button", { name: "例を入れる" }).click();
    await page.getByRole("button", { name: "呼び出す" }).click();
    await page.waitForSelector(".section", { timeout: 30_000 });
    await page.screenshot({ path: "/tmp/ts5250-progcall/pane.png" });
    const text = await page.locator(".section").innerText();
    check("**画面から呼べた**", text.includes("成功"), text.replace(/\n/gu, " ").slice(0, 80));
  } catch (e) {
    await page.screenshot({ path: "/tmp/ts5250-progcall/pane-error.png" }).catch(() => {});
    check("画面から呼べた", false, String(e).slice(0, 120));
  } finally {
    await browser.close();
  }
} catch (e) {
  check("例外なく完走する", false, String(e));
} finally {
  sessions.closeAll();
  server.close();
  wss.close();
}

const ng = results.filter((r) => !r.ok).length;
process.stdout.write(`\n=== ${results.length} 件中 失敗 ${ng} 件 ===\n`);
process.exit(ng === 0 ? 0 : 1);
