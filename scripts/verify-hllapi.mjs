/**
 * HLLAPI ブリッジの検証（**本物の C ABI** ＋ 実機セッション）。
 *
 *   node --env-file=.env --env-file=.env.verify scripts/verify-hllapi.mjs
 *
 * ## なぜ Python を挟むのか
 *
 * HLLAPI クライアントは共有ライブラリを**動的リンクして C ABI で呼ぶ**。
 * この環境には C コンパイラが無い（`sudo` も無い）ので C のテストクライアントは書けないが、
 * **Python の `ctypes` は C ABI をそのまま叩く**ので、呼び出し規約としては同じものを再現できる。
 *
 * ## 何を見るか
 *
 * 1. 共有ライブラリの自己検査（JSON・バッファ・ヌルポインタ）
 * 2. **サーバーが居ないときに `rc=9`**（落ちない）
 * 3. 実機セッションを開いてから: Connect → Copy PS → Search → Send Key → Disconnect
 * 4. **未実装の機能番号が `rc=10`**
 * 5. **日本語（DBCS）を含む画面**が壊れずに読める
 * 6. **予約（`Reserve`）が人間の入力を実際に締め出す**
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver
} from "@ts5250/server";

const PORT = 3492;
const TMP = "/tmp/as400-verify-hllapi";
const LIB = "crates/hllapi/target/release/libts5250hllapi.so";
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${String(d).slice(0, 150)}` : ""}\n`);
};

if (!existsSync(LIB)) {
  process.stderr.write(
    `${LIB} がありません。先に共有ライブラリを作ってください（docs/HLLAPI.md 参照）\n`
  );
  process.exit(1);
}
if (!process.env["AS400_PASSWORD"]) {
  process.stderr.write("AS400_PASSWORD が未設定です\n");
  process.exit(1);
}

/** Python の ctypes 経由で 1 呼び出し（**C ABI をそのまま叩く**） */
function hllapi(fn, data = "", length = null, pos = 0, url = `http://127.0.0.1:${PORT}/api/hllapi`) {
  // `length` を省いたら **CP932 に符号化した長さ**を使う。
  // 余分に取ると NUL 埋めがそのまま検索文字列に混ざり、**見つからなくなる**（実際に踏んだ）
  const py = `
import ctypes, json, sys
lib = ctypes.CDLL(${JSON.stringify(LIB)})
lib.hllapi.restype = None
lib.hllapi.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_char_p,
                       ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
raw = ${JSON.stringify(data)}.encode("cp932", "replace")
cap = ${length === null ? "max(len(raw), 1)" : String(length)}
func = ctypes.c_int(${fn})
buf = ctypes.create_string_buffer(raw, cap)
ln = ctypes.c_int(cap)
rc = ctypes.c_int(${pos})
lib.hllapi(ctypes.byref(func), buf, ctypes.byref(ln), ctypes.byref(rc))
out = buf.raw[:max(0, min(ln.value, cap))]
# **CP932 のバイト列として受け取る**（1 位置 = 1 バイト、全角は 2 バイト）
print(json.dumps({"rc": rc.value, "length": ln.value, "bytes": len(out),
                  "data": out.decode("cp932", "replace")}))
`;
  return new Promise((resolve) => {
    const p = spawn("python3", ["-c", py], { env: { ...process.env, TS5250_HLLAPI_URL: url } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ rc: -1, length: 0, data: out });
      }
    });
  });
}

// ---- サーバーを起こす ----
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
sys.signon = { user: sys.signon.user, passwordEnv: "AS400_PASSWORD" };
const tmpCfg = `${TMP}/conn.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg),
  new PersonalConfigStore({ systems: [], sessions: [] })
);
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "verify" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 500));

try {
  // ---- 1. 自己検査 ----
  const self = await new Promise((resolve) => {
    const p = spawn("python3", [
      "-c",
      `import ctypes;lib=ctypes.CDLL(${JSON.stringify(LIB)});lib.ts5250_hllapi_selftest.restype=ctypes.c_int;print(lib.ts5250_hllapi_selftest())`
    ]);
    let o = "";
    p.stdout.on("data", (d) => (o += d));
    p.on("close", () => resolve(Number(o.trim())));
  });
  check("共有ライブラリの自己検査（失敗 0 件）", self === 0, `失敗 ${self} 件`);

  // ---- 2. サーバーが居ないとき ----
  const down = await hllapi(1, "A", 1, 0, "http://127.0.0.1:59999/api/hllapi");
  check("**サーバーが居なければ rc=9**（落ちない）", down.rc === 9, `rc=${down.rc}`);

  // ---- 3. セッションが無い状態で Connect ----
  const noSession = await hllapi(1, "A", 1);
  check("セッションが無ければ rc=1", noSession.rc === 1, `rc=${noSession.rc}`);

  // ---- 実機セッションを開く ----
  // `resolve(...).connect` を**展開して**渡す（`open` は接続先そのものを受ける）
  const resolved = resolver.resolve({ system: `srv:${sys.id}` }, undefined, () => undefined);
  const opened = await sessions.open({ ...resolved.connect, origin: "hllapi-verify" });
  await new Promise((r) => setTimeout(r, 2500));
  const snap = opened.session.snapshot();
  check("実機セッションが開いた", snap.rows > 0, `${snap.rows}x${snap.cols}`);

  // ---- 4. Connect → 読み出し ----
  const conn = await hllapi(1, "A", 1);
  check("Connect Presentation Space (1)", conn.rc === 0, `rc=${conn.rc}`);

  const cells = snap.rows * snap.cols;
  // **CP932 なら 1 桁 = 1 バイト**（全角は 2 桁で 2 バイト）。
  // 既存資産が確保する `rows*cols` バイトの器にそのまま収まるはず
  const copy = await hllapi(5, "", cells);
  check("**Copy PS (5) がセル数ぶんの器に収まる**（1 桁 = 1 バイト）",
    copy.rc === 0 && copy.bytes === cells, `rc=${copy.rc} バイト=${copy.bytes} セル=${cells}`);
  check("**改行が入っていない**（固定長の連結）", !copy.data.includes("\n"));

  const first = copy.data.slice(0, 60).trim();
  process.stdout.write(`     画面先頭: ${first}\n`);

  // ---- 5. 検索（位置は rc に返る） ----
  const word = (first.split(/\s+/u).find((w) => w.length >= 3) ?? "").slice(0, 6);
  if (word) {
    const found = await hllapi(6, word);
    // **rc=7 は「見つからない」**。`rc > 0` だけだと見つからなくても通ってしまう
    check(`Search PS (6) が位置を rc に返す（"${word}"）`, found.rc > 0 && found.rc !== 7,
      `rc=${found.rc}`);
  }
  const missing = await hllapi(6, "ZZQQXX");
  check("見つからなければ rc=7", missing.rc === 7, `rc=${missing.rc}`);

  // ---- 6. カーソルと部分読み出し ----
  const setCur = await hllapi(40, "", 0, 1);
  check("Set Cursor (40)", setCur.rc === 0, `rc=${setCur.rc}`);
  const part = await hllapi(8, "", 10);
  check("Copy PS to String (8) が 10 文字返す", part.rc === 0 && part.data.length === 10,
    `rc=${part.rc} "${part.data}"`);

  // ---- 7. 日本語（DBCS） ----
  const hasJa = /[　-鿿＀-￯]/u.test(copy.data);
  if (hasJa) {
    const run = /[぀-ゟ゠-ヿ一-鿿]{2,}/u.exec(copy.data);
    check("**全角が連続して読める**（`サ イ ン` のように空白が挟まらない）",
      run !== null, `例: ${run?.[0] ?? "(連続が見つからない)"}`);
    // 見つけた語で検索して、**日本語で引けること**を確かめる
    if (run) {
      const found = await hllapi(6, run[0]);
      check(`**日本語で検索できる**（"${run[0]}"）`, found.rc > 0 && found.rc !== 7, `rc=${found.rc}`);
    }
  } else {
    process.stdout.write("     （この画面に日本語が無いので DBCS の確認は省略）\n");
  }

  // ---- 8. 未実装 ----
  for (const [fn, name] of [[9, "Set Session Parameters"], [13, "Copy OIA"], [90, "Send File"]]) {
    const r = await hllapi(fn, "", 8);
    check(`**未実装 ${name} (${fn}) は rc=10**`, r.rc === 10, `rc=${r.rc}`);
  }

  // ---- 9. Query System / Sessions ----
  const qsys = await hllapi(20, "", 64);
  check("Query System (20)", qsys.rc === 0 && qsys.data.includes("ts5250"), `"${qsys.data.trim()}"`);
  const qses = await hllapi(10, "", 256);
  check("Query Sessions (10) に短縮名が出る", qses.rc === 0 && qses.data.trim().startsWith("A"),
    `"${qses.data.trim()}"`);

  // ---- 9.5 Send Key（**実機で AID を送る**） ----
  // **Enter を使う。** サインオン画面は F1（ヘルプ）も F3（終了）も無視するので、
  // それらで「変化なし」を見ても AID が届いたか分からない（実機で切り分けた）。
  // 欄は空のまま送るので**サインオンは試行されない**（画面が描き直されるだけ）
  const beforeKey = await hllapi(5, "", cells);
  const key = await hllapi(3, "@E");
  check("Send Key (3) が AID を送れる（Enter）", key.rc === 0, `rc=${key.rc}`);
  await new Promise((r) => setTimeout(r, 1500));
  const afterKey = await hllapi(5, "", cells);
  check("**送った結果、画面が変わった**（AID がホストへ届いている）",
    afterKey.data !== beforeKey.data, `変化 ${afterKey.data === beforeKey.data ? "なし" : "あり"}`);

  // **写せないキーは何も送らずに rc=20**
  const pa1 = await hllapi(3, "@x");
  check("**5250 に無いキー（PA1）は rc=20**", pa1.rc === 20, `rc=${pa1.rc}`);
  const mixed = await hllapi(3, "@E@x");
  check("**混ざっていたら何も送らない（rc=20）**", mixed.rc === 20, `rc=${mixed.rc}`);

  // ---- 9.7 予約（Reserve / Release）----
  // **締め出しが本当に効くかを、締め出される側から見る。** `rc=0` が返るだけでは
  // 「予約したつもり」で終わる。人間の経路（`assertKeyAllowed`）が断ることまで確かめる。
  const humanBlocked = () => {
    try {
      sessions.assertKeyAllowed(opened.id, "Enter");
      return false;
    } catch (e) {
      return String(e).includes("reserved");
    }
  };
  check("予約前は人間が打てる（対照）", !humanBlocked());
  const res = await hllapi(11, "", 8);
  check("Reserve (11)", res.rc === 0, `rc=${res.rc}`);
  check("**予約中は人間の入力が断られる**", humanBlocked());
  // 予約の持ち主（HLLAPI 自身）は通る
  const whileReserved = await hllapi(5, "", cells);
  check("**予約中も自動化自身は読める**", whileReserved.rc === 0, `rc=${whileReserved.rc}`);
  const rel = await hllapi(12, "", 8);
  check("Release (12)", rel.rc === 0, `rc=${rel.rc}`);
  check("**解除で人間が打てるようになる**", !humanBlocked());

  // **Disconnect でも外れる**（正常終了したのに締め切ったままにしない）
  await hllapi(11, "", 8);
  check("再度 Reserve できる", humanBlocked());

  // ---- 10. Disconnect ----
  const dis = await hllapi(2, "A", 1);
  check("Disconnect (2)", dis.rc === 0, `rc=${dis.rc}`);
  check("**Disconnect で予約も外れる**（締め切ったままにしない）", !humanBlocked());
  const after = await hllapi(5, "", 100);
  check("**切断後の操作は rc=8**（呼ぶ順序が違う）", after.rc === 8, `rc=${after.rc}`);

  // ---- 11. Rust に状態が無い（別プロセスから叩いても壊れない） ----
  const again = await hllapi(1, "A", 1);
  check("別プロセスから Connect し直せる（**Rust に状態が無い**）", again.rc === 0, `rc=${again.rc}`);

  sessions.closeAll?.();
} catch (e) {
  check("例外なく完走する", false, String(e));
} finally {
  server.close();
  wss.close();
}

const ng = results.filter((r) => !r.ok).length;
process.stdout.write(`\n=== ${results.length} 件中 失敗 ${ng} 件 ===\n`);
process.exit(ng === 0 ? 0 : 1);
