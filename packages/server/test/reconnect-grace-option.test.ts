import { describe, it, expect } from "vitest";
import { parseConnectionHold, parseReconnectGrace, parseStalledGrace, sessionManagerOptions } from "../src/main.js";
import { DEFAULT_RECONNECT_GRACE_MS, DEFAULT_STALLED_GRACE_MS } from "../src/session-manager.js";

/**
 * **`--reconnect-grace`**（20260929-reconnect-grace-option）。放置したタブが止まると、ブラウザは心拍に返事できず接続が切れ、
 * サーバーは猶予のあとにホストへの接続をサインオフなしで閉じる。猶予を起動オプションで変えられるようにした。
 * 単位は分、または `never`（`--idle-timeout` と同じ）。既定は、WebSocket が閉じたとき（`--reconnect-grace`）が 90 秒、
 * **心拍が途絶えたとき（`--stalled-grace`）が `never`**（時間では切らない。ACS に倣う。以前は 10 分）
 */
describe("--reconnect-grace の解釈", () => {
  it("分を ms にする", () => {
    expect(parseReconnectGrace("10")).toBe(10 * 60_000);
    expect(parseReconnectGrace("1")).toBe(60_000);
    expect(parseReconnectGrace("1440")).toBe(1440 * 60_000);
  });

  it("never は『時間では切らない』（既定と同じ。明示できるようにしてある）", () => {
    expect(parseReconnectGrace("never")).toBe("never");
    expect(parseStalledGrace("never")).toBe("never");
  });

  it("0・範囲外・小数・非数値・未指定は起動時に弾く（0 を『猶予なし』にも『無期限』にも使わない）", () => {
    for (const bad of ["0", "-1", "1441", "1.5", "abc", "", undefined]) {
      expect(() => parseReconnectGrace(bad), String(bad)).toThrow(/--reconnect-grace/);
    }
  });
});

describe("SessionManager へ渡す寿命の設定", () => {
  it("--reconnect-grace を渡すと reconnectGraceMs になる", () => {
    expect(sessionManagerOptions({ idleTimeoutMs: undefined, reconnectGraceMs: 600_000, stalledGraceMs: undefined })).toEqual({ reconnectGraceMs: 600_000 });
  });

  it("never を渡すとそのまま届く", () => {
    expect(sessionManagerOptions({ idleTimeoutMs: undefined, reconnectGraceMs: "never", stalledGraceMs: "never" })).toEqual({ reconnectGraceMs: "never", stalledGraceMs: "never" });
  });

  it("指定が無ければキーごと付けない（マネージャの既定＝閉じたら 90 秒・心拍が途絶えたら never に任せる）", () => {
    const o = sessionManagerOptions({ idleTimeoutMs: undefined, reconnectGraceMs: undefined, stalledGraceMs: undefined });
    expect(o).toEqual({ connectionHoldMs: "never" });
    expect("reconnectGraceMs" in o).toBe(false);
    expect(DEFAULT_RECONNECT_GRACE_MS).toBe(90_000);
    expect(DEFAULT_STALLED_GRACE_MS).toBe("never");
  });

  it("--idle-timeout と併せて渡せる", () => {
    expect(sessionManagerOptions({ idleTimeoutMs: 30 * 60_000, reconnectGraceMs: 300_000, stalledGraceMs: undefined })).toEqual({ idleTimeoutMs: 30 * 60_000, reconnectGraceMs: 300_000 });
  });
});

describe("--stalled-grace（心拍が途絶えて切れたときの猶予）", () => {
  it("分を ms にし、範囲外・小数・非数値・未指定は起動時に弾く", () => {
    expect(parseStalledGrace("30")).toBe(30 * 60_000);
    for (const bad of ["0", "1441", "1.5", "abc", "", undefined]) {
      expect(() => parseStalledGrace(bad), String(bad)).toThrow(/--stalled-grace/);
    }
  });

  it("SessionManager へ渡す（指定が無ければキーごと付けない）", () => {
    expect(sessionManagerOptions({ idleTimeoutMs: undefined, reconnectGraceMs: undefined, stalledGraceMs: 900_000 })).toEqual({ stalledGraceMs: 900_000 });
    expect("stalledGraceMs" in sessionManagerOptions({ idleTimeoutMs: undefined, reconnectGraceMs: undefined, stalledGraceMs: undefined })).toBe(false);
  });
});


describe("--connection-hold", () => {
  it("0・分・無期限を受理する", () => {
    expect(parseConnectionHold("0")).toBe(0);
    expect(parseConnectionHold("10")).toBe(600000);
    expect(parseConnectionHold("never")).toBe("never");
    for (const value of ["-1", "0.5", "1441", "abc", "", undefined]) expect(() => parseConnectionHold(value)).toThrow(/--connection-hold/);
  });
  it("新設定が旧設定より優先し、0 を落とさない", () => {
    expect(sessionManagerOptions({ idleTimeoutMs: undefined, reconnectGraceMs: 90000, stalledGraceMs: "never", connectionHoldMs: 0 })).toMatchObject({ connectionHoldMs: 0 });
  });
});
