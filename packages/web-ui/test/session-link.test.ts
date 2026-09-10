import { describe, it, expect } from "vitest";
import {
  acceptsFrame,
  acceptsFromSession,
  isCurrentAttempt,
  isSessionClient,
  type Attempt,
  type SessionLink
} from "../src/session-link.js";
import type { WsClient } from "../src/ws-client.js";

/**
 * **R4 の述語の真理値表**（`20260910-session-reconnect-freeze`）。
 *
 * `acceptsFrame` は 2 つの問いの**選言**で、片方だけでは足りない——第 1 項だけだと
 * 繋ぎ直しに成功した瞬間から全フレームが落ち（`20260908-session-lifetime-rules-fold` の
 * `decisions.md` D13）、第 2 項だけだと成功前の飛行中の試行からの更新が落ちる。
 *
 * **合成そのものをここで固定する。** 経路のテスト（`session-reconnect.test.ts`）が叩けるのは
 * 第 2 項の両側だけで、**片項へ縮めても回帰が緑のままだった**（本 work の cross 点検が実測）。
 * 規則は依存ゼロの純粋モジュールなので、口はただの参照として置ける。
 */
const sock = (): WsClient => ({}) as unknown as WsClient;
const CONNECTED: SessionLink = { state: "connected" };
const LADDER: SessionLink = { state: "reconnecting", attempt: 1, max: 5 };
const attempt = (client: WsClient, settled = false): Attempt => ({
  index: 0,
  client,
  timer: undefined,
  settled
});

describe("R4: この口から届いたフレームを受け取ってよいか", () => {
  it("代表の試行なら、セッションの口でなくても通す（第 1 項。はしごの最中でも）", () => {
    const a = attempt(sock());
    expect(acceptsFrame(a, a, sock(), a.client!, LADDER)).toBe(true);
  });

  it("代表でなくなっても、繋がっているセッションの口なら通す（第 2 項＝繋ぎ直しの成功後）", () => {
    const a = attempt(sock(), true);
    expect(acceptsFrame(undefined, a, a.client!, a.client!, CONNECTED)).toBe(true);
  });

  it("**はしごの最中は、セッションの口でも第 2 項を通さない**（`20260910-session-reconnect-freeze` の review ラウンド1）", () => {
    const a = attempt(sock(), true);
    // 口は依然セッションのもの（差し替えは成功時にしか起きない）——それでも通さない
    expect(isSessionClient(a.client!, a.client!)).toBe(true);
    expect(acceptsFrame(undefined, a, a.client!, a.client!, LADDER)).toBe(false);
  });

  it("諦めた後（`lost`）も第 2 項を通さない", () => {
    const a = attempt(sock(), true);
    expect(acceptsFrame(undefined, a, a.client!, a.client!, { state: "lost", cause: "gaveUp" })).toBe(false);
  });

  it("セッションが消えていれば（`link` が無い）第 2 項を通さない", () => {
    const a = attempt(sock(), true);
    expect(acceptsFrame(undefined, a, a.client!, a.client!, undefined)).toBe(false);
  });

  it("どちらでもない口は弾く（打ち切った試行）", () => {
    const a = attempt(sock(), true);
    expect(acceptsFrame(undefined, a, sock(), a.client!, CONNECTED)).toBe(false);
  });

  it("代表のままでも `settled` なら第 1 項は偽（外し忘れに効く保険の項）", () => {
    const a = attempt(sock(), true);
    expect(isCurrentAttempt(a, a)).toBe(false);
    expect(acceptsFrame(a, a, sock(), a.client!, CONNECTED)).toBe(false);
  });

  it("`acceptsFromSession` は第 2 項そのもの（試行を持たない初回接続の口が呼ぶ）", () => {
    const only = sock();
    expect(acceptsFromSession(CONNECTED, only, only)).toBe(true);
    expect(acceptsFromSession(LADDER, only, only)).toBe(false);
    expect(acceptsFromSession(CONNECTED, sock(), only)).toBe(false);
    expect(acceptsFromSession(undefined, only, only)).toBe(false);
  });

  it("口を持たないセッションでは第 2 項は偽（`undefined` は口ではない）", () => {
    const only = sock();
    expect(isSessionClient(undefined, only)).toBe(false);
  });
});
