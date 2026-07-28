import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell } from "@as400web/core";

/**
 * **表示コード切替（ACS の半角カナ ⇔ 英小文字）が両方向に効くこと。**
 *
 * `sbcsView` は親（EmulatorPane）が「保存値 × ホストの SBCS 表」から解決した実効値で、
 * `host` は再解釈しない。以前は `katakanaView: boolean` で **930 の表でしか読み直せず**、
 * ホストが 930 のセッションでは切替が無反応だった（利用者報告）。
 *
 * 生バイト `0x81` は 930 の SBCS 部（CP290）で `ｱ`、939 の SBCS 部（CP1027）で `a`。
 * この 1 バイトで両方向を確かめられる。
 */
function cell(char: string, extra: Partial<Cell> = {}): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false, ...extra
  } as Cell;
}

function snapWith(cells: Cell[][]): ScreenSnapshot {
  return {
    sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields: []
  } as ScreenSnapshot;
}

/** 1 行目の先頭に 1 セル置いた画面。`hostChar` はセッションのコーデックが出した文字。 */
function screenWith(hostChar: string, extra: Partial<Cell> = {}): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    cells.push(row);
  }
  cells[0]![0] = cell(hostChar, extra);
  return snapWith(cells);
}

function firstRowText(snapshot: ScreenSnapshot, sbcsView?: "host" | "kana" | "latin"): string {
  const w = mount(ScreenGrid, {
    props: { snapshot, edits: new Map(), focused: true, ...(sbcsView ? { sbcsView } : {}) }
  });
  const text = w.findAll(".grid-row")[0]!.text();
  w.unmount();
  return text;
}

describe("sbcsView — 表示コード切替は両方向に効く", () => {
  /**
   * 英小文字系ホスト（939 等）: セッションは 0x81 を "a" と解釈している。
   * カナを選ぶと 930 の表で読み直して "ｱ" になる（従来から動いていた方向）。
   */
  it("英小文字系ホストのセルを kana で読み直すとカタカナになる", () => {
    const snap = screenWith("a", { rawByte: 0x81 });
    expect(firstRowText(snap, "kana")).toContain("ｱ");
    expect(firstRowText(snap, "kana")).not.toContain("a");
  });

  /**
   * **これが直った不具合そのもの。**
   * カタカナ系ホスト（930/5026）: セッションは 0x81 を "ｱ" と解釈している。
   * 英を選ぶと 939 の表で読み直して "a" になる——以前はここで 930 の表を使っていたため
   * 「読み直しても同じ」＝切替が無反応だった。
   */
  it("カタカナ系ホストのセルを latin で読み直すと英小文字になる", () => {
    const snap = screenWith("ｱ", { rawByte: 0x81 });
    expect(firstRowText(snap, "latin")).toContain("a");
    expect(firstRowText(snap, "latin")).not.toContain("ｱ");
  });

  it("host は再解釈しない（既定。ホストの表のまま）", () => {
    expect(firstRowText(screenWith("ｱ", { rawByte: 0x81 }), "host")).toContain("ｱ");
    expect(firstRowText(screenWith("a", { rawByte: 0x81 }), "host")).toContain("a");
    // prop 未指定でも既定は host
    expect(firstRowText(screenWith("ｱ", { rawByte: 0x81 }))).toContain("ｱ");
  });

  it("同じバイトが向きによって別の文字になる（2 表が鏡像である証拠）", () => {
    const snap = screenWith("a", { rawByte: 0x62 });
    expect(firstRowText(snap, "kana")).toContain("a"); // 930 では 0x62='a'
    expect(firstRowText(snap, "latin")).toContain("ｲ"); // 939 では 0x62='ｲ'
  });
});

/**
 * 再解釈の元になる生バイトを持つのは SBCS セルだけ。DBCS・制御桁・オーダーが書いた文字は
 * `rawByte` を持たないので、**ホストの表で解釈済みの `char` をそのまま使う**。
 * ここを取りこぼすと、切替のたびに全角や記号が化ける。
 */
describe("sbcsView — 生バイトを持たないセルは触らない", () => {
  it("rawByte の無い SBCS セルは再解釈されない", () => {
    const snap = screenWith("X"); // rawByte なし
    expect(firstRowText(snap, "kana")).toContain("X");
    expect(firstRowText(snap, "latin")).toContain("X");
  });

  it("DBCS（全角）は再解釈されない", () => {
    const cells: Cell[][] = [];
    for (let r = 0; r < 24; r++) {
      const row: Cell[] = [];
      for (let c = 0; c < 80; c++) row.push(cell(" "));
      cells.push(row);
    }
    cells[0]![0] = cell("日", { kind: "dbcs-lead" });
    cells[0]![1] = cell("", { kind: "dbcs-tail" });
    const snap = snapWith(cells);
    expect(firstRowText(snap, "kana")).toContain("日");
    expect(firstRowText(snap, "latin")).toContain("日");
  });
});
