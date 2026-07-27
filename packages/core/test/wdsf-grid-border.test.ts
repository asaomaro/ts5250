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

/**
 * マイナー構造 1 件（**11 バイト**）。
 * 先頭の length に従って進む実装なので、長さもここで正しく載せる。
 * 項目ごとの線種は Wireshark のディセクタには無く、**実機のバイト列から確定**した。
 */
function item(
  minorType: number,
  o: Partial<{ erase: boolean; row: number; col: number; w: number; h: number; color: number; line: number; rep: number; interval: number }> = {}
): number[] {
  return [
    11, // length（自身を含む）
    minorType,
    o.erase === true ? 0x80 : 0x00, // ms_flag1 bit0 = 消去
    o.row ?? 5,
    o.col ?? 10,
    o.w ?? 20,
    o.h ?? 6,
    o.color ?? 0xff,
    o.line ?? 0xff,
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
      row: 3, col: 5, width: 40, height: 10, value1: 4, value2: 2
    });
    expect(ev.grid.defaultLine).toBe(GRID_LINE_STYLE.DOUBLE);
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

  it("項目の色が既定（0xFF）なら主構造の既定色を使う", () => {
    const buf = new ScreenBuffer();
    apply(buf, gridBody({ defaultColor: 0x04 }, [item(GRID_MINOR.PLAIN_BOX, { color: 0xff })]));
    expect(buf.snapshot("t", false).gui.gridLines[0]!.color).toBe(0x04);
  });

  it("項目が色・線種を指定していればそちらを使う", () => {
    const buf = new ScreenBuffer();
    apply(buf, gridBody({ defaultColor: 0x04, defaultLine: 0x00 },
      [item(GRID_MINOR.PLAIN_BOX, { color: 0x01, line: 0x08 })]));
    const g = buf.snapshot("t", false).gui.gridLines[0]!;
    expect(g.color).toBe(0x01);
    expect(g.lineStyle).toBe(0x08);
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

/**
 * **実機（）が送ってきたグリッド線のバイト列そのもの。**
 *
 * DDS リファレンス（IBM `rzakcmst.pdf` の GRDBOX / GRDATR）の構文で DSPF をコンパイルし、
 * 実際に表示させて捕捉した。**マイナー構造は `length=0x0b`＝11 バイト**で、
 * Wireshark のディセクタが模す 10 フィールドより 1 つ多い——増えているのは
 * **項目ごとの線種**で、`(*LINTYP DSH)` を指定した箱が `… 01 08 02 08`
 * （色=BLU / 線種=DSH / 横罫 2 / 縦罫 8）と並ぶことから確定した。
 * だから長さを決め打たず、**先頭の length に従って進む**。
 */
describe("実機のグリッド線バイト列", () => {
  const parse = (bytes: number[]): ReturnType<typeof parseWdsf> =>
    parseWdsf(Uint8Array.from(bytes), decode);

  it("GRDBOX((*POS (5 5 8 40)) (*TYPE PLAIN)) — 既定色・既定線種", () => {
    const ev = parse([0xd9, 0x60, 0x01, 0x20, 0x00, 0x20, 0x00, 0x04, 0x00,
                      0x0b, 0x04, 0x00, 0x05, 0x05, 0x28, 0x08, 0xff, 0xff, 0xff, 0xff]);
    if (ev.kind !== "grid-lines") throw new Error("kind");
    expect(ev.grid.defaultColor).toBe(0x04); // GRDATR((*COLOR RED))
    expect(ev.grid.defaultLine).toBe(0x00);  // (*LINTYP SLD)
    expect(ev.grid.items).toHaveLength(1);
    expect(ev.grid.items[0]).toMatchObject({
      minorType: GRID_MINOR.PLAIN_BOX, erase: false,
      row: 5, col: 5, width: 40, height: 8
    });
    // 項目側はすべて「表示装置の既定」
    expect(ev.grid.items[0]!.color).toBe(0xff);
    expect(ev.grid.items[0]!.lineStyle).toBe(0xff);
  });

  it("GRDBOX((*POS (15 5 6 40)) (*TYPE HRZVRT 2 8) (*COLOR BLU) (*LINTYP DSH))", () => {
    const ev = parse([0xd9, 0x60, 0x01, 0x20, 0x00, 0x20, 0x00, 0x07, 0x00,
                      0x0b, 0x07, 0x00, 0x0f, 0x05, 0x28, 0x06, 0x01, 0x08, 0x02, 0x08]);
    if (ev.kind !== "grid-lines") throw new Error("kind");
    expect(ev.grid.items[0]).toMatchObject({
      minorType: GRID_MINOR.HV_RULED_BOX,
      row: 15, col: 5, width: 40, height: 6,
      color: 0x01,            // BLU
      lineStyle: 0x08,        // DSH
      value1: 0x02,           // 横罫の行間隔
      value2: 0x08            // 縦罫の桁間隔
    });
  });

  it("項目が既定を指していれば主構造の色・線種へ倒す", () => {
    const buf = new ScreenBuffer();
    const ev = parse([0xd9, 0x60, 0x01, 0x20, 0x00, 0x20, 0x00, 0x04, 0x00,
                      0x0b, 0x04, 0x00, 0x05, 0x05, 0x28, 0x08, 0xff, 0xff, 0xff, 0xff]);
    if (ev.kind === "grid-lines") buf.applyGridLines(ev.grid);
    const g = buf.snapshot("t", false).gui.gridLines[0]!;
    expect(g.color).toBe(0x04);    // GRDATR の RED
    expect(g.lineStyle).toBe(0x00); // SLD
  });
});

/**
 * **色・線種・種別の対応を実機で 1 つずつ確かめる**（TESTLIB/GRIDTST3・GRIDCL3）。
 *
 * 表を推測で作ると 1 か所ずれても気付けないので、DDS に色と線種を書き分けた箱を
 * 5 つ並べ、返ってきたバイト列をそのまま固定する。
 * `(*COLOR TRQ)` と `(*COLOR PNK)` は **DDS の時点で拒否される**（CPD7494）ため、
 * グリッド罫線で使える色は BLU/GRN/RED/WHT/YLW の 5 つ。
 */
describe("実機の色・線種・種別（GRIDCL3）", () => {
  // 主構造 `01 20 00 20 00 07 00`（GRDATR 無し → 既定色 WHT）＋ 11 バイトのマイナー 5 個
  const BYTES = [
    0xd9, 0x60, 0x01, 0x20, 0x00, 0x20, 0x00, 0x07, 0x00,
    0x0b, 0x04, 0x00, 0x04, 0x03, 0x14, 0x04, 0x04, 0x00, 0x01, 0x01, // RED  SLD
    0x0b, 0x04, 0x00, 0x04, 0x1a, 0x14, 0x04, 0x06, 0x08, 0x01, 0x01, // YLW  DSH
    0x0b, 0x04, 0x00, 0x04, 0x31, 0x14, 0x04, 0x07, 0x03, 0x01, 0x01, // WHT  DOT
    0x0b, 0x05, 0x00, 0x0a, 0x03, 0x1e, 0x06, 0x02, 0xff, 0x02, 0x01, // GRN  横罫のみ
    0x0b, 0x06, 0x00, 0x0a, 0x28, 0x1e, 0x06, 0x01, 0xff, 0x01, 0x05  // BLU  縦罫のみ
  ];
  const ev = parseWdsf(Uint8Array.from(BYTES), decode);
  if (ev.kind !== "grid-lines") throw new Error("kind");
  const items = ev.grid.items;

  it("DDS の *COLOR がそのままコードになる", () => {
    expect(items.map((i) => i.color)).toEqual([0x04, 0x06, 0x07, 0x02, 0x01]);
    // RED=4 / YLW=6 / WHT=7 / GRN=2 / BLU=1
  });

  it("DDS の *LINTYP がそのまま線種になる", () => {
    expect(items[0]!.lineStyle).toBe(GRID_LINE_STYLE.SOLID);  // SLD
    expect(items[1]!.lineStyle).toBe(GRID_LINE_STYLE.DASHED); // DSH
    expect(items[2]!.lineStyle).toBe(GRID_LINE_STYLE.DOTTED); // DOT
  });

  it("GRDATR が無い記録の既定色は WHT", () => {
    expect(ev.grid.defaultColor).toBe(0x07);
  });

  it("*TYPE PLAIN / HRZ / VRT が種別になる", () => {
    expect(items.map((i) => i.minorType)).toEqual([
      GRID_MINOR.PLAIN_BOX, GRID_MINOR.PLAIN_BOX, GRID_MINOR.PLAIN_BOX,
      GRID_MINOR.H_RULED_BOX, GRID_MINOR.V_RULED_BOX
    ]);
  });

  it("HRZ は value1 に、VRT は value2 に数値が入る", () => {
    // (*TYPE HRZ 2) → 横罫を 2 行ごと。(*TYPE VRT 5) → 縦罫を 5 桁ごと
    expect(items[3]).toMatchObject({ value1: 2, value2: 1 });
    expect(items[4]).toMatchObject({ value1: 1, value2: 5 });
  });
});

/**
 * **単独の罫線（GRDLIN）では 2 つの数値の意味が箱と違う**（GRIDCL4）。
 *
 * `(*TYPE UPPER 3 2)` は「3 本を 2 行おき」、`(*TYPE LEFT 4 6)` は「4 本を 6 桁おき」。
 * 箱の「行間隔・桁間隔」と同じ位置のバイトなので、**型で読み分けないと**
 * 単独罫線が 1 本しか出ない。
 */
describe("実機の単独罫線（GRIDCL4）", () => {
  const ev = parseWdsf(Uint8Array.from([
    0xd9, 0x60, 0x01, 0x20, 0x00, 0x20, 0x00, 0x07, 0x00,
    0x0b, 0x00, 0x00, 0x04, 0x03, 0x28, 0x00, 0xff, 0xff, 0x03, 0x02, // UPPER 3 2
    0x0b, 0x02, 0x00, 0x0e, 0x03, 0x00, 0x08, 0xff, 0xff, 0x04, 0x06  // LEFT  4 6
  ]), decode);
  if (ev.kind !== "grid-lines") throw new Error("kind");

  it("横の単独罫線は長さが width に入り height は 0", () => {
    expect(ev.grid.items[0]).toMatchObject({
      minorType: GRID_MINOR.UPPER_HORIZONTAL, row: 4, col: 3, width: 40, height: 0,
      value1: 3, value2: 2
    });
  });

  it("縦の単独罫線は長さが height に入り width は 0", () => {
    expect(ev.grid.items[1]).toMatchObject({
      minorType: GRID_MINOR.LEFT_VERTICAL, row: 14, col: 3, width: 0, height: 8,
      value1: 4, value2: 6
    });
  });
});

/**
 * **背景色のセルで枠を描く WDWBORDER**（GRIDCL3 の窓）。
 *
 * `WDWBORDER((*COLOR BLU) (*DSPATR RI) (*CHAR '        '))` と書くと、ホストは
 * **空白 8 個と属性 0x3B（青・反転）**を送ってくる。色を文字色としてだけ使うと
 * 「空白に青い文字色」＝何も見えない。反転を効かせて初めて枠になる。
 */
describe("実機の WDWBORDER（反転の空白／明示の枠文字）", () => {
  it("反転指定は空白 8 個＋反転属性で来る", () => {
    const ev = parseWdsf(Uint8Array.from([
      0xd9, 0x51, 0x80, 0x00, 0x00, 0x04, 0x24,
      0x0d, 0x01, 0x80, 0x3b, 0x3b, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40
    ]), decode);
    if (ev.kind !== "window") throw new Error("kind");
    expect(ev.window).toMatchObject({ width: 36, height: 4 });
    expect(ev.window.border?.cba).toBe(0x3b); // 青・反転
    expect(Object.values(ev.window.border!.chars!)).toEqual(Array(8).fill(" "));
  });

  it("枠文字の指定は DDS の並び（左上・上・右上・左・右・左下・下・右下）で来る", () => {
    const ev = parseWdsf(Uint8Array.from([
      0xd9, 0x51, 0x80, 0x00, 0x00, 0x05, 0x28,
      0x0d, 0x01, 0x80, 0x20, 0x20, 0x4e, 0x60, 0x4e, 0x4f, 0x4f, 0x4e, 0x60, 0x4e,
      // 見出し（minor 0x10）: WDWTITLE((*TEXT 'CHAR BORDER') (*COLOR YLW))
      0x11, 0x10, 0x00, 0x32, 0x32, 0x00,
      0xc3, 0xc8, 0xc1, 0xd9, 0x40, 0xc2, 0xd6, 0xd9, 0xc4, 0xc5, 0xd9
    ]), decode);
    if (ev.kind !== "window") throw new Error("kind");
    expect(ev.window.border?.chars).toEqual({
      ulbc: "+", tbc: "-", urbc: "+", lbc: "|", rbc: "|", llbc: "+", bbc: "-", lrbc: "+"
    });
    expect(ev.window.title).toBe("CHAR BORDER");
  });
});
