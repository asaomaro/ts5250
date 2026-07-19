import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * 入力・ペースト時の検証と ACS 準拠メッセージ（requirement / spec 参照）。
 *
 * 中核は上書きペーストの規則:
 * **入力不可文字も桁を消費し、その桁は元の文字のまま残す**（捨てて詰めない）。
 * 旧実装は文字ごと捨てていたため後続が左へ詰まり、数値欄 "123" に "3A5" を貼ると
 * "353" になっていた（正: "325"）。
 */
function cell(): Cell {
  return {
    char: " ",
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  };
}

function snap(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: "s1", rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells, fields };
}

type Opt = Partial<Field>;
function fld(index: number, row: number, col: number, length: number, o: Opt = {}): Field {
  return {
    index, row, col, length,
    protected: false, hidden: false, numeric: false, mdt: false, value: "",
    ...o
  };
}

function mountGrid(fields: Field[], edits = new Map<number, string>()) {
  return mount(ScreenGrid, {
    props: { snapshot: snap(fields), edits, focused: true },
    attachTo: document.body
  });
}

function paste(input: ReturnType<typeof mountGrid>["vm"] extends never ? never : any, text: string) {
  return input.trigger("paste", { clipboardData: { getData: () => text } } as unknown as ClipboardEvent);
}

function lastEdit(w: ReturnType<typeof mountGrid>, idx: number): string | undefined {
  const emits = (w.emitted("edit") ?? []) as [number, string][];
  return [...emits].reverse().find((e) => e[0] === idx)?.[1];
}

function notices(w: ReturnType<typeof mountGrid>): string[] {
  return ((w.emitted("notice") ?? []) as [string][]).map((e) => e[0]);
}

describe("上書きペースト: 入力不可文字は桁を消費して元を残す", () => {
  it("数値欄 '123' に '3A5' を貼ると '325'（'A' の桁は元の '2'）", async () => {
    const w = mountGrid([fld(1, 5, 10, 5, { numeric: true })], new Map([[1, "123"]]));
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    await paste(input, "3A5");
    expect(lastEdit(w, 1)).toBe("325");
    expect(notices(w), "上書きペーストではメッセージを出さない").toEqual([]);
    w.unmount();
  });

  it("空の数値欄に '1A' を貼ると '1'（2 桁目は空白のまま）", async () => {
    const w = mountGrid([fld(1, 5, 10, 5, { numeric: true })]);
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await paste(input, "1A");
    expect(lastEdit(w, 1)).toBe("1"); // 末尾空白は落ちる
    w.unmount();
  });

  it("半角欄に 'あ1いう2' を貼ると DBCS が空白 1 桁に置き換わる", async () => {
    const w = mountGrid([fld(1, 5, 10, 8)]);
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await paste(input, "あ1いう2");
    expect(lastEdit(w, 1)).toBe(" 1  2"); // 1 ソース文字 = 1 桁
    w.unmount();
  });

  it("既存の全角を壊さない（弾いた桁の中身に触れない）", async () => {
    const w = mountGrid([fld(1, 5, 10, 16, { dbcsType: "pure" })], new Map([[1, "日本語"]]));
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    await paste(input, "AB"); // J 型に SBCS → すべて弾かれる
    expect(lastEdit(w, 1), "既存 DBCS が壊れた").toBe("日本語"); // 値は変わらない
    expect(notices(w), "上書きではメッセージを出さない").toEqual([]);
    w.unmount();
  });
});

describe("打鍵・削除のメッセージ", () => {
  it("保護欄で文字キー・Backspace・Delete のいずれもメッセージを出す", async () => {
    const w = mountGrid([fld(1, 5, 10, 5, { protected: true })]);
    const input = w.find("input.grid-input");
    for (const key of ["A", "Backspace", "Delete"]) {
      await input.trigger("keydown", { key });
    }
    expect(notices(w)).toEqual([
      "Cursor in protected area of display.",
      "Cursor in protected area of display.",
      "Cursor in protected area of display."
    ]);
    w.unmount();
  });

  it("数値欄に英字を打つと numeric メッセージ", async () => {
    const w = mountGrid([fld(1, 5, 10, 5, { numeric: true })]);
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await input.trigger("keydown", { key: "A" });
    expect(notices(w)).toContain("Field requires numeric characters.");
    w.unmount();
  });

  it("半角欄に全角を打つと alphanumeric メッセージ", async () => {
    const w = mountGrid([fld(1, 5, 10, 5)]);
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await input.trigger("keydown", { key: "あ" });
    expect(notices(w)).toContain("Field data must be alphanumeric.");
    w.unmount();
  });

  it("J 型欄に半角を打つと dbcs-required メッセージ", async () => {
    const w = mountGrid([fld(1, 5, 10, 16, { dbcsType: "pure" })]);
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await input.trigger("keydown", { key: "A" });
    expect(notices(w)).toContain("Double-byte character required as input.");
    w.unmount();
  });
});

describe("挿入モードのペースト: 1 文字でも不可なら何も貼らない", () => {
  async function toInsertMode(input: ReturnType<typeof mountGrid>["find"] extends never ? never : any) {
    await input.trigger("keydown", { key: "Insert" });
  }

  it("数値欄に '1A' を挿入するとメッセージを出し、値は変わらない", async () => {
    const w = mountGrid([fld(1, 5, 10, 8, { numeric: true })], new Map([[1, "12"]]));
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await toInsertMode(input);
    await paste(input, "1A");
    expect(notices(w)).toContain("Field requires numeric characters.");
    expect(lastEdit(w, 1), "一部でも貼られてはいけない").toBe(undefined);
    w.unmount();
  });
});

describe("流し込み: 右が先、尽きたら下", () => {
  it("横並びの欄へあふれる（'12' '34' に '5678' → '56' '78'）", async () => {
    const w = mountGrid([fld(1, 5, 10, 2), fld(2, 5, 13, 2)], new Map([[1, "12"], [2, "34"]]));
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    await paste(input, "5678");
    expect(lastEdit(w, 1)).toBe("56");
    expect(lastEdit(w, 2)).toBe("78");
    w.unmount();
  });

  it("保護欄で始めても、その行の右にある入力欄から流し込む", async () => {
    // 欄1 は保護。開始桁が保護でも右の欄2 から入る
    const w = mountGrid([fld(1, 5, 10, 3, { protected: true }), fld(2, 5, 15, 4)]);
    const grid = w.findAll("input.grid-input");
    const prot = grid[0]!;
    await prot.trigger("focus");
    await paste(prot, "ABCD");
    expect(lastEdit(w, 2)).toBe("ABCD");
    expect(notices(w), "ペーストでは保護メッセージを出さない").toEqual([]);
    w.unmount();
  });

  it("その行に入力欄が無ければ下へは飛ばさず打ち切る", async () => {
    // 行5 に欄・行6 は欄なし・行7 に欄。2 行目以降は流れない
    const w = mountGrid([fld(1, 5, 10, 3), fld(2, 7, 10, 3)]);
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    await paste(input, "AAA\nBBB");
    expect(lastEdit(w, 1)).toBe("AAA");
    expect(lastEdit(w, 2), "空行を飛び越えて流れてはいけない").toBe(undefined);
    w.unmount();
  });
});
