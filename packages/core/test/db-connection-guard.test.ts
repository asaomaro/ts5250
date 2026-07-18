import { describe, it, expect } from "vitest";
import { DbConnection } from "../src/hostserver/db/db-connection.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * 文名・カーソル名は接続ごとに固定なので、同じ接続で問い合わせを重ねると踏み合う。
 * とくに逐次取得は行の合間に制御を返すため、消費側が反復の途中で別の問い合わせを
 * 始められてしまう。静かにデータが混ざるより、明示的に失敗させる。
 */
function fakeConnection(): DbConnection {
  // acquire / close だけを試すため、接続処理を通さずに実体を作る
  return Object.create(DbConnection.prototype) as DbConnection;
}

describe("DbConnection.acquire（問い合わせの重複実行を弾く）", () => {
  it("解放すれば次の問い合わせを開始できる", () => {
    const c = fakeConnection();
    const release = c.acquire();
    release();
    expect(() => c.acquire()).not.toThrow();
  });

  it("実行中に重ねると拒否する", () => {
    const c = fakeConnection();
    c.acquire();
    expect(() => c.acquire()).toThrow(Tn5250Error);
    expect(() => c.acquire()).toThrow(/another query is in progress/);
  });

  it("複数回解放しても壊れない", () => {
    const c = fakeConnection();
    const release = c.acquire();
    release();
    release();
    expect(() => c.acquire()).not.toThrow();
  });

  it("エラーメッセージが回避策を示す", () => {
    const c = fakeConnection();
    c.acquire();
    expect(() => c.acquire()).toThrow(/open a second connection/);
  });
});
