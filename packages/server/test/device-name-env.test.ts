import { describe, it, expect } from "vitest";
import { hostname } from "node:os";
import { SessionManager, deviceNameEnvFor } from "../src/session-manager.js";
import type { Transport } from "@ts5250/tn5250";

/**
 * **装置名の `&COMPN` / `&USERN` に入れる値**（ACS `AutoDeviceName5250.getClientID` に当たる。`20260921-device-name-acs`）。
 * ACS は ACS が動く機械の名前と OS の利用者名。当 PJ で ACS の役をするのはサーバーなので、機械名はサーバーの名前、
 * 利用者名は認証が有効なら開いた人（`owner`）。
 */
describe("deviceNameEnvFor", () => {
  it("機械名はサーバーの名前の最初の `.` まで、利用者名は開いた人", () => {
    const env = deviceNameEnvFor("alice");
    expect(env.userName).toBe("alice");
    expect(env.computerName).toBe(hostname().split(".")[0]);
  });
  it("開いた人がいなければ（認証が無効）サーバーの OS の利用者名", () => {
    expect(typeof deviceNameEnvFor().userName).toBe("string");
  });
});

describe("SessionManager が装置名の展開に値を渡す", () => {
  const SEND = [0xff, 0xfa, 0x27, 0x01, 0xff, 0xf0];
  function capturing(): { transport: Transport; devnames: () => string[] } {
    let onData: ((d: Uint8Array) => void) | undefined;
    const sent: number[] = [];
    const transport = {
      onData: (cb: (d: Uint8Array) => void) => void (onData = cb),
      onClose: () => {},
      onError: () => {},
      send: (d: Uint8Array) => void sent.push(...d),
      close: () => {},
      start: () => onData?.(Uint8Array.from(SEND))
    } as unknown as Transport;
    const devnames = (): string[] =>
      [...String.fromCharCode(...sent).matchAll(/DEVNAME\x01([A-Z0-9]*)/g)].map((m) => m[1]!);
    return { transport, devnames };
  }

  it("表示: `&USERN` が開いた人の名前（大文字）になる", async () => {
    const { transport, devnames } = capturing();
    const mgr = new SessionManager();
    await mgr.open({ transport, deviceName: "&USERN", owner: "alice", negotiationTimeoutMs: 100 }).catch(() => {});
    expect(devnames()).toEqual(["ALICE"]);
    mgr.closeAll();
  });

  it("プリンター: `%&USERN` が P と開いた人の名前になる", async () => {
    const { transport, devnames } = capturing();
    const mgr = new SessionManager();
    const entry = await mgr.openPrinter({ transport, deviceName: "%&USERN", owner: "bob", negotiationTimeoutMs: 100 }).catch(() => undefined);
    expect(devnames()).toEqual(["PBOB"]);
    void entry;
    mgr.closeAll();
  });
});
