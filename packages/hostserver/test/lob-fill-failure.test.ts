import { describe, it, expect, afterEach } from "vitest";
import { As400Error, setLogSink, resetLogSink } from "@ts5250/base";
import { fillLobs } from "../src/db/query.js";
import type { DbConnection } from "../src/db/db-connection.js";
import type { DbValue, LobPlaceholder } from "../src/db/db-decode.js";

/**
 * LOB の取得に失敗したセルが `unavailable: "failed"` になることを固定する。
 *
 * **以前は `"not-requested"` を入れていた**（取りに行っていない、と同じ値）。画面は
 * その値を見て「左のチェックで取得」と案内するので、**既に要求した人に同じ操作を勧めていた**
 * （`.aidev/works/20260801-sql-lob-failed-state`）。
 *
 * `retrieveLob` が使う接続の口は `conn.request` 1 つだけなので、そこだけ持つ偽の接続で足りる
 * （`query()` 越しに踏ませると prepare / describe / fetch の応答を丸ごと偽装することになり、
 * テストが失敗の再現ではなくプロトコルの模写になる）。
 */
function failingConn(onRequest: () => never): DbConnection {
  return { request: async () => onRequest() } as unknown as DbConnection;
}

const lob = (locator: number, maxSize = 1024): LobPlaceholder => ({
  kind: "lob",
  locator,
  maxSize,
  unavailable: "not-requested"
});

describe("fillLobs の失敗セル", () => {
  it("取りに行って失敗したら failed（not-requested に混ぜない）", async () => {
    const rows: Record<string, DbValue>[] = [{ ID: 1, DOC: lob(7) }];
    await fillLobs(
      failingConn(() => {
        throw new As400Error("PROTOCOL_ERROR", "LOB の取得に失敗しました（locator=7, rcClass=1）");
      }),
      rows,
      { maxBytes: 4096 }
    );

    const got = rows[0]!.DOC as LobPlaceholder;
    expect(got.unavailable).toBe("failed");
  });

  it("ロケーターと maxSize は残す（取り直す手がかりを消さない）", async () => {
    const rows: Record<string, DbValue>[] = [{ DOC: lob(42, 65536) }];
    await fillLobs(
      failingConn(() => {
        throw new As400Error("PROTOCOL_ERROR", "boom");
      }),
      rows,
      { maxBytes: 4096 }
    );

    const got = rows[0]!.DOC as LobPlaceholder;
    expect(got).toMatchObject({ kind: "lob", locator: 42, maxSize: 65536 });
    // 取れていないので中身と長さは付かない（**空文字で埋めない**）
    expect(got.value).toBeUndefined();
    expect(got.byteLength).toBeUndefined();
  });

  it("1 セルの失敗で残りを捨てない（行内の他セル・後続の行も処理する）", async () => {
    const rows: Record<string, DbValue>[] = [
      { ID: 1, A: lob(1), B: lob(2) },
      { ID: 2, A: lob(3), NAME: "そのまま" }
    ];
    await fillLobs(
      failingConn(() => {
        throw new As400Error("PROTOCOL_ERROR", "boom");
      }),
      rows,
      { maxBytes: 4096 }
    );

    for (const [row, key] of [
      [0, "A"],
      [0, "B"],
      [1, "A"]
    ] as const) {
      expect((rows[row]![key] as LobPlaceholder).unavailable).toBe("failed");
    }
    // LOB でない値には触らない
    expect(rows[0]!.ID).toBe(1);
    expect(rows[1]!.NAME).toBe("そのまま");
  });

  it("例外の型は問わない（As400Error 以外でも failed）", async () => {
    const rows: Record<string, DbValue>[] = [{ DOC: lob(9) }];
    await fillLobs(
      failingConn(() => {
        // 通信断のような素の Error も握る。ここで型を絞ると、絞り漏れた例外が
        // fillLobs を貫通して**クエリ全体を落とす**
        throw new Error("socket hang up");
      }),
      rows,
      { maxBytes: 4096 }
    );

    expect((rows[0]!.DOC as LobPlaceholder).unavailable).toBe("failed");
  });
});

/**
 * 失敗の**理由**は JSON に載せない（ホスト由来のデバッグ文字列のため）ので、
 * ログが唯一の手掛かりになる。画面は「サーバーのログに理由が出ます」と案内しており、
 * **`debug` のままだと既定の sink で消えてその案内が嘘になる**（decisions D3）。
 */
describe("失敗理由のログ", () => {
  afterEach(() => resetLogSink());

  it("warn で出す（debug だと既定の sink で消える）", async () => {
    const seen: { level: string; message: string }[] = [];
    const record = (level: string) => (message: string) => void seen.push({ level, message });
    setLogSink(() => ({
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      isDebugEnabled: () => true
    }));

    const rows: Record<string, DbValue>[] = [{ DOC: lob(7) }];
    await fillLobs(
      failingConn(() => {
        throw new As400Error("PROTOCOL_ERROR", "rcClass=1");
      }),
      rows,
      { maxBytes: 4096 }
    );

    // **1 件だけ**を固定する（filter で数えると warn 1 件＋debug 1 件でも通ってしまう）
    expect(seen).toHaveLength(1);
    expect(seen[0]!.level).toBe("warn");
    // ロケーターと例外の中身が両方読める（どのセルが・なぜ落ちたか）
    expect(seen[0]!.message).toContain("7");
    expect(seen[0]!.message).toContain("rcClass=1");
  });
});
