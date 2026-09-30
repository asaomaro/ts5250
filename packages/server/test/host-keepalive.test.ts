import { describe, it, expect } from "vitest";
import { hostAuthFrom } from "../src/host-connect.js";

/**
 * **ホストサーバーの接続へ `keepAlive` が届く**（`20260930-hostserver-keepalive-off`）。待ち行列・メッセージの常駐監視は、解決したセッション設定の `keepAlive` を
 * `hostAuthFrom` 経由で接続クラスへ渡す。既定は入れない（ACS 同梱の `jt400` と同じ）
 */
describe("hostAuthFrom の keepAlive", () => {
  const base = { host: "h", user: "u", password: "p" };

  it("設定にあれば載る", () => {
    expect(hostAuthFrom({ ...base, keepAlive: true }).keepAlive).toBe(true);
  });

  it("**無ければキーごと載らない**（接続クラスの既定 false＝入れない）", () => {
    expect("keepAlive" in hostAuthFrom(base)).toBe(false);
  });
});
