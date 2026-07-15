import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { parseWdsf, WDSF_TYPE } from "../src/protocol/wdsf-parser.js";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";

const codec = codecForCcsid(37);

function e(text: string): number[] {
  return [...codec.encode(text).bytes];
}

/** WDSF 構造体（class 0xD9 + type + body）を WTD オーダーとして包む */
function wdsf(type: number, body: number[]): number[] {
  const sf = [0xd9, type, ...body];
  const ll = sf.length + 2; // LL は自身 2 バイトを含む
  return [ORDER.WDSF, (ll >> 8) & 0xff, ll & 0xff, ...sf];
}

/** SBA(row,col) → WDSF... を含む WTD レコードを組み立て適用 */
function applyGui(orders: number[], size?: "27x132"): { buf: ScreenBuffer; warns: string[] } {
  const buf = new ScreenBuffer(size ? { alternate: "27x132" } : {});
  if (size) buf.clearUnitAlternate();
  const warns: string[] = [];
  const record = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ...orders];
  applyDataStream(Uint8Array.from(record), buf, codec, (m) => warns.push(m));
  return { buf, warns };
}

function sba(row: number, col: number): number[] {
  return [ORDER.SBA, row, col];
}

describe("WDSF GUI — CREATE WINDOW (0x51)", () => {
  it("位置・サイズ・タイトルを解析し snapshot.gui に載せる", () => {
    // fb1=0, 予約2, depth=5, width=20, border(title="HI")
    const border = [0x08, 0x10, 0x00, 0x00, 0x00, 0x00, ...e("HI")];
    const body = [0x00, 0x00, 0x00, 0x05, 0x14, ...border];
    const { buf, warns } = applyGui([...sba(5, 10), ...wdsf(WDSF_TYPE.CREATE_WINDOW, body)]);
    expect(warns).toEqual([]);
    const snap = buf.snapshot("t", false);
    expect(snap.gui?.windows).toHaveLength(1);
    const w = snap.gui!.windows[0]!;
    expect(w).toMatchObject({ row: 5, col: 10, width: 20, height: 5, title: "HI" });
  });

  it("境界なしウィンドウも解析できる", () => {
    const body = [0x00, 0x00, 0x00, 0x03, 0x0a];
    const { buf } = applyGui([...sba(2, 2), ...wdsf(WDSF_TYPE.CREATE_WINDOW, body)]);
    const w = buf.snapshot("t", false).gui!.windows[0]!;
    expect(w).toMatchObject({ row: 2, col: 2, width: 10, height: 3 });
    expect(w.title).toBeUndefined();
  });

  it("restrict/pulldown フラグを反映する", () => {
    const body = [0xc0, 0x00, 0x00, 0x03, 0x0a]; // 0x80 restrict + 0x40 pulldown
    const { buf } = applyGui([...sba(2, 2), ...wdsf(WDSF_TYPE.CREATE_WINDOW, body)]);
    const w = buf.snapshot("t", false).gui!.windows[0]!;
    expect(w.restrictCursor).toBe(true);
    expect(w.pulldown).toBe(true);
  });
});

describe("WDSF GUI — DEFINE SELECTION FIELD (0x50)", () => {
  function selectionBody(fieldType: number, choices: { text: string; fb1: number }[]): number[] {
    const header = [
      0x00, 0x00, 0x00, // fb1,fb2,fb3
      fieldType,
      0x00, 0x00, 0x00, 0x00, 0x00, // 5 予約
      0x03, // itemsize
      0x01, // height
      choices.length, // items
      0x00, 0x00, 0x00, 0x00 // padding, separator, selectionchar, cancelaid
    ];
    const minors: number[] = [];
    for (const c of choices) {
      const content = [c.fb1, 0x00, 0x80, ...e(c.text)]; // fb1, fb2, fb3(GUI), text
      minors.push(content.length + 2, 0x10, ...content);
    }
    return [...header, ...minors];
  }

  it("単一選択フィールドをラジオとして解析（既定選択を反映）", () => {
    const body = selectionBody(0x11, [
      { text: "YES", fb1: 0x40 }, // 既定選択
      { text: "NO", fb1: 0x00 }
    ]);
    const { buf, warns } = applyGui([...sba(6, 4), ...wdsf(WDSF_TYPE.DEFINE_SELECTION_FIELD, body)]);
    expect(warns).toEqual([]);
    const f = buf.snapshot("t", false).gui!.selectionFields[0]!;
    expect(f).toMatchObject({ row: 6, col: 4, kind: "radio", multiple: false, fieldType: 0x11 });
    expect(f.choices.map((c) => c.text)).toEqual(["YES", "NO"]);
    expect(f.choices[0]).toMatchObject({ index: 1, selected: true, available: true });
    expect(f.choices[1]).toMatchObject({ index: 2, selected: false, available: true });
  });

  it("複数選択フィールドをチェックボックスとして解析", () => {
    const body = selectionBody(0x12, [{ text: "A", fb1: 0x00 }]);
    const { buf } = applyGui([...sba(1, 1), ...wdsf(WDSF_TYPE.DEFINE_SELECTION_FIELD, body)]);
    const f = buf.snapshot("t", false).gui!.selectionFields[0]!;
    expect(f.kind).toBe("checkbox");
    expect(f.multiple).toBe(true);
  });

  it("プッシュボタン（0x41）を解析", () => {
    const body = selectionBody(0x41, [{ text: "OK", fb1: 0x00 }]);
    const { buf } = applyGui([...sba(1, 1), ...wdsf(WDSF_TYPE.DEFINE_SELECTION_FIELD, body)]);
    expect(buf.snapshot("t", false).gui!.selectionFields[0]!.kind).toBe("pushbutton");
  });

  it("選択不可（0x80）を available=false に", () => {
    const body = selectionBody(0x11, [{ text: "X", fb1: 0x80 }]);
    const { buf } = applyGui([...sba(1, 1), ...wdsf(WDSF_TYPE.DEFINE_SELECTION_FIELD, body)]);
    expect(buf.snapshot("t", false).gui!.selectionFields[0]!.choices[0]!.available).toBe(false);
  });

  it("AID 付き選択肢の AID を抽出（fb1 bit 0x04）", () => {
    // fb1: 0x40(選択) | 0x04(AID incl)。content: fb1,fb2,fb3, aid, text
    const content = [0x44, 0x00, 0x80, 0x33 /* F3 */, ...e("GO")];
    const header = [0, 0, 0, 0x41, 0, 0, 0, 0, 0, 3, 1, 1, 0, 0, 0, 0];
    const body = [...header, content.length + 2, 0x10, ...content];
    const { buf } = applyGui([...sba(1, 1), ...wdsf(WDSF_TYPE.DEFINE_SELECTION_FIELD, body)]);
    const c = buf.snapshot("t", false).gui!.selectionFields[0]!.choices[0]!;
    expect(c.aid).toBe(0x33);
    expect(c.text).toBe("GO");
  });
});

describe("WDSF GUI — DEFINE SCROLL BAR FIELD (0x53)", () => {
  it("方向・総数・つまみ位置・サイズを解析", () => {
    // 垂直, 予約, total=100, slider=10, size=5
    const body = [0x00, 0x00, 0, 1, 0, 0, 0, 0, 1, 0, 0x05];
    const { buf, warns } = applyGui([...sba(3, 7), ...wdsf(WDSF_TYPE.DEFINE_SCROLL_BAR_FIELD, body)]);
    expect(warns).toEqual([]);
    const s = buf.snapshot("t", false).gui!.scrollBars[0]!;
    expect(s).toMatchObject({ row: 3, col: 7, horizontal: false, total: 100, sliderPos: 10, size: 5 });
  });

  it("水平フラグ（0x80）を反映", () => {
    const body = [0x80, 0x00, 0, 0, 0, 5, 0, 0, 0, 1, 0x02];
    const { buf } = applyGui([...sba(1, 1), ...wdsf(WDSF_TYPE.DEFINE_SCROLL_BAR_FIELD, body)]);
    expect(buf.snapshot("t", false).gui!.scrollBars[0]!.horizontal).toBe(true);
  });
});

describe("WDSF GUI — 除去コマンド", () => {
  function withOne(): ScreenBuffer {
    const body = [0x00, 0x00, 0x00, 0x03, 0x0a];
    const { buf } = applyGui([...sba(2, 2), ...wdsf(WDSF_TYPE.CREATE_WINDOW, body)]);
    return buf;
  }

  it("REM_GUI_WINDOW で位置一致のウィンドウを除去", () => {
    const buf = withOne();
    expect(buf.snapshot("t", false).gui?.windows).toHaveLength(1);
    applyDataStream(
      Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0, 0, ...sba(2, 2), ...wdsf(WDSF_TYPE.REM_GUI_WINDOW, [0x00, 0x00, 0x00])]),
      buf,
      codec,
      () => {}
    );
    expect(buf.snapshot("t", false).gui).toBeUndefined();
  });

  it("REM_ALL_GUI_CONSTRUCTS で全 GUI を除去", () => {
    const buf = withOne();
    applyDataStream(
      Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0, 0, ...wdsf(WDSF_TYPE.REM_ALL_GUI_CONSTRUCTS, [0x00])]),
      buf,
      codec,
      () => {}
    );
    expect(buf.snapshot("t", false).gui).toBeUndefined();
  });

  it("CLEAR UNIT で GUI がクリアされる", () => {
    const buf = withOne();
    applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT]), buf, codec, () => {});
    expect(buf.snapshot("t", false).gui).toBeUndefined();
  });
});

describe("WDSF GUI — 堅牢性", () => {
  it("未知の WDSF type は警告して読み飛ばす", () => {
    const { buf, warns } = applyGui([...sba(1, 1), ...wdsf(0x52 /* UNREST_WIN_CURS_MOVE */, [0x00, 0x00])]);
    expect(buf.snapshot("t", false).gui).toBeUndefined();
    expect(warns.some((w) => w.includes("0x52"))).toBe(true);
  });

  it("破損 WDSF 長は警告して残りを打ち切る", () => {
    // LL がバッファ超過
    const { warns } = applyGui([...sba(1, 1), ORDER.WDSF, 0xff, 0xff, 0xd9, 0x51]);
    expect(warns.some((w) => w.includes("WDSF length"))).toBe(true);
  });

  it("parseWdsf は class≠0xD9 を unknown に", () => {
    const ev = parseWdsf(Uint8Array.from([0x00, 0x51]), (b) => b);
    expect(ev.kind).toBe("unknown");
  });
});

describe("ScreenBuffer — GUI 選択状態", () => {
  function buildRadio(): ScreenBuffer {
    const codecX = codec;
    const enc = (t: string) => [...codecX.encode(t).bytes];
    const header = [0, 0, 0, 0x11, 0, 0, 0, 0, 0, 3, 1, 2, 0, 0, 0, 0];
    const c1 = [0x40, 0x00, 0x80, ...enc("YES")];
    const c2 = [0x00, 0x00, 0x80, ...enc("NO")];
    const body = [...header, c1.length + 2, 0x10, ...c1, c2.length + 2, 0x10, ...c2];
    const { buf } = applyGui([...sba(6, 4), ...wdsf(WDSF_TYPE.DEFINE_SELECTION_FIELD, body)]);
    return buf;
  }

  it("単一選択は他を解除して排他選択", () => {
    const buf = buildRadio();
    const id = buf.snapshot("t", false).gui!.selectionFields[0]!.id;
    expect(buf.setSelectionChoice(id, 2, true)).toBe(true);
    const f = buf.snapshot("t", false).gui!.selectionFields[0]!;
    expect(f.choices[0]!.selected).toBe(false);
    expect(f.choices[1]!.selected).toBe(true);
  });

  it("選択不可の選択肢は変更できない", () => {
    const body = [0, 0, 0, 0x11, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 5, 0x10, 0x80, 0x00, 0x80, ...e("X")];
    const { buf } = applyGui([...sba(1, 1), ...wdsf(WDSF_TYPE.DEFINE_SELECTION_FIELD, body)]);
    const id = buf.snapshot("t", false).gui!.selectionFields[0]!.id;
    expect(buf.setSelectionChoice(id, 1, true)).toBe(false);
  });
});
