import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
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

/** DEFINE SELECTION FIELD の本体（選択肢の fb1 で既定の選択） */
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
    expect(w).toMatchObject({ row: 5, col: 10, width: 20, height: 5 });
    // 見出しは寄せ方・色つきの構造で載る（枠の辺に描くため位置と色が要る）
    expect(w.title).toMatchObject({ text: "HI", align: "center", footer: false });
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
    // 垂直, 予約, total=300（0x0000012C）, slider=10, size=5。**総数・位置は 32 ビットの 2 進**（ACS `ENPTUIScrollBarField`。~~10 進 4 桁~~）
    const body = [0x00, 0x00, 0x00, 0x00, 0x01, 0x2c, 0x00, 0x00, 0x00, 0x0a, 0x05];
    const { buf, warns } = applyGui([...sba(3, 7), ...wdsf(WDSF_TYPE.DEFINE_SCROLL_BAR_FIELD, body)]);
    expect(warns).toEqual([]);
    const s = buf.snapshot("t", false).gui!.scrollBars[0]!;
    expect(s).toMatchObject({ row: 3, col: 7, horizontal: false, total: 300, sliderPos: 10, size: 5 });
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
      Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0, 0, ...wdsf(WDSF_TYPE.REM_ALL_GUI_CONSTRUCTS, [0x00, 0x00, 0x00]) /* LL 7（ACS は 7 以外を否定応答） */]),
      buf,
      codec,
      () => {}
    );
    expect(buf.snapshot("t", false).gui).toBeUndefined();
  });

  /**
   * **CLEAR UNIT は GUI 構造体も消す（CLEAR UNIT ALTERNATE とは違う）。**
   *
   * 実機（PB1000R）のトレースで、CREATE WINDOW の窓を閉じて呼び出し元へ戻るとき、
   * REM_GUI_WINDOW 等を送らず素の CLEAR UNIT だけで窓を暗黙に消していることを確認した。
   * 一方 CLEAR UNIT ALTERNATE は SFLCTL の再描画で何度も送られてくるが GUI は消さない
   * （YB0270R の KSN20 罫線のテスト、wdsf-applier-grid-lines.test.ts 参照）。
   * 同じ「画面クリア」でもコマンドの種類（0x40 と 0x20）で GUI への影響が違う。
   */
  it("CLEAR UNIT で GUI がクリアされる", () => {
    const buf = withOne();
    applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT]), buf, codec, () => {});
    expect(buf.snapshot("t", false).gui).toBeUndefined();
  });
});

describe("WDSF GUI — 堅牢性", () => {
  // ~~0x52 で試していた~~——0x52 は `20260928-window-unrestrict` で効かせるようにした。当 PJ が効かせない型の例を 0x54 にした
  it("当 PJ が効かせない WDSF type は警告して読み飛ばす", () => {
    // ~~0x54~~ は `20260928-wdsf-write-data` で効かせた（下の「WRITE DATA」）。残りは 0x55（マウス・ボタン）
    const { buf, warns } = applyGui([...sba(1, 1), ...wdsf(0x55 /* PROGRAMMABLE MOUSE BUTTONS */, [0x00, 0x00, 0x00, 0x00])]);
    expect(buf.snapshot("t", false).gui).toBeUndefined();
    expect(warns.some((w) => w.includes("0x55"))).toBe(true);
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

/**
 * **CLEAR FORMAT TABLE・SOH での ENPTUI の構造体**（ACS `processClearFMT` → `FFT5250.clearFFT` → `ENPTUI5250.clearENPTUIConstructs`。`20260927-ds5250-clear`）:
 * CFT は窓・選択欄・スクロール・バーのすべてを捨て、SOH は窓だけ残して選択欄・スクロール・バーを捨てる（`clearFFT(false)`）
 */
describe("CFT・SOH での ENPTUI の構造体", () => {
  const win = () => [...sba(5, 10), ...wdsf(WDSF_TYPE.CREATE_WINDOW, [0x00, 0x00, 0x00, 0x05, 0x14, 0x08, 0x10, 0x00, 0x00, 0x00, 0x00, ...e("HI")])];
  const sel = () => [...sba(6, 4), ...wdsf(WDSF_TYPE.DEFINE_SELECTION_FIELD, selectionBody(0x11, [{ text: "YES", fb1: 0x40 }, { text: "NO", fb1: 0x00 }]))];
  const soh = [ORDER.SOH, 0x03, 0x00, 0x00, 0x00];
  const gui = (buf: ScreenBuffer) => buf.snapshot("t", false).gui;

  it("**SOH の後に同じ選択欄を定義し直しても二重にならない**・窓は残る", () => {
    const { buf } = applyGui([...win(), ...sel()]);
    applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ...soh, ...sel()]), buf, codec, () => {});
    expect(gui(buf)?.selectionFields ?? []).toHaveLength(1);
    expect(gui(buf)?.windows ?? []).toHaveLength(1);
  });

  it("**CLEAR FORMAT TABLE は窓も選択欄も捨てる**", () => {
    const { buf } = applyGui([...win(), ...sel()]);
    applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_FORMAT_TABLE]), buf, codec, () => {});
    expect(gui(buf)?.windows ?? []).toHaveLength(0);
    expect(gui(buf)?.selectionFields ?? []).toHaveLength(0);
  });
});

/**
 * **WDSF の中身の読み方を ACS に合わせる**（`20260928-wdsf-behaviour`）。実機の ACS のコア（DSM の WDSFBEH・`scripts/acs-probe/wdsf-behaviour.txt`）で測った 4 巡
 */
describe("WDSF の読み方（ACS の実測）", () => {
  /** 単一選択（0x11）のヘッダ 16 バイト（flag2・型・項目幅 5・行・数） */
  const selHead = (flag2: number, type: number, rows: number, items: number): number[] =>
    [0x00, flag2, 0x00, type, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, rows, items, 0x00, 0x00, 0x00, 0x00];
  const choice = (flag3: number, ch: number): number[] => [0x08, 0x10, 0x00, 0x00, flag3, ch, ch, ch];

  it("W1: flag3 に 0x80 の無い選択肢は無い（ACS は捨てる）", () => {
    const { buf } = applyGui([...sba(5, 10), ...wdsf(WDSF_TYPE.DEFINE_SELECTION_FIELD, [...selHead(0x00, 0x11, 3, 3), ...choice(0x80, 0xc1), ...choice(0x40, 0xc2), ...choice(0x80, 0xc3)])]);
    expect(buf.snapshot("t", false).gui!.selectionFields[0]!.choices.map((c) => c.text)).toEqual(["AAA", "CCC"]);
  });

  it("W2: スクロール・バー付き（flag2 0x80）は 8 バイト（総数・位置）の後ろから選択肢", () => {
    const { buf } = applyGui([...sba(5, 10), ...wdsf(WDSF_TYPE.DEFINE_SELECTION_FIELD, [...selHead(0x80, 0x21, 2, 2), 0x00, 0x00, 0x01, 0x2c, 0x00, 0x00, 0x00, 0x10, ...choice(0x80, 0xc4), ...choice(0x80, 0xc5)])]);
    expect(buf.snapshot("t", false).gui!.selectionFields[0]!.choices.map((c) => c.text)).toEqual(["DDD", "EEE"]);
  });

  /** (5,10) の普通の窓（深さ 6・幅 30）と、その中の (7,14) の選択欄 */
  const winWithSel = [
    ...sba(5, 10), ...wdsf(WDSF_TYPE.CREATE_WINDOW, [0x80, 0x00, 0x00, 0x06, 0x1e]),
    ...sba(7, 14), ...wdsf(WDSF_TYPE.DEFINE_SELECTION_FIELD, [...selHead(0x00, 0x11, 1, 1), ...choice(0x80, 0xc6)])
  ];
  it("W3: 普通の窓にフラグ 0x40（引き下げの窓）の 0x59 は何も外さない。0x80 などほかの値も", () => {
    for (const flag of [0x40, 0x80]) {
      const { buf } = applyGui([...winWithSel, ...sba(5, 10), ...wdsf(WDSF_TYPE.REM_GUI_WINDOW, [flag, 0x00, 0x00])]);
      const gui = buf.snapshot("t", false).gui!;
      expect(gui.windows).toHaveLength(1);
      expect(gui.selectionFields).toHaveLength(1);
    }
  });

  it("W4: フラグ 0x00 の 0x59 は窓と、窓の中の選択欄を外す", () => {
    const { buf } = applyGui([...winWithSel, ...sba(5, 10), ...wdsf(WDSF_TYPE.REM_GUI_WINDOW, [0x00, 0x00, 0x00])]);
    expect(buf.snapshot("t", false).gui).toBeUndefined();
  });

  it("位置の一致しない 0x58・0x59 は何も外さない（~~一致が無ければ全除去~~）", () => {
    const { buf } = applyGui([...winWithSel, ...sba(9, 9), ...wdsf(WDSF_TYPE.REM_GUI_SEL_FIELD, [0x00, 0x00]), ...sba(9, 9), ...wdsf(WDSF_TYPE.REM_GUI_WINDOW, [0x00, 0x00, 0x00])]);
    const gui = buf.snapshot("t", false).gui!;
    expect(gui.windows).toHaveLength(1);
    expect(gui.selectionFields).toHaveLength(1);
  });
});

/**
 * **WRITE DATA（WDSF 0x54）の EBCDIC の形**（`20260928-wdsf-write-data`）。実機の ACS のコア（DSM の WRITEDATA・`scripts/acs-probe/write-data.txt`）の 4 巡
 */
describe("WRITE DATA（0x54）", () => {
  const e = (s: string): number[] => [...s].map((c) => ({ A: 0xc1, B: 0xc2, C: 0xc3, D: 0xc4, E: 0xc5, F: 0xc6, G: 0xc7, H: 0xc8, I: 0xc9, J: 0xd1, K: 0xd2, L: 0xd3, N: 0xd5, O: 0xd6, U: 0xe4, V: 0xe5, W: 0xe6, Z: 0xe9, "1": 0xf1, "2": 0xf2 })[c]!);
  /** (5,10) 10 桁の欄（初期値 OLDVALUE12）と、(7,10)・(8,10)・(9,10) 4 桁ずつの継続欄 */
  const screen = [
    ...sba(5, 9), ORDER.SF, 0x40, 0x00, 0x20, 0x00, 0x0a, ...e("OLDVALUE12"),
    ...sba(7, 9), ORDER.SF, 0x40, 0x00, 0x86, 0x01, 0x20, 0x00, 0x04,
    ...sba(8, 9), ORDER.SF, 0x40, 0x00, 0x86, 0x03, 0x20, 0x00, 0x04,
    ...sba(9, 9), ORDER.SF, 0x40, 0x00, 0x86, 0x02, 0x20, 0x00, 0x04
  ];
  const text = (buf: ScreenBuffer, row: number, from: number, n: number): string => buf.snapshot("t", false).cells[row - 1]!.slice(from - 1, from - 1 + n).map((c) => c.char || " ").join("");
  const apply = (orders: number[]) => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ...orders]), buf, codecForCcsid(37), () => {});
    return { buf, r };
  };

  it("D1: 欄を消して先頭から書き、番地は書いたぶん進む（`NEW` の後の `Z`）。MDT は立てない", () => {
    const { buf, r } = apply([...screen, ...sba(5, 10), ...wdsf(0x54, [0x80, 0x00, ...e("NEW")]), ...e("Z")]);
    expect(r.senseCode).toBeUndefined();
    expect(text(buf, 5, 10, 10)).toBe("NEWZ      ");
    expect(buf.orderedFields()[0]!.mdt).toBe(false);
  });
  it("D2・D3: 欄の先頭でない番地は 0x10050140、欄より長いデータは 0x10050141", () => {
    expect(apply([...screen, ...sba(5, 11), ...wdsf(0x54, [0x80, 0x00, ...e("NEW")])]).r.senseCode).toBe(0x10050140);
    expect(apply([...screen, ...sba(5, 10), ...wdsf(0x54, [0x80, 0x00, ...e("ABCDEFGHIJK")])]).r.senseCode).toBe(0x10050141);
  });
  it("D4: 継続欄は区間の長さで割って書く", () => {
    const { buf } = apply([...screen, ...sba(7, 10), ...wdsf(0x54, [0x80, 0x00, ...e("ABCDEFGHIJ")])]);
    expect([text(buf, 7, 10, 4), text(buf, 8, 10, 4), text(buf, 9, 10, 4)]).toEqual(["ABCD", "EFGH", "IJ  "]);
  });
  it("形の分からない flag（0x80・0x40 のどちらも無い）は 0x10050140", () => {
    expect(apply([...screen, ...sba(5, 10), ...wdsf(0x54, [0x00, 0x00, ...e("NEW")])]).r.senseCode).toBe(0x10050140);
  });
});
