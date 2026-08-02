/**
 * 実機のデータ待ち行列サーバー（as-dtaq）に対する手動チェック。
 *
 * 自動テストにはしない——実機・実アカウントを要するため（他の check と同じ方針）。
 *
 * 使い方:
 *   AS400_USER=xxx AS400_PASSWORD=yyy \
 *     npm run dtaq -w @ts5250/hostserver-check -- --tls --library MYLIB
 *   さらに無限待ちも見るなら: -- --tls --wait-test
 *
 * 検証内容:
 *  1) 接続（signon → port → startServer(0xE007) → 交換属性）
 *  2) FIFO の送受信・ピーク・空キュー・送信者情報
 *  3) LIFO の順序
 *  4) キー付きの送信とキー検索（EQ/GE 等）
 *  5) 属性取得（0x8001）を parseAttributesReply で解いた結果
 *  6) クリア
 *  7) （--wait-test）無限待ち wait=-1 が transport 改修で切れないこと
 *
 * QSYS2 の SQL サービス（DATA_QUEUE_INFO / DATA_QUEUE_ENTRIES）と突き合わせて確かめること。
 */
import "./log-init.js";
import { As400Error } from "@ts5250/base";
import { DtaqConnection, dtaqDecodeEbcdic } from "@ts5250/hostserver";

const host = process.env["AS400_HOST"] ?? process.env["PUB400_HOST"] ?? "pub400.com";
const user = process.env["AS400_USER"] ?? process.env["PUB400_USER"];
const password = process.env["AS400_PASSWORD"] ?? process.env["PUB400_PASSWORD"];
const useTls = process.argv.includes("--tls");

function argValue(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}
const library = argValue("--library", "MYLIB");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
if (!user || !password) fail("AS400_USER / AS400_PASSWORD を環境変数で指定してください");

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const out = (s: string): void => void process.stdout.write(s);

async function connect(): Promise<DtaqConnection> {
  return DtaqConnection.connect({ host, user: user as string, password: password as string, tls: useTls });
}

/** キューを作り直す（前回の残りがあれば消す） */
async function fresh(
  conn: DtaqConnection,
  name: string,
  opts: { type: "FIFO" | "LIFO" | "KEYED"; keyLength?: number; saveSender?: boolean }
): Promise<void> {
  await conn.deleteQueue(name, library).catch(() => undefined);
  await conn.create({ name, library, maxEntryLength: 200, ...opts });
}

async function main(): Promise<void> {
  out(`host=${host} tls=${useTls} library=${library}\n\n`);
  const conn = await connect();
  out("接続 OK（signon → startServer(0xE007) → 交換属性）\n\n");

  try {
    // --- FIFO ---
    await fresh(conn, "DTAQSPK", { type: "FIFO", saveSender: true });
    out("FIFO 作成 OK（maxLen 200, saveSender）\n");
    for (const s of ["first", "second", "third"]) await conn.write("DTAQSPK", library, enc(s));

    const peek = await conn.read({ name: "DTAQSPK", library, wait: 0, peek: true });
    out(`peek: ${peek ? dec(peek.data) : "(空)"}（消費しないはず）\n`);

    const got: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await conn.read({ name: "DTAQSPK", library, wait: 0 });
      if (e) got.push(dec(e.data));
    }
    out(`FIFO 受信順（first→second→third 期待）: ${got.join(" → ")}\n`);
    const empty = await conn.read({ name: "DTAQSPK", library, wait: 0 });
    out(`空キュー: ${empty === undefined ? "undefined（OK）" : "!!! 値が返った"}\n`);

    await conn.write("DTAQSPK", library, enc("with-sender"));
    const ws = await conn.read({ name: "DTAQSPK", library, wait: 0 });
    out(`送信者情報: ${ws?.senderInfo ? dtaqDecodeEbcdic(ws.senderInfo) : "なし"}\n\n`);

    // --- 属性取得 ---
    const attrs = await conn.attributes("DTAQSPK", library);
    out(`属性: ${JSON.stringify(attrs)}\n`);
    out("  → QSYS2.DATA_QUEUE_INFO と突き合わせること（maxEntryLength/type/keyLength/saveSender）\n\n");

    // --- LIFO ---
    await fresh(conn, "DTAQLIFO", { type: "LIFO" });
    for (const s of ["a", "b", "c"]) await conn.write("DTAQLIFO", library, enc(s));
    const lifo: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await conn.read({ name: "DTAQLIFO", library, wait: 0 });
      if (e) lifo.push(dec(e.data));
    }
    out(`LIFO 受信順（c→b→a 期待）: ${lifo.join(" → ")}\n\n`);

    // --- キー付き ---
    await fresh(conn, "DTAQKEY", { type: "KEYED", keyLength: 4 });
    await conn.write("DTAQKEY", library, enc("val-10"), enc("0010"));
    await conn.write("DTAQKEY", library, enc("val-20"), enc("0020"));
    await conn.write("DTAQKEY", library, enc("val-30"), enc("0030"));
    const eq = await conn.read({ name: "DTAQKEY", library, wait: 0, key: enc("0020"), search: "EQ", peek: true });
    out(`キー EQ 0020（peek）: ${eq ? dec(eq.data) : "(なし)"}（val-20 期待）\n`);
    const ge = await conn.read({ name: "DTAQKEY", library, wait: 0, key: enc("0020"), search: "GT", peek: true });
    out(`キー GT 0020（peek）: ${ge ? dec(ge.data) : "(なし)"}（val-30 期待）\n`);
    const lt = await conn.read({ name: "DTAQKEY", library, wait: 0, key: enc("0020"), search: "LT", peek: true });
    out(`キー LT 0020（peek）: ${lt ? dec(lt.data) : "(なし)"}（val-10 期待）\n`);
    const keyAttrs = await conn.attributes("DTAQKEY", library);
    out(`KEYED 属性: ${JSON.stringify(keyAttrs)}（type KEYED, keyLength 4 期待）\n`);
    const lifoAttrs = await conn.attributes("DTAQLIFO", library);
    out(`LIFO 属性: ${JSON.stringify(lifoAttrs)}（type LIFO 期待）\n\n`);

    // --- クリア ---
    await conn.clear("DTAQKEY", library);
    const afterClear = await conn.read({ name: "DTAQKEY", library, wait: 0, key: enc("0010"), search: "GE" });
    out(`クリア後の受信: ${afterClear === undefined ? "undefined（OK）" : "!!! まだ残っている"}\n`);
  } finally {
    for (const n of ["DTAQSPK", "DTAQLIFO", "DTAQKEY"]) {
      await conn.deleteQueue(n, library).catch(() => undefined);
    }
    conn.close();
  }

  // --- 無限待ち（wait=-1）: 別接続から遅れて送り、先にタイムアウトしないか ---
  if (process.argv.includes("--wait-test")) {
    out("\n=== 無限待ち（wait=-1）の検証 ===\n");
    const waitConn = await connect();
    const wq = "DTAQWAIT";
    const started = process.hrtime.bigint();
    const elapsed = (): number => Number((process.hrtime.bigint() - started) / 1_000_000n);
    try {
      await waitConn.deleteQueue(wq, library).catch(() => undefined);
      await waitConn.create({ name: wq, library, maxEntryLength: 100, type: "FIFO" });
      setTimeout(() => {
        void (async () => {
          const c2 = await connect();
          await c2.write(wq, library, enc("delayed-entry"));
          c2.close();
          out(`  ${elapsed()}ms 後に別接続から送信\n`);
        })();
      }, 25_000); // 既定 20 秒タイムアウトを跨ぐ遅延（改修前はここで切れていた）
      out("wait=-1 で受信を張る（25 秒後に届く）…\n");
      const e = await waitConn.read({ name: wq, library, wait: -1 });
      out(`受信: ${e ? dec(e.data) : "(空)"} / ${elapsed()}ms 待った\n`);
    } finally {
      await waitConn.deleteQueue(wq, library).catch(() => undefined);
      waitConn.close();
    }
  }
}

main().catch((e: unknown) => {
  if (e instanceof As400Error) fail(`失敗しました [${e.code}] ${e.message}`);
  fail(`予期しないエラー: ${String(e)}`);
});
