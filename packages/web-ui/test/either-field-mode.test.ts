import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import { MSG_EITHER_DBCS_MODE, MSG_EITHER_SBCS_MODE } from "../src/composables/opMessages.js";

/**
 * （ハーネスは `dbcs-space-key.test.ts` の写し）
 * **J・G・E（DBCS 中）の欄で打った Space は全角空白（U+3000）になる**（ACS `processCharKeyStroke` の `convertSBCSCharToDBCS`。
 * `20260921-dbcs-space-key`）。実機の ACS のコアで測った（`scripts/acs-probe/dbcs-space-key.txt`。DBCSFE の画面・930）:
 * G・J は `あ`＋Space＋`い` が `あ　い`（間が全角空白）、先頭の Space も全角空白。O は SBCS の空白のまま。
 * E は空の欄・SBCS の字の後の Space が SBCS の空白で、`あ` の後は全角空白（E は最初の字で SBCS か DBCS かが決まる）
 */
const COLS = 80;
const cell = (char = " ", kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;
const fld = (dbcsType: Field["dbcsType"], extra: Partial<Field> = {}): Field =>
  ({ index: 1, row: 5, col: 20, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value: "", ...(dbcsType ? { dbcsType } : {}), ...extra }) as Field;

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});

async function grid(f: Field) {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  const next = { index: 2, row: 8, col: 20, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "" } as Field;
  const snapshot = { sessionId: "d1", rows: 24, cols: COLS, cursor: { row: f.row, col: f.col }, keyboardLocked: false, cells, fields: [f, next] } as unknown as ScreenSnapshot;
  const edits = new Map<number, string>();
  const w = mount(ScreenGrid, {
    props: { snapshot, edits, focused: true, busy: false, cursor: snapshot.cursor, onEdit: (i: number, v: string) => void edits.set(i, v) },
    attachTo: document.body
  });
  mounted.push(w as never);
  await nextTick();
  const el = w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
  el.focus();
  await nextTick();
  const type = async (...keys: string[]) => {
    for (const k of keys) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      await nextTick();
    }
  };
  /** IME で確定した字（合成の始め → 確定。`ime-flow` と同じ手順） */
  const ime = async (text: string) => {
    el.dispatchEvent(new CompositionEvent("compositionstart"));
    await nextTick();
    el.value = el.value.slice(0, el.selectionStart ?? el.value.length) + text;
    el.dispatchEvent(new CompositionEvent("compositionend"));
    await nextTick();
  };
  const paste = async (text: string) => {
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    ev.clipboardData = { getData: () => text };
    el.dispatchEvent(ev);
    await nextTick();
  };
  return { el, type, ime, paste, value: () => edits.get(1), notices: () => ((w.emitted("notice") as unknown[][] | undefined) ?? []).map((a) => a[0]) };
}


/**
 * **E（either）欄は最初の字で半角か全角かが決まり、混ぜられない**（ACS `PS5250.checkDBCSField`。`20260927-either-field-mode`）。
 * 実機の ACS のコア（`scripts/acs-probe/either-field-mode.txt`。DBCSFE の E 欄・930）:
 * `X` の後の `あ`（0061）・空の欄の途中の `あ`（0061）・`あい` の途中の `X`（0060）は拒否。`あい` の先頭の `X` は欄が `X` だけになる
 */
describe("E 欄の半角・全角", () => {
  it("**半角の後の全角は拒否（0061）**", async () => {
    const { type, value, notices } = await grid(fld("either"));
    await type("X", "あ");
    expect(value()).toBe("X");
    expect(notices()).toContain(MSG_EITHER_SBCS_MODE);
  });

  it("**全角の途中の半角は拒否（0060）**", async () => {
    const { type, value, notices } = await grid(fld("either"));
    await type("あ", "い", "ArrowLeft", "X");
    expect(value()).toBe("あい");
    expect(notices()).toContain(MSG_EITHER_DBCS_MODE);
  });

  it("**全角の欄の先頭で半角を打つと、欄を空にして半角に切り替える**", async () => {
    const { type, value, notices } = await grid(fld("either"));
    await type("あ", "い", "ArrowLeft", "ArrowLeft", "X");
    expect(value()).toBe("X");
    expect(notices()).toEqual([]);
  });

  it("**半角の欄の先頭で全角を打つと、欄を空にして全角に切り替える**", async () => {
    const { type, value } = await grid(fld("either"));
    await type("A", "B", "ArrowLeft", "ArrowLeft", "あ");
    expect(value()).toBe("あ");
  });

  it("同じ種類の字は従来どおり（半角の後の半角・全角の後の全角）", async () => {
    const a = await grid(fld("either"));
    await a.type("X", "Y");
    expect(a.value()).toBe("XY");
    const b = await grid(fld("either"));
    await b.type("あ", "い");
    expect(b.value()).toBe("あい");
  });

  it("O 欄（open）は混ぜられる（対象外）", async () => {
    const { type, value, notices } = await grid(fld("open"));
    await type("X", "あ");
    expect(value()).toBe("Xあ");
    expect(notices()).toEqual([]);
  });

  it("**空の欄の途中の全角は拒否（0061）**——空の欄は半角の状態（実測 B）", async () => {
    const { type, value, notices } = await grid(fld("either"));
    await type("ArrowRight", "ArrowRight", "あ");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_EITHER_SBCS_MODE);
  });

  it("**全角の状態はコアが持ち続ける**（ACS `Field5250.EitherFieldDBCSOn`）: 空でも途中に全角が打て、途中の半角は 0060", async () => {
    const a = await grid(fld("either", { eitherDbcsOn: true }));
    await a.type("ArrowRight", "ArrowRight", "あ");
    expect(a.value()).toContain("あ");
    expect(a.notices()).toEqual([]);
    const b = await grid(fld("either", { eitherDbcsOn: true }));
    await b.type("ArrowRight", "ArrowRight", "X");
    expect(b.value()).toBeUndefined();
    expect(b.notices()).toContain(MSG_EITHER_DBCS_MODE);
    const c = await grid(fld("either", { eitherDbcsOn: true }));
    await c.type("X");
    expect(c.value()).toBe("X"); // 先頭なら切り替え
  });

  it("**全角の字を消して空にしても全角の状態のまま**（ACS は消去でも SO/SI を残す）: 途中に全角が打てる", async () => {
    const { type, value, notices } = await grid(fld("either"));
    await type("あ", "い", "Backspace", "Backspace", "ArrowRight", "ArrowRight", "う");
    expect(value()).toContain("う");
    expect(notices()).toEqual([]);
  });

  it("**全角の状態の欄で打つ Space は全角空白**（切り替えた後に空にしても）", async () => {
    const a = await grid(fld("either", { eitherDbcsOn: true }));
    await a.type(" ", "あ");
    expect(a.value()).toBe("\u3000あ");
    const b = await grid(fld("either"));
    await b.type("あ", "Backspace", " ", "い");
    expect(b.value()).toBe("\u3000い");
  });

  it("**選択を置き換える字を拒否したら、選択も消さない**（モデルだけ消えて表示と食い違わない）", async () => {
    const { el, type, value, notices } = await grid(fld("either"));
    await type("あ", "い");
    el.setSelectionRange(el.value.indexOf("い"), el.value.indexOf("い") + 1);
    await type("X");
    expect(notices()).toContain(MSG_EITHER_DBCS_MODE);
    await type("End", "う");
    expect(value()).toBe("あいう");
  });

  it("**IME で確定した字にも同じ規則**: 半角の後の全角は拒否（0061）・手前の字は入る", async () => {
    const a = await grid(fld("either"));
    await a.type("X");
    await a.ime("あ");
    expect(a.value()).toBe("X");
    expect(a.notices()).toContain(MSG_EITHER_SBCS_MODE);
    const b = await grid(fld("either"));
    await b.ime("あい");
    expect(b.value()).toBe("あい");
    expect(b.notices()).toEqual([]);
  });
});

/**
 * **貼り付けにも同じ規則**（ACS `PS5250.pasteRect` は 1 字ずつ `inputChar` / `insertChar` → `checkDBCSField` を通る。`20260927-either-paste`）。
 * 上書きの貼り付けは拒否した字も桁を消費して続け、挿入の貼り付けは 1 字でも拒否なら何も貼らずにエラー（当 PJ の貼り付けの他の拒否と同じ）
 */
describe("E 欄の貼り付け", () => {
  it("**上書き**: 半角の後の全角は飛ばして桁を消費する（`XあB` → `X B`）", async () => {
    const { paste, value } = await grid(fld("either"));
    await paste("XあB");
    expect(value()).toBe("X B");
  });

  it("**上書き**: 全角の欄の先頭に半角を貼ると、欄を空にして半角に切り替える", async () => {
    const { type, paste, value } = await grid(fld("either"));
    await type("あ", "い", "ArrowLeft", "ArrowLeft");
    await paste("XY");
    expect(value()).toBe("XY");
  });

  it("**挿入**: 半角の後に全角を貼ると何も貼らずに 0061", async () => {
    const { type, paste, value, notices } = await grid(fld("either"));
    await type("X", "Insert");
    await paste("あ");
    expect(value()).toBe("X");
    expect(notices()).toContain(MSG_EITHER_SBCS_MODE);
  });

  it("**挿入**: 全角の途中に半角を貼ると何も貼らずに 0060", async () => {
    const { type, paste, value, notices } = await grid(fld("either"));
    await type("あ", "い", "ArrowLeft", "Insert");
    await paste("X");
    expect(value()).toBe("あい");
    expect(notices()).toContain(MSG_EITHER_DBCS_MODE);
  });

  it("**複数行の貼り付け（上書き）**も同じ: `XあB` の行は `X B`", async () => {
    const { paste, value } = await grid(fld("either"));
    await paste("XあB\nZ");
    expect(value()).toBe("X B");
  });

  it("**複数行の貼り付け（挿入）**: 全角の欄の先頭に半角を貼ると欄を空にして切り替える", async () => {
    const { type, paste, value, notices } = await grid(fld("either"));
    await type("あ", "い", "ArrowLeft", "ArrowLeft", "Insert");
    await paste("XY\nZ");
    expect(notices()).toEqual([]);
    expect(value()).toBe("XY");
  });

  it("**挿入**: 全角の欄の先頭に ` X` を貼ると、空白で切り替えた後の半角として X も受ける（切り替えた状態を持ち回る）", async () => {
    const { type, paste, value, notices } = await grid(fld("either"));
    await type("あ", "い", "ArrowLeft", "ArrowLeft", "Insert");
    await paste(" X");
    expect(notices()).toEqual([]);
    expect(value()).toBe(" X");
  });

  it("**上書き**: 全角の欄で飛ばした桁は全角空白で詰める（半角の空白を混ぜない）", async () => {
    const { type, paste, value } = await grid(fld("either"));
    await type("あ");
    await paste("Xい");
    expect(value()).toBe("あ\u3000い");
  });

  it("O 欄は混ぜて貼れる（対象外）", async () => {
    const { paste, value } = await grid(fld("open"));
    await paste("Xあ");
    expect(value()).toBe("Xあ");
  });
});

