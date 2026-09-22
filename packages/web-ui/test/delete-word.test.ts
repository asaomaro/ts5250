import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { keybindingsStore } from "../src/stores/keybindings.js";
import { deleteWord, deleteWordLength, type EditState } from "../src/composables/fieldEdit.js";
import { isWideForDbcs } from "../src/composables/fieldValidate.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **Delete Word（ACS の既定 `C127`＝Ctrl+Delete の `[deleteword]`）。** `20260921-delete-word`。
 * 実機の ACS のコアで測った（`scripts/acs-probe/delete-word.txt`。コマンド行と DBCSFE の O 欄。継続欄は `continued-field-erase-exit.txt` の B8）:
 * 語頭なら「語＋続く空白」・語の途中ならカーソルから語の終わりまで・空白の上と全角は 1 字。記号は語の一部。継続欄は鎖を 1 つの欄として数える。
 * 操作員エラー中も拒否せず、エラーを抜けて働く（`[delete]` は拒否）。Ctrl+Backspace には割り当てが無い。
 */
const chars = (s: string, len = 20): string[] => {
  const out = [...s];
  while (out.length < len) out.push(" ");
  return out;
};
const after = (s: string, cursor: number, wide?: (c: string) => boolean): string => {
  const c = chars(s);
  const n = deleteWordLength(c, cursor, wide);
  c.splice(cursor, n);
  return c.join("").trimEnd();
};

describe("Delete Word の範囲（純ロジック。実機の ACS のコアの測定 a〜l・d1〜d8）", () => {
  it.each([
    ["a) 語頭: 語＋続く空白", "AAA BBB CCC", 4, 4, "AAA CCC"],
    ["b) 語の途中: 語の終わりまで（続く空白は残す）", "AAA BBB CCC", 5, 2, "AAA B CCC"],
    ["c) 空白の上: 1 字", "AAA BBB CCC", 3, 1, "AAABBB CCC"],
    ["d) 最後の語の頭（後ろの空白 9 桁も続く空白として数える。見た目は語だけが消える）", "AAA BBB CCC", 8, 12, "AAA BBB"],
    ["e) 最後の 1 字", "AAA BBB CCC", 10, 1, "AAA BBB CC"],
    ["g) 先頭の語", "AAA BBB CCC", 0, 4, "BBB CCC"],
    ["h) 語頭で続く空白が複数: 全部消す", "AAA BBB   CCC", 4, 6, "AAA CCC"],
    ["i) 語の途中で続く空白が複数: 空白は残す", "AAA BBB   CCC", 5, 2, "AAA B   CCC"],
    ["j) 記号を含む語の頭: 空白だけが区切り", "AB,CD EF", 0, 6, "EF"],
    ["k) 記号の上（語の途中）: カーソルから語の終わりまで", "AB,CD EF", 2, 3, "AB EF"],
    ["l1) 空白が 2 つ続く上（1 つ目）: 1 字", "AAA  BBB", 3, 1, "AAA BBB"],
    ["l2) 同（2 つ目）: 1 字", "AAA  BBB", 4, 1, "AAA BBB"]
  ])("%s", (_l, text, cursor, n, expected) => {
    expect(deleteWordLength(chars(text), cursor)).toBe(n);
    expect(after(text, cursor)).toBe(expected);
  });

  it("f) 中身の後ろの空きセル: 1 字（空白）で、見た目は変わらない", () => {
    expect(after("AAA BBB CCC", 12)).toBe("AAA BBB CCC");
  });

  it("カーソルが欄の外（末尾の後ろ）なら 0", () => {
    expect(deleteWordLength(chars("AB", 4), 4)).toBe(0);
    expect(deleteWordLength([], 0)).toBe(0);
  });

  describe("全角（DBCS の欄の論理値。全角は 1 字ずつ・SBCS の数えは全角で止まる）", () => {
    const wide = isWideForDbcs;
    it.each([
      ["d1) 先頭の語（`AA ` を消す）", "AA あい BB", 0, "あい BB"],
      ["d2) 全角の先頭: 1 字だけ", "AA あい BB", 3, "AA い BB"],
      ["d3) 全角の 2 字目: 1 字だけ", "AA あい BB", 4, "AA あ BB"],
      ["d4) 全角の前の空白: 1 字", "AA あい BB", 2, "AAあい BB"],
      ["d5) 最後の語", "AA あい BB", 6, "AA あい"],
      ["d6) 全角の直後の半角の語頭: 語頭と数える（`BB` だけ残る）", "あいAA BB", 2, "あいBB"],
      ["d7) 半角の語の直後が全角: 語は全角で止まる（`AA` だけ消える）", "AAあい BB", 0, "あい BB"],
      ["d8) 同じ語の途中: `A` だけ消える", "AAあい BB", 1, "Aあい BB"]
    ])("%s", (_l, text, cursor, expected) => {
      expect(after(text, cursor, wide)).toBe(expected);
    });
  });

  it("deleteWord: 欄の長さとカーソルを保つ（Delete と同じ形）", () => {
    const s: EditState = { chars: chars("AAA BBB CCC", 12), cursor: 4, insertMode: false };
    const r = deleteWord(s);
    expect(r.chars.join("")).toBe("AAA CCC     ");
    expect(r.chars).toHaveLength(12);
    expect(r.cursor).toBe(4);
    expect(deleteWord({ ...s, cursor: 12 }), "末尾の後ろでは変えない").toEqual({ ...s, cursor: 12 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
const COLS = 80;
const ROW = 5;
function cell(char = " ", kind: Cell["kind"] = "sbcs"): Cell {
  return { char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}
function fld(over: Partial<Field> & { index: number; col: number; length: number }): Field {
  return { row: ROW, protected: false, hidden: false, numeric: false, mdt: false, value: "", ...over } as Field;
}
function snapOf(fields: Field[], put?: (cells: Cell[][]) => void): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  put?.(cells);
  return { sessionId: "s1", rows: 24, cols: COLS, cursor: { row: ROW, col: 10 }, keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}
/** DBCS の欄（O。col 10 から 12 桁）に `text` を置く。全角の連なりは SO ＋ 全角（先頭・後尾）＋ SI で囲む（編集の初期値はセルから採られる） */
function putDbcsOpen(text: string): (cells: Cell[][]) => void {
  return (cells) => {
    let i = 9;
    let inWide = false;
    for (const ch of text) {
      const wide = isWideForDbcs(ch);
      if (wide && !inWide) { cells[ROW - 1]![i++] = cell(" ", "so"); inWide = true; }
      if (!wide && inWide) { cells[ROW - 1]![i++] = cell(" ", "si"); inWide = false; }
      if (wide) { cells[ROW - 1]![i++] = cell(ch, "dbcs-lead"); cells[ROW - 1]![i++] = cell("", "dbcs-tail"); }
      else cells[ROW - 1]![i++] = cell(ch);
    }
    if (inWide) cells[ROW - 1]![i++] = cell(" ", "si");
  };
}

describe("Delete Word（ScreenGrid）", () => {
  beforeEach(() => document.body.replaceChildren());

  const mountGrid = (fields: Field[], put?: (cells: Cell[][]) => void) =>
    mount(ScreenGrid, { props: { snapshot: snapOf(fields, put), edits: new Map(), focused: true, busy: false, cursor: { row: ROW, col: 10 } }, attachTo: document.body });
  const inputs = (w: ReturnType<typeof mountGrid>) =>
    Array.from(w.element.querySelectorAll('input.grid-input:not([readonly])[data-slice="0"]')) as HTMLInputElement[];
  /** 区間 `seg` の桁 `caret`（DBCS の欄は列ビューの位置）にカーソルを置く。修飾キーだけの keydown で native の caret を編集モデルへ写す */
  async function place(w: ReturnType<typeof mountGrid>, seg: number, caret: number) {
    const el = inputs(w)[seg]!;
    el.focus();
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true, cancelable: true }));
    await nextTick();
    return el;
  }
  const values = (w: ReturnType<typeof mountGrid>, fields: Field[]) => {
    const last = new Map<number, string>();
    for (const [idx, val] of (w.emitted("edit") as unknown[][] | undefined) ?? []) last.set(idx as number, val as string);
    return fields.map((f) => last.get(f.index) ?? f.value);
  };
  const run = (w: ReturnType<typeof mountGrid>) => (w.vm as unknown as { deleteWord: () => void }).deleteWord();

  it("**SBCS: 語頭は語＋続く空白・語の途中は語の終わりまで**（実機 a・b）。欄は出ず、カーソルは動かない", async () => {
    const fields = [fld({ index: 1, col: 10, length: 20, value: "AAA BBB CCC" })];
    const w = mountGrid(fields);
    await nextTick();
    let el = await place(w, 0, 4);
    run(w);
    await nextTick();
    expect(values(w, fields)).toEqual(["AAA CCC"]);
    expect(el.selectionStart, "カーソルは動かない").toBe(4);
    expect(w.emitted("field-full"), "欄を出ない").toBeUndefined();
    el = await place(w, 0, 5); // `AAA CCC` の 5 桁目（C の途中）
    run(w);
    await nextTick();
    expect(values(w, fields)).toEqual(["AAA C"]);
  });

  it("**消えるものが無くても MDT**（`processDeleteWord` は `processDeleteChar` と同じ。空白の桁で 1 字）", async () => {
    const fields = [fld({ index: 1, col: 10, length: 20, value: "AAA" })];
    const w = mountGrid(fields);
    await nextTick();
    await place(w, 0, 10);
    run(w);
    await nextTick();
    expect((w.emitted("edit") as unknown[][])?.[0]).toEqual([1, "AAA"]);
  });

  it("**保護欄・欄の外では操作員エラー**", async () => {
    const fields = [fld({ index: 1, col: 10, length: 6, value: "AB", protected: true })];
    const w = mountGrid(fields);
    await nextTick();
    run(w);
    expect(w.emitted("notice")).toBeTruthy();
    expect(w.emitted("edit")).toBeUndefined();
  });

  it("**DBCS（O）: 全角は 1 字ずつ・半角の語は語頭で語＋空白**（実機 d1〜d5。`AA あい BB` の列ビュー: AA␠⟦あい⟧␠BB）", async () => {
    const fields = [fld({ index: 1, col: 10, length: 12, dbcsType: "open", value: "AA あい BB" })];
    const cases: [string, number, string][] = [
      ["d1 先頭の語", 0, "あい BB"],
      ["d2 全角の先頭", 4, "AA い BB"],
      ["d3 全角の 2 字目", 5, "AA あ BB"],
      ["d4 全角の前の空白", 2, "AAあい BB"],
      ["d5 最後の語", 8, "AA あい"]
    ];
    for (const [name, caret, expected] of cases) {
      document.body.replaceChildren();
      const w = mountGrid(fields, putDbcsOpen("AA あい BB"));
      await nextTick();
      await place(w, 0, caret);
      run(w);
      await nextTick();
      expect(values(w, fields)[0], name).toBe(expected);
    }
  });

  it("**継続欄は鎖を 1 つの欄として数える**（実機 B8: `1234/56/78` の 1 区間目の 2 桁目で `1   /  /  `）", async () => {
    const seg = (index: number, col: number, length: number, continued: NonNullable<Field["continued"]>, value: string) =>
      fld({ index, col, length, continued, value, numeric: true });
    const fields = [seg(1, 24, 4, "first", "1234"), seg(2, 29, 2, "middle", "56"), seg(3, 32, 2, "last", "78")];
    const w = mountGrid(fields);
    await nextTick();
    await place(w, 0, 1);
    run(w);
    await nextTick();
    expect(values(w, fields)).toEqual(["1", "", ""]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("既定のキー（ペイン結合）: Ctrl+Delete は Delete Word・Ctrl+Backspace は何もしない・Erase EOF は割り当てれば効く", () => {
  const SID = "s1";
  function seed(fields: Field[], put?: (cells: Cell[][]) => void): void {
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID, label: "t", snapshot: snapOf(fields, put), edits: new Map(),
      cursor: { row: ROW, col: 10 }, link: { state: "connected" }, resumability: "resumable", readOnly: false,
      client: { send: () => {} } as unknown as WsClient
    });
  }
  const mountPane = () => mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
  const input = () => document.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
  async function key(over: KeyboardEventInit, caret: number) {
    const el = input();
    el.focus();
    el.setSelectionRange(caret, caret);
    await nextTick();
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...over });
    el.dispatchEvent(ev);
    await nextTick();
    await nextTick();
    return ev;
  }
  const edited = () => sessionsStore.byId.get(SID)!.edits.get(1);

  beforeEach(() => {
    localStorage.clear();
    keybindingsStore.reload(); // 初回起動相当（既定が入る）
    document.body.replaceChildren();
  });
  afterEach(() => keybindingsStore.reload());

  it("**Ctrl+Delete は Delete Word**（語頭で語＋空白）", async () => {
    seed([fld({ index: 1, col: 10, length: 20, value: "AAA BBB CCC" })]);
    const w = mountPane();
    await nextTick();
    await key({ key: "Delete", ctrlKey: true }, 4);
    expect(edited()).toBe("AAA CCC");
    w.unmount();
  });

  it("**Ctrl+Backspace は何もしない**（ACS に割り当て無し。以前は Erase Input で全欄が消えた。ブラウザの語削除で <input> の値だけが変わることもない）", async () => {
    seed([fld({ index: 1, col: 10, length: 20, value: "AAA BBB CCC" })]);
    const w = mountPane();
    await nextTick();
    const ev = await key({ key: "Backspace", ctrlKey: true }, 7);
    expect(edited(), "値を変えない").toBeUndefined();
    expect(input().value.trimEnd(), "DOM の値も変えない").toBe("AAA BBB CCC");
    expect(ev.defaultPrevented, "ブラウザの既定（語の削除）を止める").toBe(true);
    w.unmount();
  });

  it("**Ctrl+Delete を外した人にも、ブラウザの語削除は走らない**（割り当ての無い修飾付き Delete は何もしない）", async () => {
    keybindingsStore.remove("ctrl+Delete");
    seed([fld({ index: 1, col: 10, length: 20, value: "AAA BBB CCC" })]);
    const w = mountPane();
    await nextTick();
    const ev = await key({ key: "Delete", ctrlKey: true }, 4);
    expect(edited()).toBeUndefined();
    expect(ev.defaultPrevented).toBe(true);
    w.unmount();
  });

  it("**Erase EOF は既定のキーが無い**が、割り当てれば効く（Ctrl+Delete の上書きで確かめる）", async () => {
    keybindingsStore.set("ctrl+Delete", "local:erase-eof");
    seed([fld({ index: 1, col: 10, length: 20, value: "AAA BBB CCC" })]);
    const w = mountPane();
    await nextTick();
    await key({ key: "Delete", ctrlKey: true }, 4);
    expect(edited()).toBe("AAA");
    w.unmount();
  });

  it("DBCS の欄でも同じ（Ctrl+Backspace は何もしない）", async () => {
    seed([fld({ index: 1, col: 10, length: 12, dbcsType: "open", value: "AA あい BB" })], putDbcsOpen("AA あい BB"));
    const w = mountPane();
    await nextTick();
    const ev = await key({ key: "Backspace", ctrlKey: true }, 4);
    expect(edited()).toBeUndefined();
    expect(ev.defaultPrevented).toBe(true);
    w.unmount();
  });
});
