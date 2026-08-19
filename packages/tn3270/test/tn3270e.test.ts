import { describe, it, expect } from "vitest";
import {
  TN3270E_CMD,
  TN3270E_FUNC,
  TN3270E_REASON,
  DATA_TYPE,
  HEADER_LEN,
  splitHeader,
  withHeader,
  reasonName,
  Tn3270eNegotiator
} from "../src/telnet/tn3270e.js";
import { deviceTypeFor, terminalTypeFor } from "../src/telnet/terminal-type.js";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const str = (b: readonly number[]): string => String.fromCharCode(...b);

describe("コード（RFC 2355 §3 / §7.2.2 / §8.1.1）", () => {
  it("コマンドコード", () => {
    expect(TN3270E_CMD).toMatchObject({
      ASSOCIATE: 0x00, CONNECT: 0x01, DEVICE_TYPE: 0x02, FUNCTIONS: 0x03,
      IS: 0x04, REASON: 0x05, REJECT: 0x06, REQUEST: 0x07, SEND: 0x08
    });
  });

  it("機能コードと理由コード", () => {
    expect(TN3270E_FUNC).toMatchObject({
      BIND_IMAGE: 0x00, DATA_STREAM_CTL: 0x01, RESPONSES: 0x02,
      SCS_CTL_CODES: 0x03, SYSREQ: 0x04
    });
    expect(TN3270E_REASON.INV_DEVICE_TYPE).toBe(0x04);
    expect(reasonName(0x01)).toBe("DEVICE-IN-USE");
    expect(reasonName(0x99)).toMatch(/UNKNOWN/);
  });
});

describe("5 バイトヘッダ（§8.1）", () => {
  it("往復する", () => {
    const payload = Uint8Array.from([0xf5, 0xc3, 0x11, 0x40, 0x40]);
    const rec = withHeader(payload);
    expect(rec.length).toBe(HEADER_LEN + payload.length);
    const split = splitHeader(rec)!;
    expect(split.header.dataType).toBe(DATA_TYPE.DATA_3270);
    expect([...split.body]).toEqual([...payload]);
  });

  it("**基本 TN3270E ではフラグと順序番号を使わないので常に 0**（§9）", () => {
    const rec = withHeader(Uint8Array.from([0x01]));
    expect([...rec.slice(0, HEADER_LEN)]).toEqual([0, 0, 0, 0, 0]);
  });

  it("順序番号は 2 バイトのビッグエンディアンとして読む", () => {
    const rec = Uint8Array.from([DATA_TYPE.DATA_3270, 0x00, 0x00, 0x12, 0x34, 0xaa]);
    expect(splitHeader(rec)!.header.seq).toBe(0x1234);
  });

  it("5 バイト丁度なら本体は空", () => {
    const s = splitHeader(Uint8Array.from([0, 0, 0, 0, 0]))!;
    expect(s.body.length).toBe(0);
  });

  it("**5 バイト未満は null**（例外にしない——読み飛ばすため）", () => {
    expect(splitHeader(Uint8Array.from([0, 0, 0, 0]))).toBeNull();
    expect(splitHeader(Uint8Array.from([]))).toBeNull();
  });

  it("未知の DATA-TYPE もそのまま読める（判断は呼び出し側）", () => {
    const rec = Uint8Array.from([0x7f, 0, 0, 0, 0, 0xc1]);
    expect(splitHeader(rec)!.header.dataType).toBe(0x7f);
  });
});

describe("device-type の型名（§7.1）", () => {
  it("**TN3270E は IBM-3278-*、基本 TN3270 は IBM-3279-***（別物）", () => {
    expect(deviceTypeFor({ model: 2 })).toBe("IBM-3278-2-E");
    expect(terminalTypeFor({ model: 2 })).toBe("IBM-3279-2-E");
    expect(deviceTypeFor({ model: 2 })).not.toBe(terminalTypeFor({ model: 2 }));
  });

  it("モデルと -E の有無を反映する", () => {
    expect(deviceTypeFor({ model: 5 })).toBe("IBM-3278-5-E");
    expect(deviceTypeFor({ model: 3, extended: false })).toBe("IBM-3278-3");
  });

  it("**LU 名は含めない**（TN3270E は CONNECT で渡す）", () => {
    expect(deviceTypeFor({ model: 2 })).not.toContain("@");
  });
});

describe("交渉の状態機械（§7.1 / §7.2）", () => {
  const neg = (o = {}): Tn3270eNegotiator =>
    new Tn3270eNegotiator({ deviceType: "IBM-3278-2-E", ...o });

  it("SEND DEVICE-TYPE に REQUEST で応じる", () => {
    const n = neg();
    const out = n.handle([TN3270E_CMD.SEND, TN3270E_CMD.DEVICE_TYPE])!;
    expect(out[0]).toBe(TN3270E_CMD.DEVICE_TYPE);
    expect(out[1]).toBe(TN3270E_CMD.REQUEST);
    expect(str(out.slice(2))).toBe("IBM-3278-2-E");
    expect(n.state).toBe("device-type");
  });

  it("LU 名を指定すると CONNECT を付ける（§7.1.2）", () => {
    const n = neg({ deviceName: "MYLU01" });
    const out = n.handle([TN3270E_CMD.SEND, TN3270E_CMD.DEVICE_TYPE])!;
    const ci = out.indexOf(TN3270E_CMD.CONNECT);
    expect(ci).toBeGreaterThan(0);
    expect(str(out.slice(2, ci))).toBe("IBM-3278-2-E");
    expect(str(out.slice(ci + 1))).toBe("MYLU01");
  });

  it("LU 名を省略すると CONNECT を送らない", () => {
    const out = neg().handle([TN3270E_CMD.SEND, TN3270E_CMD.DEVICE_TYPE])!;
    expect(out).not.toContain(TN3270E_CMD.CONNECT);
  });

  it("**DEVICE-TYPE IS の後は空の FUNCTIONS を要求する**（基本 TN3270E）", () => {
    const n = neg();
    n.handle([TN3270E_CMD.SEND, TN3270E_CMD.DEVICE_TYPE]);
    const out = n.handle([
      TN3270E_CMD.DEVICE_TYPE, TN3270E_CMD.IS, ...ascii("IBM-3278-2-E"),
      TN3270E_CMD.CONNECT, ...ascii("TERM01")
    ])!;
    expect(out).toEqual([TN3270E_CMD.FUNCTIONS, TN3270E_CMD.REQUEST]); // 空リスト
    expect(n.state).toBe("functions");
    expect(n.deviceName).toBe("TERM01");
  });

  it("FUNCTIONS IS（空）で ready になる", () => {
    const n = neg();
    n.handle([TN3270E_CMD.SEND, TN3270E_CMD.DEVICE_TYPE]);
    n.handle([TN3270E_CMD.DEVICE_TYPE, TN3270E_CMD.IS, ...ascii("IBM-3278-2-E")]);
    expect(n.handle([TN3270E_CMD.FUNCTIONS, TN3270E_CMD.IS])).toBeNull();
    expect(n.state).toBe("ready");
  });

  it("**対案（REQUEST）には空の REQUEST で返す**——IS では返さない（§7.2.1）", () => {
    const n = neg();
    n.handle([TN3270E_CMD.SEND, TN3270E_CMD.DEVICE_TYPE]);
    n.handle([TN3270E_CMD.DEVICE_TYPE, TN3270E_CMD.IS, ...ascii("IBM-3278-2-E")]);
    const out = n.handle([
      TN3270E_CMD.FUNCTIONS, TN3270E_CMD.REQUEST, TN3270E_FUNC.RESPONSES, TN3270E_FUNC.SYSREQ
    ])!;
    expect(out).toEqual([TN3270E_CMD.FUNCTIONS, TN3270E_CMD.REQUEST]);
    expect(n.state).toBe("functions"); // まだ確定していない
  });

  it("相手も空を提案してきたら IS で確定する", () => {
    const n = neg();
    n.handle([TN3270E_CMD.SEND, TN3270E_CMD.DEVICE_TYPE]);
    n.handle([TN3270E_CMD.DEVICE_TYPE, TN3270E_CMD.IS, ...ascii("IBM-3278-2-E")]);
    const out = n.handle([TN3270E_CMD.FUNCTIONS, TN3270E_CMD.REQUEST])!;
    expect(out).toEqual([TN3270E_CMD.FUNCTIONS, TN3270E_CMD.IS]);
    expect(n.state).toBe("ready");
  });

  it("**往復が収束しなければ打ち切る**（impasse。無限ループを構造的に防ぐ）", () => {
    const n = neg({ maxFunctionRounds: 3 });
    n.handle([TN3270E_CMD.SEND, TN3270E_CMD.DEVICE_TYPE]);
    n.handle([TN3270E_CMD.DEVICE_TYPE, TN3270E_CMD.IS, ...ascii("IBM-3278-2-E")]);
    const counter = [TN3270E_CMD.FUNCTIONS, TN3270E_CMD.REQUEST, TN3270E_FUNC.RESPONSES];
    for (let i = 0; i < 3; i++) expect(n.handle(counter)).not.toBeNull();
    expect(n.handle(counter)).toBeNull();
    expect(n.state).toBe("failed");
    expect(n.error).toMatch(/did not converge/);
  });

  it("REJECT は理由付きで失敗する（§7.1.5）", () => {
    const n = neg({ deviceName: "TAKEN" });
    n.handle([TN3270E_CMD.SEND, TN3270E_CMD.DEVICE_TYPE]);
    expect(n.handle([
      TN3270E_CMD.DEVICE_TYPE, TN3270E_CMD.REJECT, TN3270E_CMD.REASON, TN3270E_REASON.DEVICE_IN_USE
    ])).toBeNull();
    expect(n.state).toBe("rejected");
    expect(n.reason).toEqual({ code: 0x01, name: "DEVICE-IN-USE" });
    expect(n.error).toMatch(/DEVICE-IN-USE/);
  });

  it("要求していない機能を IS されたら失敗にする", () => {
    const n = neg();
    n.handle([TN3270E_CMD.SEND, TN3270E_CMD.DEVICE_TYPE]);
    n.handle([TN3270E_CMD.DEVICE_TYPE, TN3270E_CMD.IS, ...ascii("IBM-3278-2-E")]);
    expect(n.handle([TN3270E_CMD.FUNCTIONS, TN3270E_CMD.IS, TN3270E_FUNC.RESPONSES])).toBeNull();
    expect(n.state).toBe("failed");
  });

  it("サーバが違う型名を返しても受理する（§7.1.4）", () => {
    const n = neg();
    n.handle([TN3270E_CMD.SEND, TN3270E_CMD.DEVICE_TYPE]);
    n.handle([TN3270E_CMD.DEVICE_TYPE, TN3270E_CMD.IS, ...ascii("IBM-3278-4-E")]);
    expect(n.state).toBe("functions");
  });

  it("知らないコマンドでは何も返さない（落とさない）", () => {
    expect(neg().handle([0x7f, 0x00])).toBeNull();
  });
});
