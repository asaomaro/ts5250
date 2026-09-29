import { describe, it, expect } from "vitest";
import { parseReconnectGrace, parseStalledGrace, sessionManagerOptions } from "../src/main.js";
import { DEFAULT_RECONNECT_GRACE_MS } from "../src/session-manager.js";

/**
 * **`--reconnect-grace`**（20260929-reconnect-grace-option）。放置したタブが止まると、ブラウザは心拍に返事できず接続が切れ、
 * サーバーは猶予（既定 90 秒）のあとにホストへの接続をサインオフなしで閉じる。猶予を起動オプションで延ばせるようにした。
 * 単位は分（`--idle-timeout` と同じ）
 */
describe("--reconnect-grace の解釈", () => {
  it("分を ms にする", () => {
    expect(parseReconnectGrace("10")).toBe(10 * 60_000);
    expect(parseReconnectGrace("1")).toBe(60_000);
    expect(parseReconnectGrace("1440")).toBe(1440 * 60_000);
  });

  it("0・範囲外・小数・非数値・未指定は起動時に弾く（0 を『猶予なし』に使わない）", () => {
    for (const bad of ["0", "-1", "1441", "1.5", "abc", "", undefined]) {
      expect(() => parseReconnectGrace(bad), String(bad)).toThrow(/--reconnect-grace/);
    }
  });
});

describe("SessionManager へ渡す寿命の設定", () => {
  it("--reconnect-grace を渡すと reconnectGraceMs になる", () => {
    expect(sessionManagerOptions({ idleTimeoutMs: undefined, reconnectGraceMs: 600_000, stalledGraceMs: undefined })).toEqual({ reconnectGraceMs: 600_000 });
  });

  it("指定が無ければキーごと付けない（マネージャの既定 90 秒に任せる）", () => {
    const o = sessionManagerOptions({ idleTimeoutMs: undefined, reconnectGraceMs: undefined, stalledGraceMs: undefined });
    expect(o).toEqual({});
    expect("reconnectGraceMs" in o).toBe(false);
    expect(DEFAULT_RECONNECT_GRACE_MS).toBe(90_000);
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
