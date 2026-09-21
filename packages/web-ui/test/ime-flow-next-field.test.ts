import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **IME で確定した字が欄に入りきらないとき、余りは次の入力欄へ流れる。**（`20260922-ime-flow`）
 *
 * ACS は確定した字を 1 字ずつの打鍵として処理する（Java の入力メソッドの確定は KEY_TYPED の連なり）。打鍵は欄が満杯になると次の入力欄へ自動で送るので、
 * 確定の余りも次の欄の先頭から入る。当 PJ は余りを捨てていた（`onCompositionEnd` の `break`）。打鍵は 1 字ずつ届くので前から次の欄へ流れていた。
 * 次の欄へ送れないとき（Field Exit 必須・自動 Enter）や、挿入モードで入らないとき（0012）は流さない。
 */
const SID = "s1";
const cell = (): Cell => ({ char: " ", kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;
const fld = (index: number, row: number, length: number, over: Partial<Field> = {}): Field =>
  ({ index, row, col: 10, length, protected: false, hidden: false, numeric: false, mdt: false, value: "", ...over }) as Field;
function seed(fields: Field[]): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: 80 }, cell));
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: { sessionId: SID, rows: 24, cols: 80, cursor: { row: 3, col: 10 }, keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot,
    edits: new Map(), cursor: { row: 3, col: 10 }, link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send: () => {} } as unknown as WsClient
  });
}
const mountPane = () => mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
const inputByIndex = (index: number) => document.querySelector(`input.grid-input[data-field-index="${index}"][data-slice="0"]`) as HTMLInputElement;
const edited = (i: number): string | undefined => sessionsStore.byId.get(SID)!.edits.get(i);

/** 欄 `index` へ IME で `text` を確定する（合成開始 → 確定した字を prefix の後ろへ → 合成終了） */
async function commit(index: number, text: string): Promise<void> {
  const el = inputByIndex(index);
  el.focus();
  el.setSelectionRange(0, 0);
  await nextTick();
  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  await nextTick();
  el.value = el.value + text;
  el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await nextTick();
  await nextTick();
  await nextTick();
}

describe("IME 確定の余りを次の入力欄へ流す", () => {
  beforeEach(() => document.body.replaceChildren());

  it("**入りきらない余りは次の欄の先頭へ入る**（3 桁の欄へ 5 字 → `ABC` と次の欄に `DE`）", async () => {
    seed([fld(1, 3, 3), fld(2, 5, 5), fld(3, 7, 5)]);
    const w = mountPane();
    await nextTick();
    await commit(1, "ABCDE");
    expect(edited(1)).toBe("ABC");
    expect(edited(2)).toBe("DE");
    expect(edited(3), "その先の欄には入らない").toBeUndefined();
    expect(document.activeElement).toBe(inputByIndex(2));
    w.unmount();
  });

  it("**2 つ先の欄まで流れる**（2・2・5 桁の欄へ 6 字）", async () => {
    seed([fld(1, 3, 2), fld(2, 5, 2), fld(3, 7, 5)]);
    const w = mountPane();
    await nextTick();
    await commit(1, "ABCDEF");
    expect([edited(1), edited(2), edited(3)]).toEqual(["AB", "CD", "EF"]);
    w.unmount();
  });

  it("次の欄の既存の内容は上書きする（打鍵と同じ）", async () => {
    seed([fld(1, 3, 3), fld(2, 5, 5, { value: "12345" })]);
    const w = mountPane();
    await nextTick();
    await commit(1, "ABCDE");
    expect(edited(2)).toBe("DE345");
    w.unmount();
  });

  it("ちょうど入る確定は次の欄へ送るだけで、何も流さない", async () => {
    seed([fld(1, 3, 3), fld(2, 5, 5)]);
    const w = mountPane();
    await nextTick();
    await commit(1, "ABC");
    expect(edited(1)).toBe("ABC");
    expect(edited(2)).toBeUndefined();
    expect(document.activeElement).toBe(inputByIndex(2));
    w.unmount();
  });

  it("欄が 1 つだけの画面では、自分へ巡回して同じ欄を上書きしない（余りは捨てる）", async () => {
    seed([fld(1, 3, 3)]);
    const w = mountPane();
    await nextTick();
    await commit(1, "ABCDE");
    expect(edited(1)).toBe("ABC");
    w.unmount();
  });

  it("**自動 Enter の欄は次の欄へ流さず Enter を送る**", async () => {
    seed([fld(1, 3, 3, { autoEnter: true }), fld(2, 5, 5)]);
    const w = mountPane();
    await nextTick();
    await commit(1, "ABCDE");
    expect(edited(2)).toBeUndefined();
    w.unmount();
  });

  it("**Field Exit が必須の欄は自動送りしないので、余りは捨てる**（次の欄へ流さない）", async () => {
    seed([fld(1, 3, 3, { fieldExitRequired: true }), fld(2, 5, 5)]);
    const w = mountPane();
    await nextTick();
    await commit(1, "ABCDE");
    expect(edited(1)).toBe("ABC");
    expect(edited(2)).toBeUndefined();
    w.unmount();
  });

  it("挿入モードで入らないときは 0012 で、次の欄へは流さない", async () => {
    seed([fld(1, 3, 3, { value: "XYZ" }), fld(2, 5, 5)]);
    const w = mountPane();
    await nextTick();
    inputByIndex(1).focus();
    inputByIndex(1).dispatchEvent(new KeyboardEvent("keydown", { key: "Insert", bubbles: true, cancelable: true }));
    await nextTick();
    await commit(1, "AB");
    expect(edited(2)).toBeUndefined();
    w.unmount();
  });

  it("**全角も同じ**（DBCS の欄 10 桁＝SO/SI 込みで 4 字へ 6 字を確定）", async () => {
    seed([fld(1, 3, 10, { dbcsType: "open" }), fld(2, 5, 10, { dbcsType: "open" })]);
    const w = mountPane();
    await nextTick();
    await commit(1, "あいうえおか");
    expect(edited(1)).toBe("あいうえ");
    expect(edited(2)).toBe("おか");
    w.unmount();
  });
});
