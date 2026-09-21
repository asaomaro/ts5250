import { describe, it, expect } from "vitest";
import { TelnetLayer } from "../src/telnet/telnet.js";
import { Session5250 } from "../src/session/session.js";
import type { Transport } from "../src/transport/types.js";
import { IAC, CMD, OPT, ENV_IS, ENV_SEND, ENV_USERVAR, ENV_VALUE } from "../src/telnet/constants.js";
import { FakeTransport } from "./helpers/fake-transport.js";

/**
 * **関連付けプリンター（IBMASSOCPRT）**（`20260921-associated-printer`）。
 *
 * ACS `NVT5250` は関連付けプリンターの装置名が Java の `trim()` で空でなければ、変数表の**最後**（IBMSENDCONFREC の後ろ）に
 * IBMASSOCPRT を積み、値は `(byte)charAt` のまま書く（空白を落とさず、大文字にせず、ESC も挟まない）。
 * 実機（ACS のコア＋`tap-proxy.mjs`）でも、関連付け無しの応答の最後に 1 つ増えるだけだった。
 */
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const ENV_VAR = 0;

function respond(opts: { associatedPrinter?: string; deviceName?: string; user?: string; password?: string }): number[] {
  const t = new FakeTransport();
  new TelnetLayer(t, { terminalType: "IBM-3179-2", ...opts });
  t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
  return t.takeSent();
}

describe("関連付けプリンター（IBMASSOCPRT）", () => {
  it("**応答の最後に** USERVAR IBMASSOCPRT を足す（IBMSENDCONFREC の後ろ）", () => {
    expect(respond({ deviceName: "DSP01", associatedPrinter: "PRT01" })).toEqual([
      IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_IS,
      ENV_USERVAR, ...ascii("DEVNAME"), ENV_VALUE, ...ascii("DSP01"),
      ENV_USERVAR, ...ascii("IBMSENDCONFREC"), ENV_VALUE, ...ascii("YES"),
      ENV_USERVAR, ...ascii("IBMASSOCPRT"), ENV_VALUE, ...ascii("PRT01"),
      IAC, CMD.SE
    ]);
  });

  it("自動サインオンの変数よりも後ろ（ACS の変数表でも IBMSUBSPW・IBMRSEED の後ろ）", () => {
    expect(respond({ user: "U", password: "P", associatedPrinter: "PRT01" })).toEqual([
      IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_IS,
      ENV_USERVAR, ...ascii("IBMSENDCONFREC"), ENV_VALUE, ...ascii("YES"),
      ENV_VAR, ...ascii("USER"), ENV_VALUE, ...ascii("U"),
      ENV_USERVAR, ...ascii("IBMRSEED"), ENV_VALUE,
      ENV_USERVAR, ...ascii("IBMSUBSPW"), ENV_VALUE, ...ascii("P"),
      ENV_USERVAR, ...ascii("IBMASSOCPRT"), ENV_VALUE, ...ascii("PRT01"),
      IAC, CMD.SE
    ]);
  });

  it("**値は加工しない**——空白も小文字もそのまま（ACS は送るかどうかだけ `trim()` で見る）", () => {
    expect(String.fromCharCode(...respond({ associatedPrinter: " prt01 " }))).toContain("IBMASSOCPRT\x01 prt01 \xff\xf0");
  });

  it("文字は下位 8 ビットにする（ACS の `(byte)charAt`）。0xFF になる文字は telnet の IAC として二重にする", () => {
    expect(String.fromCharCode(...respond({ associatedPrinter: "P\uff21" }))).toContain("IBMASSOCPRT\x01P\x21\xff\xf0");
    // 下位 8 ビットに丸めずに渡すと、0x1FF は IAC と見なされずに二重化を逃れ、送信の段で 0xFF に切られて交渉が壊れる
    expect(String.fromCharCode(...respond({ associatedPrinter: "P\u01ff" }))).toContain("IBMASSOCPRT\x01P\xff\xff\xff\xf0");
  });

  it("**空・空白だけ・制御文字だけなら送らず、応答は関連付け無しと 1 バイトも変わらない**", () => {
    const none = respond({ deviceName: "DSP01" });
    for (const v of ["", "   ", "\t\x01"]) {
      expect(respond({ deviceName: "DSP01", associatedPrinter: v }), JSON.stringify(v)).toEqual(none);
    }
    expect(String.fromCharCode(...none)).not.toContain("IBMASSOCPRT");
  });

  it("表示セッションの `associatedPrinter` が telnet の応答まで届く", async () => {
    const sent: number[] = [];
    let onData: ((d: Uint8Array) => void) | undefined;
    const transport = {
      onData: (f: (d: Uint8Array) => void) => void (onData = f),
      onClose: () => {},
      onError: () => {},
      send: (d: Uint8Array) => void sent.push(...d),
      close: () => {}
    } as unknown as Transport;
    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 100, associatedPrinter: "PRT01" }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    onData?.(Uint8Array.from([IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE]));
    await p;
    expect(String.fromCharCode(...sent)).toContain("IBMSENDCONFREC\x01YES\x03IBMASSOCPRT\x01PRT01\xff\xf0");
  });
});
