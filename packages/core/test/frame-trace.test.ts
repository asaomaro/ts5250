import { describe, it, expect } from "vitest";
import { formatFrame, traceFrame } from "../src/hostserver/frame-trace.js";
import { buildRequest, CP, HEADER_LEN } from "../src/hostserver/datastream.js";
import type { CoreLogger } from "../src/log.js";

/**
 * フレームトレース。
 *
 * **診断のために入れた機能が漏洩経路にならない**ことが最重要なので、
 * マスクは実機の目視だけに頼らず型で固める。
 */
function frameWith(params: { cp: number; value: Uint8Array }[]): Uint8Array {
  return buildRequest({
    serverId: 0xe004,
    reqRep: 0x7004,
    template: new Uint8Array(0),
    params
  });
}

const bytes = (...v: number[]) => Uint8Array.from(v);

describe("formatFrame", () => {
  it("CP とヘッダーの要点を 1 行に出す", () => {
    const s = formatFrame("send", frameWith([{ cp: CP.userId, value: bytes(0xc1, 0xc2) }]));
    expect(s).toMatch(/^send len=\d+ reqrep=0x7004 /);
    expect(s).toContain("0x1104=c1c2");
  });

  it("**パスワード置換値（0x1105）を必ず伏せる**", () => {
    const secret = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
    const s = formatFrame("send", frameWith([{ cp: CP.password, value: secret }]));
    expect(s).toContain("0x1105=<masked 20 bytes>");
    // 生の値が 1 バイトも出ていないこと
    expect(s).not.toMatch(/0102030405/);
  });

  it("他の CP と混在してもパスワードだけ伏せる", () => {
    const s = formatFrame(
      "send",
      frameWith([
        { cp: CP.userId, value: bytes(0xc1) },
        { cp: CP.password, value: bytes(0xde, 0xad, 0xbe, 0xef) },
        { cp: CP.clientCcsid, value: bytes(0x04, 0xb0) }
      ])
    );
    expect(s).toContain("0x1104=c1");
    expect(s).toContain("0x1105=<masked 4 bytes>");
    expect(s).toContain("0x1113=04b0");
    expect(s).not.toContain("deadbeef");
  });

  it("長い値を切り、**切ったことを明示する**", () => {
    const long = new Uint8Array(100).fill(0xab);
    const s = formatFrame("recv", frameWith([{ cp: CP.jobName, value: long }]), {
      maxValueBytes: 8
    });
    expect(s).toContain("abababababababab…(+92 bytes)");
  });

  it("上限ちょうどは切らない", () => {
    const v = new Uint8Array(8).fill(0x11);
    const s = formatFrame("recv", frameWith([{ cp: CP.jobName, value: v }]), { maxValueBytes: 8 });
    expect(s).toContain("0x111f=1111111111111111");
    expect(s).not.toContain("…");
  });

  it("短すぎるフレームでも例外にしない（トレースは副次機能）", () => {
    expect(formatFrame("recv", new Uint8Array(3))).toBe("recv len=3 (too short to parse)");
  });

  it("パラメータが無くても壊れない", () => {
    expect(() => formatFrame("send", frameWith([]))).not.toThrow();
  });

  it("壊れた LL でも例外にせず、読めたところまで出す", () => {
    const f = frameWith([{ cp: CP.userId, value: bytes(0xc1) }]);
    // パラメータの LL を巨大な値に壊す
    const view = new DataView(f.buffer, f.byteOffset, f.byteLength);
    const paramStart = HEADER_LEN + view.getUint16(16);
    view.setUint32(paramStart, 0xffff);
    expect(() => formatFrame("recv", f)).not.toThrow();
  });
});

describe("traceFrame", () => {
  function fakeLog(enabled: boolean): { log: CoreLogger; lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      log: {
        debug: (m) => lines.push(m),
        info: () => {},
        warn: () => {},
        error: () => {},
        isDebugEnabled: () => enabled
      }
    };
  }

  it("debug が無効なら**整形もしない**", () => {
    const { log, lines } = fakeLog(false);
    traceFrame(log, "send", frameWith([{ cp: CP.userId, value: bytes(0xc1) }]));
    expect(lines).toEqual([]);
  });

  it("debug が有効なら 1 行出す", () => {
    const { log, lines } = fakeLog(true);
    traceFrame(log, "send", frameWith([{ cp: CP.userId, value: bytes(0xc1) }]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("0x1104=c1");
  });
});

describe("正体不明の CP 0x111A", () => {
  it("**分からないものは伏せる側に倒す**（signon 応答の 20 バイト）", () => {
    const token = new Uint8Array(20).fill(0x7f);
    const s = formatFrame("recv", frameWith([{ cp: 0x111a, value: token }]));
    expect(s).toContain("0x111a=<masked 20 bytes>");
    expect(s).not.toContain("7f7f7f");
  });
});
