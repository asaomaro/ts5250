import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { viewSettings, initViewSettings } from "../src/stores/viewSettings.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **ペインごと立てて確かめる**（`ScreenGrid` 単体では出ない不具合があるため）。
 *
 * カーソルの調停（`reconcileFocus`）・欄間の移動・キー配線は `EmulatorPane` 側にあり、
 * グリッド単体のテストでは再現しない。実機 E2E だけが捕まえていた「ピッカーを閉じた後、
 * **別の欄へフォーカスが飛ぶ**」をここで速く再現・固定する。
 */

const SID = "dtp-pane";
const TROW = 11;
const COL = 24;

function cell(ch = " "): Cell {
  return { char: ch, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}
function fld(over: Partial<Field> & { index: number; row: number; col: number; length: number }): Field {
  return { protected: false, hidden: false, numeric: true, mdt: false, value: "", ...over } as Field;
}
const DROW = 13;
/** 行 3 に素の欄、行 11 に時刻、行 13 に日付の分割欄（実機 DTMDSPF の DMA / TMW / D8U と同じ並び） */
const FIELDS: Field[] = [
  fld({ index: 1, row: 3, col: COL, length: 8 }),
  fld({ index: 2, row: TROW, col: COL, length: 2, continued: "first", value: "13" }),
  fld({ index: 3, row: TROW, col: COL + 3, length: 2, continued: "middle", value: "30" }),
  fld({ index: 4, row: TROW, col: COL + 6, length: 2, continued: "last", value: "15" }),
  fld({ index: 5, row: DROW, col: COL, length: 4, continued: "first", value: "2019" }),
  fld({ index: 6, row: DROW, col: COL + 5, length: 2, continued: "middle", value: "03" }),
  fld({ index: 7, row: DROW, col: COL + 8, length: 2, continued: "last", value: "31" })
];
function snap(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= 80; c++) row.push(cell());
    cells.push(row);
  }
  cells[TROW - 1]![COL + 1] = cell(":");
  cells[TROW - 1]![COL + 4] = cell(":");
  cells[DROW - 1]![COL + 3] = cell("/");
  cells[DROW - 1]![COL + 6] = cell("/");
  return { sessionId: SID, rows: 24, cols: 80, cursor: { row: TROW, col: COL },
    keyboardLocked: false, cells, fields: FIELDS } as unknown as ScreenSnapshot;
}

beforeEach(() => {
  localStorage.clear();
  initViewSettings();
  viewSettings.set("dtPicker", "panel");
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sent.length = 0;
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: snap(), edits: new Map(), cursor: { row: TROW, col: COL },
    connected: true, readOnly: false,
    client: { send(m: unknown) { sent.push(m); } } as unknown as WsClient
  });
});
/** ホストへ送った内容（AID が漏れていないかを見る） */
const sent: unknown[] = [];

const active = () => document.activeElement as HTMLElement | null;
const press = (key: string, init: KeyboardEventInit = {}) =>
  active()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

describe("ピッカーを閉じた後のフォーカス（ペインごと）", () => {
  async function openPicker() {
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    const input = w.find(`input.grid-input[data-field-index="2"]`);
    await input.trigger("focus");
    await nextTick();
    // Alt+↓（ペインの既存ハンドラ経由）で開く
    await w.find(".pane").trigger("keydown", { key: "ArrowDown", altKey: true });
    await nextTick();
    await nextTick();
    return w;
  }

  it("`Alt+↓` でピッカーが開き、フォーカスが中へ移る", async () => {
    const w = await openPicker();
    expect(w.find(".dtp").exists()).toBe(true);
    expect(active()?.closest(".dtp")).not.toBeNull();
    w.unmount();
  });

  it("`Enter` で確定して閉じたあと、**編集していた欄**へフォーカスが戻る", async () => {
    const w = await openPicker();
    press("Enter");
    await nextTick();
    await nextTick();
    expect(w.find(".dtp").exists()).toBe(false);
    expect(active()?.getAttribute("data-field-index"), "別の欄へ飛んでいる").toBe("2");
    w.unmount();
  });

  /**
   * **ピッカーの `Enter` をホストへ送ってはいけない。**
   *
   * 伝播を止めないとペインまで上がり、**AID の Enter が飛ぶ**——ピッカーは同期的に閉じるので、
   * ペイン側の「開いている間は無視」の条件が event の届く頃には既に外れている。
   * 実機ではこれで画面が再表示され、**カーソルが先頭の欄へ飛んだ**（E2E だけが捕まえていた）。
   */
  it("`Enter` は確定に使い、ホストへ AID を送らない", async () => {
    const w = await openPicker();
    sent.length = 0;
    press("Enter");
    await nextTick();
    await nextTick();
    const aids = sent.filter((m) => JSON.stringify(m).includes("Enter"));
    expect(aids, "AID の Enter がホストへ漏れている").toEqual([]);
    w.unmount();
  });

  it("`Esc` で閉じたときも同じ欄へ戻る", async () => {
    const w = await openPicker();
    press("Escape");
    await nextTick();
    await nextTick();
    expect(w.find(".dtp").exists()).toBe(false);
    expect(active()?.getAttribute("data-field-index")).toBe("2");
    w.unmount();
  });
});

/**
 * **逐次反映は「プレビュー」であって確定ではない。**
 *
 * 時刻は列を選ぶたびに欄へ書く（背後の欄で組み立ての途中が見える）。この形を採るなら
 * **`Esc` は開いた時点へ戻す**のが揃った約束——APG のダイアログも、逐次反映する実装系も
 * `Esc` は取り消し。戻さないと「やめた」つもりの操作で欄が変わったままになる。
 *
 * ただし**外側クリックでは戻さない**。マウスだけで時刻を決める人には「列を押す →
 * 別の場所を押して終わり」以外の確定手段が無いので、そこで巻き戻すと決められなくなる。
 */
/**
 * **時刻は確定するまで欄へ書かない**（ダイアログの作法）。
 *
 * 時・分・秒が独立していて 1 列では値が定まらないので、日付のような「選んだ瞬間に確定」に
 * できない。中では下書きを組み立て、**`Enter` か「確定」で一度だけ書く**。
 * こうすると `Esc` は「閉じるだけ」で自然に取り消しになり、欄を巻き戻す仕掛けが要らない。
 */
describe("時刻は確定するまで欄へ書かない", () => {
  const values = (w: ReturnType<typeof mount>) =>
    [2, 3, 4].map((i) => (w.find(`input.grid-input[data-field-index="${i}"]`).element as HTMLInputElement).value.trim());

  async function open() {
    const p = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    await p.find('input.grid-input[data-field-index="2"]').trigger("focus");
    await nextTick();
    await p.find(".pane").trigger("keydown", { key: "ArrowDown", altKey: true });
    await nextTick(); await nextTick();
    return p;
  }

  it("列を選んでも欄は変わらない（下書きのまま）", async () => {
    const w = await open();
    expect(values(w)).toEqual(["13", "30", "15"]);
    press("ArrowDown"); // 時を 1 つ進める
    await nextTick();
    await active()!.click(); // Space 相当＝下書きに入れるだけ
    await nextTick();
    expect(values(w), "確定前に欄が変わっている").toEqual(["13", "30", "15"]);
    expect(w.emitted("edit")).toBeUndefined();
    expect(w.find(".dtp").exists()).toBe(true); // 開いたまま
    w.unmount();
  });

  it("`Esc` で閉じると何も書かれない（取り消しの仕掛けが要らない）", async () => {
    const w = await open();
    press("ArrowDown");
    await nextTick();
    await active()!.click();
    await nextTick();
    press("Escape");
    await nextTick(); await nextTick();
    expect(w.find(".dtp").exists()).toBe(false);
    expect(values(w), "Esc の後に欄が変わっている").toEqual(["13", "30", "15"]);
    w.unmount();
  });

  it("「確定」ボタンで下書きが欄へ入り、閉じる（マウスだけでも決められる）", async () => {
    const w = await open();
    press("ArrowDown");
    await nextTick();
    const picked = active()!.dataset.val!;
    await active()!.click(); // 下書きへ
    await nextTick();
    await w.find(".dtp-ok").trigger("click");
    await nextTick(); await nextTick();
    expect(w.find(".dtp").exists()).toBe(false);
    expect(values(w)[0]).toBe(String(Number(picked)).padStart(2, "0"));
    expect(values(w).slice(1)).toEqual(["30", "15"]); // 触っていない列は元のまま
    w.unmount();
  });

  it("外側クリックで閉じても書かれない（確定を踏んでいない）", async () => {
    const w = await open();
    press("ArrowDown");
    await nextTick();
    await active()!.click();
    await nextTick();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await nextTick(); await nextTick();
    expect(w.find(".dtp").exists()).toBe(false);
    expect(values(w)).toEqual(["13", "30", "15"]);
    w.unmount();
  });
});

/**
 * **重ねた部品の上のホイールは、その部品の中で効く**（端末へ流さない）。
 *
 * ペインのホイールは端末のページ送り（`PageUp`/`PageDown`）に割り当ててある。
 * ピッカーの上でそれが走ると**ホストへ Roll が飛び、再表示でピッカーが閉じる**——
 * 実際にそうなっていた（除外がオプション選択肢にだけ入っていてピッカーが漏れていた）。
 * 除外の集合は `composables/focusTrap.ts` の `OVERLAY_SELECTOR` に一元化してある。
 */
describe("ピッカーの上のホイール", () => {
  async function open() {
    const p = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    await p.find('input.grid-input[data-field-index="2"]').trigger("focus");
    await nextTick();
    await p.find(".pane").trigger("keydown", { key: "ArrowDown", altKey: true });
    await nextTick(); await nextTick();
    return p;
  }

  it("ホストへページ送りを送らず、ピッカーも閉じない", async () => {
    const w = await open();
    sent.length = 0;
    const col = w.find(".dtp-col").element as HTMLElement;
    const ev = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    col.dispatchEvent(ev);
    await nextTick(); await nextTick();

    const rolls = sent.filter((m) => /PageDown|PageUp/.test(JSON.stringify(m)));
    expect(rolls, "ホストへ Roll が飛んでいる").toEqual([]);
    // 既定を止めていない＝native スクロールが生きている（列が自分でスクロールできる）
    expect(ev.defaultPrevented, "既定が止められている（列がスクロールできない）").toBe(false);
    expect(w.find(".dtp").exists(), "ピッカーが閉じている").toBe(true);
    w.unmount();
  });

  it("ピッカーの外のホイールは従来どおり端末のページ送りになる", async () => {
    const w = await open();
    sent.length = 0;
    w.find(".pane").element.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
    await nextTick(); await nextTick();
    expect(sent.filter((m) => /PageDown/.test(JSON.stringify(m))).length).toBeGreaterThan(0);
    w.unmount();
  });
});

/**
 * **矢印で月をまたいだときにフォーカスを失わない。**
 *
 * 月が変わると日のボタンは作り直され、**フォーカス中の要素が消える**ことがある
 * （3/31 → 4/1 のように、送り先にその日が無い場合）。消えた瞬間フォーカスは `body` へ落ち、
 * ペイン側の調停が拾って**背後の端末の欄へ戻してしまう**——利用者報告の症状。
 * ペインごと立てないと再現しない（`ScreenGrid` 単体ではペインの調停が無い）。
 */
describe("矢印で月をまたぐときのフォーカス", () => {
  async function openDate() {
    const p = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    await p.find('input.grid-input[data-field-index="5"]').trigger("focus");
    await nextTick();
    await p.find(".pane").trigger("keydown", { key: "ArrowDown", altKey: true });
    await nextTick(); await nextTick();
    return p;
  }

  it("3/31 で → を押すと 4/1 へ移り、フォーカスはピッカーに残る", async () => {
    const w = await openDate();
    expect(w.find(".dtp-ym").text()).toBe("2019/03");
    expect(active()?.dataset.day).toBe("31");

    press("ArrowRight");
    await nextTick(); await nextTick(); await nextTick();

    expect(w.find(".dtp-ym").text()).toBe("2019/04");
    expect(active()?.closest(".dtp"), "ピッカーからフォーカスが外れた").not.toBeNull();
    expect(active()?.dataset.day).toBe("1");
    w.unmount();
  });

  it("4/1 で ← を押すと 3/31 へ戻り、フォーカスはピッカーに残る", async () => {
    const w = await openDate();
    press("ArrowRight"); // 4/1 へ
    await nextTick(); await nextTick(); await nextTick();
    press("ArrowLeft");
    await nextTick(); await nextTick(); await nextTick();
    expect(w.find(".dtp-ym").text()).toBe("2019/03");
    expect(active()?.closest(".dtp"), "ピッカーからフォーカスが外れた").not.toBeNull();
    expect(active()?.dataset.day).toBe("31");
    w.unmount();
  });

  it("↓ で月をまたいでもフォーカスはピッカーに残る", async () => {
    const w = await openDate();
    press("ArrowDown"); // 3/31 + 7 → 4/7
    await nextTick(); await nextTick(); await nextTick();
    expect(w.find(".dtp-ym").text()).toBe("2019/04");
    expect(active()?.closest(".dtp"), "ピッカーからフォーカスが外れた").not.toBeNull();
    w.unmount();
  });
});
