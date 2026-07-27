import { describe, it, expect } from "vitest";
import { parseWdsf, WDSF_TYPE, GRID_MINOR, GRID_LINE_STYLE } from "../src/protocol/wdsf-parser.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@as400web/ebcdic";

const codec = codecForCcsid(37);
/** wdsf-parser の Decode は「バイト 1 個 → コードポイント」 */
const decode = (b: number): number => codec.decodeByte(b);

/**
 * **DDS の GRDATR/GRDLIN（グリッド罫線）と WDWBORDER（窓枠）**。
 *
 * どちらも 5250 データストリーム上は WDSF（class 0xD9）で来るが、本 PJ は
 * 0x60/0x61 を未定義のまま `unknown` に落として中身ごと捨て、CREATE WINDOW の
 * Border Presentation（minor 0x01）も読み捨てていた（実機環境からの調査報告 dspf-report）。
 *
 * ワイヤ構造は Wireshark の 5250 ディセクタ（`epan/dissectors/packet-tn5250.c` の
 * `dissect_draw_erase_gridlines` / `dissect_create_window`）を直読して確定した。
 * tn5250（C 版）は "Unhandled WDSF" とログに出すだけで**実装していない**ため参照元にできない。
 */

/** `parseWdsf` は class(0xD9)+type を先頭に含む構造化フィールド全体を受け取る */
function wrap(type: number, body: number[]): Uint8Array {
  return Uint8Array.from([0xd9, type, ...body]);
}

/** グリッド線の主構造 7 バイト＋マイナー構造の並び */
function gridBody(
  opts: { clearBuffer?: boolean; defaultColor?: number; defaultLine?: number },
  items: number[][]
): number[] {
  return [
    0x00, // partition
    opts.clearBuffer === true ? 0x80 : 0x00, // flag1 bit0
    0x00, // 予約
    0x00, // flag2
    0x00, // 予約
    opts.defaultColor ?? 0x20,
    opts.defaultLine ?? GRID_LINE_STYLE.SOLID,
    ...items.flat()
  ];
}

/** マイナー構造 1 件（10 バイト） */
function item(
  minorType: number,
  o: Partial<{ erase: boolean; row: number; col: number; w: number; h: number; color: number; rep: number; interval: number }> = {}
): number[] {
  return [
    10, // length
    minorType,
    o.erase === true ? 0x80 : 0x00, // ms_flag1 bit0 = 消去
    o.row ?? 5,
    o.col ?? 10,
    o.w ?? 20,
    o.h ?? 6,
    o.color ?? 0x00,
    o.rep ?? 0,
    o.interval ?? 0
  ];
}

const parseGrid = (body: number[]): ReturnType<typeof parseWdsf> =>
  parseWdsf(wrap(WDSF_TYPE.DRAW_ERASE_GRID_LINES, body), decode);

describe("DRAW/ERASE GRID LINES（0x60）", () => {
  it("主構造とマイナー構造を読む", () => {
    const ev = parseGrid(gridBody({ defaultLine: GRID_LINE_STYLE.DOUBLE }, [
      item(GRID_MINOR.HV_RULED_BOX, { row: 3, col: 5, w: 40, h: 10, rep: 4, interval: 2 })
    ]));
    expect(ev.kind).toBe("grid-lines");
    if (ev.kind !== "grid-lines") return;
    expect(ev.grid.defaultLine).toBe(GRID_LINE_STYLE.DOUBLE);
    expect(ev.grid.clearBuffer).toBe(false);
    expect(ev.grid.items).toHaveLength(1);
    expect(ev.grid.items[0]).toMatchObject({
      minorType: GRID_MINOR.HV_RULED_BOX, erase: false,
      row: 3, col: 5, width: 40, height: 10, lineRepeat: 4, lineInterval: 2
    });
  });

  it("ms_flag1 bit0 で消去を表す", () => {
    const ev = parseGrid(gridBody({}, [item(GRID_MINOR.PLAIN_BOX, { erase: true })]));
    if (ev.kind !== "grid-lines") throw new Error("kind");
    expect(ev.grid.items[0]!.erase).toBe(true);
  });

  it("主構造 flag1 bit0 でバッファクリアを表す", () => {
    const ev = parseGrid(gridBody({ clearBuffer: true }, []));
    if (ev.kind !== "grid-lines") throw new Error("kind");
    expect(ev.grid.clearBuffer).toBe(true);
  });

  it("8 種のマイナー構造をすべて読む", () => {
    const all = Object.values(GRID_MINOR);
    const ev = parseGrid(gridBody({}, all.map((t) => item(t))));
    if (ev.kind !== "grid-lines") throw new Error("kind");
    expect(ev.grid.items.map((i) => i.minorType)).toEqual([...all]);
  });

  it("種別が 0x07 を超えたら並びを打ち切る（原典と同じ条件）", () => {
    const ev = parseGrid(gridBody({}, [item(GRID_MINOR.PLAIN_BOX), item(0x10)]));
    if (ev.kind !== "grid-lines") throw new Error("kind");
    expect(ev.grid.items).toHaveLength(1);
  });

  it("CLEAR GRID LINE BUFFER（0x61）", () => {
    expect(parseWdsf(wrap(WDSF_TYPE.CLEAR_GRID_LINE_BUFFER, []), decode).kind)
      .toBe("clear-grid-lines");
  });
});

describe("ScreenBuffer のグリッド線状態", () => {
  const apply = (buf: ScreenBuffer, body: number[]): void => {
    const ev = parseGrid(body);
    if (ev.kind === "grid-lines") buf.applyGridLines(ev.grid);
  };

  it("描画・置き換え・消去・バッファクリア", () => {
    const buf = new ScreenBuffer();
    apply(buf, gridBody({}, [item(GRID_MINOR.PLAIN_BOX, { row: 5, col: 10 })]));
    expect(buf.snapshot("t", false).gui.gridLines).toHaveLength(1);

    // 同じ場所への再描画は置き換え（増えない・線種が更新される）
    apply(buf, gridBody({ defaultLine: GRID_LINE_STYLE.DOTTED }, [item(GRID_MINOR.PLAIN_BOX, { row: 5, col: 10 })]));
    const g = buf.snapshot("t", false).gui.gridLines;
    expect(g).toHaveLength(1);
    expect(g[0]!.lineStyle).toBe(GRID_LINE_STYLE.DOTTED);

    // 別の場所は増える
    apply(buf, gridBody({}, [item(GRID_MINOR.PLAIN_BOX, { row: 12, col: 10 })]));
    expect(buf.snapshot("t", false).gui.gridLines).toHaveLength(2);

    // 同じ指定で消去
    apply(buf, gridBody({}, [item(GRID_MINOR.PLAIN_BOX, { row: 5, col: 10, erase: true })]));
    expect(buf.snapshot("t", false).gui.gridLines).toHaveLength(1);

    // **すべて消えたら gui 自体が undefined になる**（GUI 構造体が 1 つも無い＝従来からの仕様）
    buf.clearGridLines();
    expect(buf.snapshot("t", false).gui).toBeUndefined();
  });

  it("項目の色が 0 なら主構造の既定色を使う", () => {
    const buf = new ScreenBuffer();
    apply(buf, gridBody({ defaultColor: 0x22 }, [item(GRID_MINOR.PLAIN_BOX, { color: 0 })]));
    expect(buf.snapshot("t", false).gui.gridLines[0]!.color).toBe(0x22);
  });
});

describe("CREATE WINDOW の Border Presentation（WDWBORDER）", () => {
  /**
   * 窓ヘッダ **5 バイト**（原典 `cw_fields`: flag1 / 予約 / 予約 / wd(depth) / ww(width)）
   * ＋ Border Presentation マイナー構造 13 バイト。
   */
  function windowBody(chars: string): number[] {
    return [
      0x00, 0x00, 0x00, // flag1 + 予約 2
      6, // wd（高さ）
      30, // ww（幅）
      13, // length（自身を含む）
      0x01, // minor_type = Border Presentation
      0x00, // flag1
      0x20, // mba
      0x22, // cba
      ...codec.encode(chars).bytes // 罫線文字 8 個（EBCDIC 1 バイトずつ）
    ];
  }

  it("罫線文字 8 個と色属性を読む", () => {
    const ev = parseWdsf(wrap(WDSF_TYPE.CREATE_WINDOW, windowBody(".-.||'-'")), decode);
    if (ev.kind !== "window") throw new Error("kind");
    const b = ev.window.border;
    expect(b).toBeDefined();
    expect(b!.chars).toBeDefined();
    const c = b!.chars!;
    expect([c.ulbc, c.tbc, c.urbc, c.lbc, c.rbc, c.llbc, c.bbc, c.lrbc])
      .toEqual([".", "-", ".", "|", "|", "'", "-", "'"]);
    expect(b!.cba).toBe(0x22);
  });

  /**
   * **実機（）が実際に送ってきた形**。`WDWBORDER((*COLOR PNK))` は色だけの指定なので、
   * ホストは罫線文字を載せない **5 バイト**の構造（`05 01 80 38 38`）を送る。
   * 原典のフィールド並びは最長形を示しているだけで、**長さは可変**。
   * 13 バイト固定と決め打つと、色指定だけの窓を丸ごと取りこぼす（実機テストで発覚）。
   */
  it("色だけの短い構造（実機の形）でも色を読む", () => {
    const ev = parseWdsf(wrap(WDSF_TYPE.CREATE_WINDOW, [
      0x80, 0x00, 0x00, 0x06, 0x28, // 窓ヘッダ（実機のバイトそのまま）
      0x05, 0x01, 0x80, 0x38, 0x38  // Border Presentation（5 バイト）
    ]), decode);
    if (ev.kind !== "window") throw new Error("kind");
    expect(ev.window.border?.cba).toBe(0x38);
    expect(ev.window.border?.chars).toBeUndefined();
    expect(ev.window.height).toBe(6);
    expect(ev.window.width).toBe(40);
  });

  it("Border Presentation が無ければ border は undefined（従来どおり）", () => {
    const ev = parseWdsf(wrap(WDSF_TYPE.CREATE_WINDOW, [0x00, 0x00, 0x00, 6, 30]), decode);
    if (ev.kind !== "window") throw new Error("kind");
    expect(ev.window.border).toBeUndefined();
  });

  it("ScreenBuffer 経由でスナップショットまで届く", () => {
    const buf = new ScreenBuffer();
    const ev = parseWdsf(wrap(WDSF_TYPE.CREATE_WINDOW, windowBody(".-.||'-'")), decode);
    if (ev.kind === "window") buf.addWindow(ev.window, 5, 10);
    expect(buf.snapshot("t", false).gui.windows[0]!.border?.chars?.tbc).toBe("-");
  });
});

/**
 * **実機（）が実際に送ってきた短い形**。
 *
 * グリッド線を持たない画面でも、ホストは「バッファをクリアせよ」だけの
 * Draw/Erase Grid Lines を送ってくる。そのとき主構造は既定色・既定線種を載せず
 * **5 バイト**（`01 80 00 00 00`）だった。原典のフィールド並びは最長形（7 バイト）を
 * 示しているだけで**長さは可変**。7 バイト固定で読むとレコード終端に突き当たり、
 * **構造化フィールドごと「壊れている」と捨ててしまう**（実機テストで発覚）。
 */
describe("実機が送る短い主構造", () => {
  it("5 バイトの主構造でもクリア指示として読める", () => {
    const ev = parseWdsf(
      Uint8Array.from([0xd9, 0x60, 0x01, 0x80, 0x00, 0x00, 0x00]),
      decode
    );
    expect(ev.kind).toBe("grid-lines");
    if (ev.kind !== "grid-lines") return;
    expect(ev.grid.clearBuffer).toBe(true);
    expect(ev.grid.items).toHaveLength(0);
  });
});
