import { describe, it, expect } from "vitest";
import { nvtTextToWtd, type NvtCursor } from "../src/telnet/nvt-text.js";
import { TelnetLayer } from "../src/telnet/telnet.js";
import { IAC, CMD, OPT } from "../src/telnet/constants.js";
import { Session5250 } from "../src/session/session.js";
import { FakeTransport } from "./helpers/fake-transport.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **交渉の前に届いたテキスト（NVT）を画面へ書く**（`20260930-telnet-nvt-text`）。期待値の画面・カーソルは、手元の偽のサーバーを ACS のコアに当てて採ったもの
 * （`scripts/acs-probe/nvt-text.txt`・`scripts/verify-nvt-text.mjs` が同じ 9 通りを実物の TCP で当てる）
 */
const bytes = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const WTD = "0411" + "0008"; // ESC 0x11 CC1=0 CC2=解錠
const cur = (pos = 0): NvtCursor => ({ pos });

describe("nvtTextToWtd（ACS `NVT_process_outbound` の書き出し）", () => {
  it("先頭では SBA・空白 1 字・SBA を置いてから書き、最後に IC。桁は 1 字ごとに進む", () => {
    const c = cur();
    expect(hex(nvtTextToWtd(bytes("Hi"), c, 80, 24))).toBe(WTD + "110101" + "40" + "110101" + "c8" + "89" + "130103");
    expect(c.pos).toBe(2);
  });

  it("2 回目以降（位置が先頭でない）は空白を置かず、位置へ SBA", () => {
    const c = cur(2);
    expect(hex(nvtTextToWtd(bytes("!"), c, 80, 24))).toBe(WTD + "110103" + "4f" + "130104"); // `!` は ACS の表で 0x4F
    expect(c.pos).toBe(3);
  });

  it("CR は行頭へ SBA。LF は桁を変えずに 1 行下へ移って、その行を空白で埋める（スクロールしない）", () => {
    const c = cur(85); // (2,6)
    const out = hex(nvtTextToWtd(bytes("\n"), c, 80, 24));
    expect(out).toBe(WTD + "110206" + "110301" + "40".repeat(80) + "110306" + "130306");
    expect(c.pos).toBe(165); // (3,6)
    const c2 = cur(85);
    expect(hex(nvtTextToWtd(bytes("\r"), c2, 80, 24))).toBe(WTD + "110206" + "110201" + "130201");
    expect(c2.pos).toBe(80);
  });

  it("最下行の LF は 1 行目へ回り込む（最下行の次）", () => {
    const c = cur(23 * 80 + 1);
    nvtTextToWtd(bytes("\n"), c, 80, 24);
    expect(c.pos).toBe(1);
  });

  it("ENQ（0x05）は次の 8 桁の境目まで空白。HT（0x09）と制御文字・0x7F 以上・NUL は無視", () => {
    const c = cur(3);
    expect(hex(nvtTextToWtd(bytes("\x05"), c, 80, 24))).toBe(WTD + "110104" + "40".repeat(5) + "130109");
    expect(c.pos).toBe(8);
    const c2 = cur(3);
    expect(hex(nvtTextToWtd(Uint8Array.from([0x09, 0x00, 0x01, 0x1b, 0x7f, 0xc3, 0xa9]), c2, 80, 24))).toBe(WTD + "110104" + "130104");
    expect(c2.pos).toBe(3);
  });

  it("BS は 1 桁戻って SBA。先頭の BS は 1 行目の 0 桁（SBA 1,0）になる（ACS と同じバイト）", () => {
    const c = cur(5);
    expect(hex(nvtTextToWtd(bytes("\b"), c, 80, 24))).toBe(WTD + "110106" + "110105" + "130105");
    const c0 = cur(0);
    expect(hex(nvtTextToWtd(bytes("\b"), c0, 80, 24))).toBe(WTD + "110101" + "40" + "110101" + "110100" + "130100");
  });

  it("画面の終わりを越えたら位置は画面の大きさで折り返す", () => {
    const c = cur(1919);
    nvtTextToWtd(bytes("ab"), c, 80, 24);
    expect(c.pos).toBe(1);
  });
});

describe("TelnetLayer: 交渉の前の通常データはテキストとして渡す", () => {
  function setup() {
    const t = new FakeTransport();
    const telnet = new TelnetLayer(t, { terminalType: "IBM-3179-2" });
    const texts: string[] = [];
    const records: Uint8Array[] = [];
    telnet.onNvtText((x) => texts.push(String.fromCharCode(...x)));
    telnet.onRecord((r) => records.push(r));
    return { t, texts, records };
  }

  it("受信の終わりで渡す（IAC を含まなくても）", () => {
    const { t, texts } = setup();
    t.feed(...[..."Hello\r\n"].map((c) => c.charCodeAt(0)));
    expect(texts).toEqual(["Hello\r\n"]);
  });

  it("IAC のコマンドの手前までを 1 つの塊にする（TERMINAL-TYPE の DO をはさんで 2 つ）", () => {
    const { t, texts } = setup();
    t.feed(0x41, 0x42, IAC, CMD.DO, OPT.TERMINAL_TYPE, 0x43);
    expect(texts).toEqual(["AB", "C"]);
  });

  it("IAC IAC は 0xFF のデータとして塊に入る", () => {
    const { t, texts } = setup();
    t.feed(0x41, IAC, IAC, 0x42);
    expect(texts).toEqual(["A\xffB"]);
  });

  it("EOR か BINARY に応じたあとは 5250 のレコード（テキストにしない）", () => {
    const { t, texts, records } = setup();
    t.feed(IAC, CMD.DO, OPT.EOR);
    t.feed(0x01, 0x02);
    expect(texts).toEqual([]);
    t.feed(IAC, CMD.EOR);
    expect(records.map((r) => [...r])).toEqual([[1, 2]]);
  });

  it("BINARY だけに応じても 5250 のレコード（EOR と別々に効く）", () => {
    const { t, texts, records } = setup();
    t.feed(IAC, CMD.WILL, OPT.BINARY);
    t.feed(0x01, 0x02); // EOR の前の受信の終わりでも、テキストとして渡さずレコードへ溜める
    expect(texts).toEqual([]);
    t.feed(IAC, CMD.EOR);
    expect(records.map((r) => [...r])).toEqual([[1, 2]]);
  });

  it("**IAC EOR で終わる塊は、交渉の前でも 5250 のレコード**（バナーではありえない）", () => {
    const { t, texts, records } = setup();
    t.feed(0x01, 0x02, IAC, CMD.EOR);
    expect(texts).toEqual([]);
    expect(records.map((r) => [...r])).toEqual([[1, 2]]);
  });

  it("応じる前の DO TERMINAL-TYPE などは、テキストの状態を変えない（BINARY・EOR だけが切り替える）", () => {
    const { t, texts } = setup();
    t.feed(IAC, CMD.DO, OPT.TERMINAL_TYPE);
    t.feed(0x58);
    expect(texts).toEqual(["X"]);
  });
});

describe("Session5250: 交渉の前に届いたテキストで接続の待ちが解け、画面に出る", () => {
  it("バナーが画面に出て、キーボードは施錠のまま。あとから 5250 の交渉・起動応答が来ても最初のレコードとして読まれる", async () => {
    const codec = codecForCcsid(37);
    const t = new FakeTransport();
    const p = Session5250.connect({ id: "t", transport: t, negotiationTimeoutMs: 2000, ccsid: 37 });
    await new Promise((r) => setTimeout(r, 20));
    t.feed(...[..."Welcome\r\nLine2"].map((c) => c.charCodeAt(0)));
    const s = await p;
    const snap = s.snapshot();
    expect(snap.cells[0]!.map((c) => c.char).join("").trimEnd()).toBe("Welcome");
    expect(snap.cells[1]!.map((c) => c.char).join("").trimEnd()).toBe("Line2");
    expect(s.keyboardLocked).toBe(true);
    // ゲートウェイの後ろの本物の 5250: 交渉のあとの起動応答（実機と同じ形。`startup-reject.test.ts`）が**最初のレコード**として読まれる
    t.feed(IAC, CMD.DO, OPT.EOR);
    t.feed(IAC, CMD.DO, OPT.BINARY);
    const ebcdic = (x: string, len: number): number[] => [...codec.encode(x.padEnd(len, " ")).bytes].slice(0, len);
    const head = [0x00, 0x00, 0x12, 0xa0, 0x90, 0x00, 0x05, 0x60, 0x06, 0x00, 0x20, 0xc0, 0x00, 0x3d, 0x00, 0x00];
    t.feed(...head, ...ebcdic("I902", 4), ...ebcdic("SYS", 8), ...ebcdic("DEV1", 10), IAC, CMD.EOR);
    expect(s.startup?.code).toBe("I902");
    expect(s.startup?.device).toBe("DEV1");
    s.disconnect();
  });
});
