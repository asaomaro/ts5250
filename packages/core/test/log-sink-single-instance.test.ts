import { describe, it, expect, vi, afterEach } from "vitest";
// **`setLogSink` は core のバレル経由で取る**——このテストが確かめたいのは
// 「core から差し込んだ sink が hostserver 側へ届くこと」なので、
// `@as400web/base` から直接取ると経路が 1 つ短くなり、検査の意味が薄れる。
import { setLogSink, resetLogSink, type CoreLogger } from "../src/index.js";
// ログを出させる側は hostserver から直接取る（core は再輸出しなくなった）
import { insertRows, type DbConnection } from "@as400web/hostserver";

/**
 * **ログの差し込み口がパッケージ境界を越えて効くこと。**
 *
 * `log.ts` はモジュールスコープに可変の `factory` を持ち、`setLogSink` がそれを書き換える。
 * だから**複製したら壊れる**——`@as400web/core` と `@as400web/hostserver` がそれぞれ自分の
 * `log.ts` を持つと、アプリが起動時に 1 度呼ぶ `setLogSink` は片方にしか効かず、
 * もう片方のログが**黙って消える**。型検査でもビルドでも気づけない。
 * この性質が `errors.ts` とともに `@as400web/base` を独立させた理由そのものである
 * （`20260801-library-extraction-hostserver` decisions.md D4）。
 *
 * 実際に届くことを確かめるため、**ホストサーバー側で `log.warn` を通る経路**を叩く——
 * `insertRows` の部分失敗（`insert.ts` の「partial insert」）。応答を差し替えれば
 * 接続なしで再現できる。ここを別の経路に差し替えるときは、
 * **`@as400web/hostserver` 側のモジュールが自前の `childLog` で出していること**を保つこと
 * （引数でロガーを渡す関数を選ぶと、差し込み口の検査にならない）。
 */

/** マーカー形式（CHAR(4) 1 列）。`insert-failure.test.ts` と同じ組み立て */
function markerFormat(): Uint8Array {
  const out = new Uint8Array(16 + 48);
  const v = new DataView(out.buffer);
  v.setUint32(4, 1); // 列数
  v.setUint32(12, 4); // 行サイズ
  v.setUint16(16 + 2, 452); // CHAR
  v.setUint32(16 + 4, 4); // 長さ
  v.setUint16(16 + 12, 37); // CCSID
  return out;
}

/** SQLCA（136 バイト）。`sqlCode` は 12 バイト目 */
function sqlca(sqlCode: number, updateCount = 1): Uint8Array {
  const out = new Uint8Array(136);
  const v = new DataView(out.buffer);
  v.setInt32(12, sqlCode);
  v.setInt32(104, updateCount);
  return out;
}

function fakeConn(replies: { params: { cp: number; value: Uint8Array }[] }[]) {
  let i = 0;
  return {
    request: vi.fn(async () => {
      const r = replies[Math.min(i++, replies.length - 1)]!;
      return { params: r.params, dbTemplate: { rcClass: 0, rcClassReturnCode: 0 } };
    })
  } as unknown as DbConnection;
}

afterEach(() => {
  resetLogSink();
});

describe("setLogSink の単一インスタンス（core → base → hostserver）", () => {
  it("core から差し込んだ出力先に、hostserver 側のログが届く", async () => {
    const seen: { component: unknown; message: string }[] = [];
    setLogSink((bindings) => {
      const push =
        (level: string) =>
        (message: string): void => {
          seen.push({ component: bindings.component, message: `${level}:${message}` });
        };
      return {
        debug: push("debug"),
        info: push("info"),
        warn: push("warn"),
        error: push("error"),
        isDebugEnabled: () => true
      } satisfies CoreLogger;
    });

    // 準備 → 形式の登録 → 実行（SQLCODE=-204 で部分失敗）
    const conn = fakeConn([
      { params: [{ cp: 0x3813, value: markerFormat() }, { cp: 0x3807, value: sqlca(0) }] },
      { params: [{ cp: 0x3807, value: sqlca(0) }] },
      { params: [{ cp: 0x3807, value: sqlca(-204) }] }
    ]);
    const res = await insertRows(conn, { library: "L", table: "T", columns: ["C"], rows: [["x"]] });
    expect(res.uncertainRange).toEqual({ from: 1, to: 1 });

    // hostserver の `db/insert.ts` が `childLog({ component: "hostserver-sql-insert" })` で出す
    const warn = seen.find((e) => e.component === "hostserver-sql-insert");
    expect(warn, "hostserver 側のログが差し込んだ出力先へ届いていない").toBeDefined();
    expect(warn!.message).toMatch(/^warn:partial insert into L\.T/);
  });

  it("差し込まなければ黙る（既定は no-op のまま）", async () => {
    // 既定に戻した状態でも例外にならず、単に何も出ない
    const conn = fakeConn([
      { params: [{ cp: 0x3813, value: markerFormat() }, { cp: 0x3807, value: sqlca(0) }] },
      { params: [{ cp: 0x3807, value: sqlca(0) }] },
      { params: [{ cp: 0x3807, value: sqlca(-204) }] }
    ]);
    await expect(
      insertRows(conn, { library: "L", table: "T", columns: ["C"], rows: [["x"]] })
    ).resolves.toBeDefined();
  });
});
