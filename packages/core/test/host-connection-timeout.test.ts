import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { openHostConnection, type HostConnection } from "../src/transport/host-connection.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * `request(frame, { readTimeoutMs })` の 1 往復タイムアウト上書きを、遅延応答する偽サーバーで確かめる。
 *
 * ここで守りたいのは**後方互換**——`opts` を省略した既存の全呼び出し（signon/SQL/IFS/command）は
 * 従来どおり接続既定の `timeoutMs` で動くこと。上書きはその往復だけ効き、次の要求では元に戻ること。
 */
let server: Server | undefined;
let conn: HostConnection | undefined;

afterEach(async () => {
  conn?.close();
  conn = undefined;
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

/** 先頭 4 バイトが全長のフレーム（中身は識別用 1 バイト） */
function frame(tag: number): Buffer {
  const b = Buffer.alloc(5);
  b.writeUInt32BE(5, 0);
  b.writeUInt8(tag, 4);
  return b;
}

/** 要求を受けるたびに、その回の遅延（ms）だけ待ってからフレームを返す偽サーバー */
function slowHost(delaysMs: number[]): Promise<number> {
  return new Promise((resolve) => {
    let turn = 0;
    server = createServer((sock) => {
      sock.on("data", () => {
        const t = turn++;
        const delay = delaysMs[t] ?? 0;
        setTimeout(() => sock.write(frame(t + 1)), delay);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve((server!.address() as { port: number }).port);
    });
  });
}

describe("request の readTimeoutMs（1 往復のタイムアウト上書き）", () => {
  it("opts 省略時は接続既定の timeoutMs のまま（後方互換）", async () => {
    // 既定 100ms、応答は 300ms 遅れる → 既定が生きていれば時間切れになる
    const port = await slowHost([300]);
    conn = await openHostConnection({ host: "127.0.0.1", port, timeoutMs: 100 });
    await expect(conn.request(frame(0))).rejects.toThrow(Tn5250Error);
  });

  it("readTimeoutMs を渡すとその往復だけ延びる", async () => {
    const port = await slowHost([300]);
    conn = await openHostConnection({ host: "127.0.0.1", port, timeoutMs: 100 });
    // 既定 100ms なら切れるが、1000ms に延ばせば 300ms の応答を受け取れる
    const reply = await conn.request(frame(0), { readTimeoutMs: 1000 });
    expect(reply[4]).toBe(1);
  });

  it("readTimeoutMs: 0 でタイムアウトを無効化（無限待ち）", async () => {
    const port = await slowHost([300]);
    conn = await openHostConnection({ host: "127.0.0.1", port, timeoutMs: 100 });
    const reply = await conn.request(frame(0), { readTimeoutMs: 0 });
    expect(reply[4]).toBe(1);
  });

  it("上書きした往復の後は既定に戻る", async () => {
    // 1 往復目は延ばして成功、2 往復目は opts 省略で既定 100ms → 300ms 応答で時間切れ
    const port = await slowHost([300, 300]);
    conn = await openHostConnection({ host: "127.0.0.1", port, timeoutMs: 100 });

    const first = await conn.request(frame(0), { readTimeoutMs: 1000 });
    expect(first[4]).toBe(1);

    // 既定に戻っているので、延ばさない 2 往復目は切れる
    await expect(conn.request(frame(0))).rejects.toThrow(/timed out after 100ms/);
  });
});
