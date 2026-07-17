import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";
import type { WsClient } from "../src/ws-client.js";

function cell(char = " "): Cell {
  return {
    char,
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

function field(index: number, row: number, protectedField = false): Field {
  return { index, row, col: 10, length: 5, protected: protectedField, hidden: false, numeric: false, mdt: false, value: "" };
}

const SID = "s1";

function seed(fields: Field[]): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID,
    label: "t",
    snapshot: snap(fields),
    edits: new Map(),
    cursor: { row: 1, col: 1 },
    connected: true,
    readOnly: false,
    client: {} as WsClient
  });
}

function inputs(w: ReturnType<typeof mount>): HTMLInputElement[] {
  return Array.from(w.element.querySelectorAll("input.grid-input:not([readonly])")) as HTMLInputElement[];
}

describe("EmulatorPane フィールド移動（Tab / 矢印）", () => {
  beforeEach(() => seed([field(1, 5), field(2, 6), field(3, 7)]));

  function mountPane() {
    return mount(EmulatorPane, {
      props: { sessionId: SID, focused: true },
      attachTo: document.body
    });
  }

  it("Tab で次の入力欄にフォーカスが移る", async () => {
    const w = mountPane();
    await nextTick(); // マウント時の自動フォーカスを先に確定させる
    const els = inputs(w);
    expect(els).toHaveLength(3);
    els[0]!.focus();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(els[1]);
    w.unmount();
  });

  it("Shift+Tab で前の入力欄へ、先頭では末尾にラップ", async () => {
    const w = mountPane();
    await nextTick(); // マウント時の自動フォーカスを先に確定させる
    const els = inputs(w);
    els[0]!.focus();
    await w.find(".pane").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(els[2]); // ラップ
    w.unmount();
  });

  it("ArrowDown で下の行のフィールドへ、ArrowUp で上へ", async () => {
    const w = mountPane();
    await nextTick(); // マウント時の自動フォーカスを先に確定させる
    const els = inputs(w);
    els[0]!.focus(); // row 5
    await w.find(".pane").trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(els[1]); // row 6
    await w.find(".pane").trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).toBe(els[0]); // row 5
    w.unmount();
  });

  it("保護フィールドは移動対象から除外される", async () => {
    seed([field(1, 5), field(2, 6, true), field(3, 7)]); // 中央は保護
    const w = mountPane();
    await nextTick(); // マウント時の自動フォーカスを先に確定させる
    const els = inputs(w);
    expect(els).toHaveLength(2); // 非保護のみ
    els[0]!.focus();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(els[1]); // 保護をスキップ
    w.unmount();
  });

  it("Home/End で最初/最後の入力欄へ（欄外＝ペインにフォーカス時）", async () => {
    const w = mountPane();
    await nextTick(); // マウント時の自動フォーカスを先に確定させる
    const els = inputs(w);
    (w.find(".pane").element as HTMLElement).focus();
    await w.find(".pane").trigger("keydown", { key: "End" });
    expect(document.activeElement).toBe(els[2]);
    await w.find(".pane").trigger("keydown", { key: "Home" });
    expect(document.activeElement).toBe(els[0]);
    w.unmount();
  });

  it("下カーソルは桁を保ち真下のセルへ（同桁にフィールドがあればそこへ・次項目先頭に飛ばない）", async () => {
    // row5: ソース欄(col10) / row6: 行番号欄(col2)＋ソース欄(col10)
    const src5: Field = { index: 1, row: 5, col: 10, length: 20, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    const seq6: Field = { index: 2, row: 6, col: 2, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    const src6: Field = { index: 3, row: 6, col: 10, length: 20, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    seed([src5, seq6, src6]);
    const w = mountPane();
    await nextTick();
    const els = inputs(w); // [src5, seq6, src6]（画面順）
    els[0]!.focus(); // row5 ソース欄（col10）→ 論理カーソル (5,10)
    els[0]!.setSelectionRange(0, 0);
    await w.find(".pane").trigger("keydown", { key: "ArrowDown" });
    // 同桁 (6,10) は src6(=els[2])。行番号欄(seq6=els[1]) には飛ばない
    expect(document.activeElement).toBe(els[2]);
    w.unmount();
  });
});

describe("EmulatorPane 自由カーソル（非入力セルへの移動）", () => {
  function seedWithSend(fields: Field[]): ReturnType<typeof vi.fn> {
    const send = vi.fn();
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID,
      label: "t",
      snapshot: snap(fields),
      edits: new Map(),
      cursor: { row: 1, col: 1 },
      connected: true,
      readOnly: false,
      client: { send } as unknown as WsClient
    });
    return send;
  }

  function mountPane() {
    return mount(EmulatorPane, {
      props: { sessionId: SID, focused: true },
      attachTo: document.body
    });
  }

  it("free モードで Shift+矢印がブロック選択を作り Escape で解除する（キーボード矩形選択）", async () => {
    seed([]); // 入力欄なし → free モード（ペインにフォーカス）
    const w = mountPane();
    await nextTick();
    (w.find(".pane").element as HTMLElement).focus();
    await w.find(".pane").trigger("keydown", { key: "ArrowRight", shiftKey: true });
    await w.find(".pane").trigger("keydown", { key: "ArrowDown", shiftKey: true });
    await nextTick();
    expect(w.find(".rect-sel").exists()).toBe(true); // 矩形選択のハイライトが出る
    await w.find(".pane").trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(w.find(".rect-sel").exists()).toBe(false); // Escape で解除
    w.unmount();
  });

  it("入力欄フォーカス中でも Shift+矢印はブロック選択になる（欄内テキスト選択ではない）", async () => {
    seed([field(1, 5)]); // 欄 (5,10) len5
    const w = mountPane();
    await nextTick();
    const input = w.find("input.grid-input");
    (input.element as HTMLElement).focus();
    await nextTick();
    await input.trigger("keydown", { key: "ArrowRight", shiftKey: true });
    await nextTick();
    expect(w.find(".rect-sel").exists()).toBe(true); // 画面の矩形選択が出る
    expect(document.activeElement).not.toBe(input.element); // 入力欄は blur され free モードへ
    w.unmount();
  });

  it("Shift+矢印で範囲を広げてもカーソルは動かない（ACS 相当。動くのは選択端だけ）", async () => {
    seed([]); // 入力欄なし → free モード。カーソルは (1,1)
    const w = mountPane();
    await nextTick();
    (w.find(".pane").element as HTMLElement).focus();
    const cursorStyle = () => w.find(".cursor").attributes("style");
    expect(cursorStyle()).toContain("0ch"); // 始点 (1,1) → 0ch
    await w.find(".pane").trigger("keydown", { key: "ArrowRight", shiftKey: true });
    await w.find(".pane").trigger("keydown", { key: "ArrowRight", shiftKey: true });
    await w.find(".pane").trigger("keydown", { key: "ArrowDown", shiftKey: true });
    await nextTick();
    // 旧: カーソルが選択端へ移動していた（→ AID キーで選択端の座標がホストへ飛ぶ）
    expect(cursorStyle()).toContain("0ch"); // カーソルは始点のまま
    // 選択端は 2 回ぶん進んでいる（基点にカーソルを使うと 1 桁で頭打ちになる）
    const sel = w.find(".rect-sel");
    expect(sel.exists()).toBe(true);
    expect(sel.attributes("style")).toContain("3ch"); // (1,1)-(2,3) → 幅 3ch
    w.unmount();
  });

  it("Shift+矢印で戻すと選択が縮む（アンカーは始点に固定）", async () => {
    seed([]);
    const w = mountPane();
    await nextTick();
    (w.find(".pane").element as HTMLElement).focus();
    const pane = w.find(".pane");
    await pane.trigger("keydown", { key: "ArrowRight", shiftKey: true });
    await pane.trigger("keydown", { key: "ArrowRight", shiftKey: true });
    await nextTick();
    expect(w.find(".rect-sel").attributes("style")).toContain("3ch"); // (1,1)-(1,3)
    await pane.trigger("keydown", { key: "ArrowLeft", shiftKey: true });
    await nextTick();
    expect(w.find(".rect-sel").attributes("style")).toContain("2ch"); // (1,1)-(1,2) へ縮む
    w.unmount();
  });

  it("DBCS 欄の矢印カーソルが reconcileFocus に壊されず列ビュー caret を維持する（回帰）", async () => {
    // "あいう" を持つ DBCS 欄。列ビュー " あいう "。矢印は 1 論理文字ずつ移動し SO/SI をスキップ。
    // 旧: ScreenGrid の emit("cursor") → reconcileFocus が SBCS 用 caretInField で caret を上書きし、
    // → が 2 文字進む・← が効かない、という不具合になっていた。
    const dbcs: Field = {
      index: 1, row: 5, col: 10, length: 16, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: ""
    };
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID,
      label: "t",
      snapshot: snap([dbcs]),
      edits: new Map([[1, "あいう"]]),
      cursor: { row: 5, col: 10 },
      connected: true,
      readOnly: false,
      client: { send: () => {} } as unknown as WsClient
    });
    const w = mountPane();
    await nextTick();
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    expect(el.value.replace(/ +$/, "")).toBe(" あいう"); // 列ビュー（SO/SI がスペース。末尾は欄長までパディング）
    expect(el.selectionStart).toBe(1); // あ の前（SO=桁0 をスキップ）
    await input.trigger("keydown", { key: "ArrowRight" });
    expect(el.selectionStart).toBe(2); // い の前（1 論理文字・reconcileFocus に壊されない）
    await input.trigger("keydown", { key: "ArrowRight" });
    expect(el.selectionStart).toBe(3); // う の前
    await input.trigger("keydown", { key: "ArrowLeft" });
    expect(el.selectionStart).toBe(2); // い の前へ戻る（← が効く）
    await input.trigger("keydown", { key: "ArrowLeft" });
    expect(el.selectionStart).toBe(1); // あ の前
    w.unmount();
  });

  it("入力欄から左へ出るとフィールドが blur され、ペインにフォーカスが移る（free モード）", async () => {
    // col10 len5 の欄。左端(caret0)で ArrowLeft を押すと欄外(col9)へ抜ける
    seed([field(1, 5)]);
    const w = mountPane();
    await nextTick();
    const els = inputs(w);
    els[0]!.focus();
    els[0]!.setSelectionRange(0, 0); // 左端 → 論理カーソル (5,10)
    // 左端の ArrowLeft は ScreenGrid が stopPropagation せずペインへ委譲する（ペインで駆動して確認）
    await w.find(".pane").trigger("keydown", { key: "ArrowLeft" });
    expect(document.activeElement).not.toBe(els[0]); // (5,9) は非入力 → blur
    expect(document.activeElement).toBe(w.find(".pane").element); // キーボード捕捉のためペインへ
    w.unmount();
  });

  it("入力欄は末尾（最終文字の後ろ）に止まれ、さらに ArrowRight で右隣セルへ出る（回帰）", async () => {
    // length 3 の欄。桁 0,1,2 がセル、3 が末尾（最終文字の後ろ）。末尾に止まれることでフルケタでも
    // Backspace で最終文字を消せる（旧: 最終桁 2 で即欄外へ出て末尾に止まれなかった）。
    const f: Field = { index: 1, row: 5, col: 10, length: 3, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    seed([f]);
    const w = mountPane();
    await nextTick();
    const els = inputs(w);
    els[0]!.focus();
    els[0]!.setSelectionRange(0, 0);
    const input = w.find("input.grid-input");
    await input.trigger("keydown", { key: "ArrowRight" }); // 0→1
    await input.trigger("keydown", { key: "ArrowRight" }); // 1→2（最終桁）
    await input.trigger("keydown", { key: "ArrowRight" }); // 2→3（末尾）
    expect(document.activeElement).toBe(els[0]); // 末尾でもまだ欄内
    expect(els[0]!.selectionStart).toBe(3); // native キャレットも末尾
    await input.trigger("keydown", { key: "ArrowRight" }); // 末尾でさらに右 → 欄外へ委譲
    expect(document.activeElement).not.toBe(els[0]); // 右隣の非入力セルへ出て blur
    w.unmount();
  });

  it("欄を最大桁まで入力すると次の入力欄へフォーカスが移る（ACS 自動送り）", async () => {
    const f1: Field = { index: 1, row: 5, col: 10, length: 3, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    const f2: Field = { index: 2, row: 6, col: 10, length: 3, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    seed([f1, f2]);
    const w = mountPane();
    await nextTick();
    const els = inputs(w);
    els[0]!.focus();
    els[0]!.setSelectionRange(0, 0);
    const input = w.find("input.grid-input");
    await input.trigger("keydown", { key: "A" });
    await input.trigger("keydown", { key: "B" });
    expect(document.activeElement).toBe(els[0]); // 3 桁目未入力＝まだ欄内
    await input.trigger("keydown", { key: "C" }); // 最大桁を入力＝満杯
    expect(document.activeElement).toBe(els[1]); // 次の入力欄へ自動送り
    w.unmount();
  });

  it("非入力セルから矢印で編集可欄セルに入ると、その欄へ focus（field モードへ復帰）", async () => {
    seed([field(1, 5)]); // (5,10) len5
    const w = mountPane();
    await nextTick();
    const els = inputs(w);
    els[0]!.focus(); // 論理カーソル (5,10)
    await w.find(".pane").trigger("keydown", { key: "ArrowUp" }); // (5,10)→(4,10) 非入力→blur
    expect(document.activeElement).toBe(w.find(".pane").element);
    await w.find(".pane").trigger("keydown", { key: "ArrowDown" }); // (4,10)→(5,10) 欄内→focus
    expect(document.activeElement).toBe(els[0]);
    w.unmount();
  });

  it("AID 送信に有効カーソル（矢印で移した非入力位置）が載る", async () => {
    const send = seedWithSend([field(1, 5)]); // (5,10) len5
    const w = mountPane();
    await nextTick();
    const els = inputs(w);
    els[0]!.focus(); // 論理カーソル (5,10)
    await w.find(".pane").trigger("keydown", { key: "ArrowUp" }); // (4,10) 非入力へ
    await w.find(".pane").trigger("keydown", { key: "F3" });
    const keyMsg = send.mock.calls.map((c) => c[0]).find((m) => m.type === "key" && m.key === "F3");
    expect(keyMsg).toMatchObject({ type: "key", key: "F3", cursor: { row: 4, col: 10 } });
    w.unmount();
  });

  it("欄の非先頭桁へ矢印で入っても論理カーソルが桁を保つ（AID に反映・R1-1 回帰）", async () => {
    // src5(5,10,len20) の col12 から ArrowDown → dst6(6,10,len8) の col12 へ入る
    const src5: Field = { index: 1, row: 5, col: 10, length: 20, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    const dst6: Field = { index: 2, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    const send = seedWithSend([src5, dst6]);
    const w = mountPane();
    await nextTick();
    const els = inputs(w); // [src5, dst6]
    els[0]!.focus();
    els[0]!.setSelectionRange(2, 2); // caret 桁 col12
    await w.findAll("input.grid-input")[0]!.trigger("click"); // onInputClick → 論理カーソル (5,12)
    await w.find(".pane").trigger("keydown", { key: "ArrowDown" }); // (5,12)→(6,12) dst6 内へ
    expect(document.activeElement).toBe(els[1]); // 真下の欄へ focus
    await w.find(".pane").trigger("keydown", { key: "F3" });
    const keyMsg = send.mock.calls.map((c) => c[0]).find((m) => m.type === "key" && m.key === "F3");
    // 欄先頭 (6,10) に巻き戻らず、桁を保った (6,12) が載る
    expect(keyMsg).toMatchObject({ type: "key", key: "F3", cursor: { row: 6, col: 12 } });
    w.unmount();
  });

  it("DBCS 全角文字を跨いで右移動できる（lead で ArrowRight が tail を飛び越す・R1-2 回帰）", async () => {
    // フィールド無し（free モード）。(3,20)=dbcs-lead / (3,21)=dbcs-tail。初期カーソルを lead に置く
    const send = vi.fn();
    const s = snap([]);
    s.cursor = { row: 3, col: 20 };
    s.cells[2]![19] = { ...s.cells[2]![19]!, kind: "dbcs-lead", char: "日" };
    s.cells[2]![20] = { ...s.cells[2]![20]!, kind: "dbcs-tail", char: "" };
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID,
      label: "t",
      snapshot: s,
      edits: new Map(),
      cursor: { row: 1, col: 1 },
      connected: true,
      readOnly: false,
      client: { send } as unknown as WsClient
    });
    const w = mountPane();
    await nextTick();
    (w.find(".pane").element as HTMLElement).focus();
    await w.find(".pane").trigger("keydown", { key: "ArrowRight" }); // (3,20)lead → tail を飛ばして (3,22)
    await w.find(".pane").trigger("keydown", { key: "F3" });
    const keyMsg = send.mock.calls.map((c) => c[0]).find((m) => m.type === "key" && m.key === "F3");
    expect(keyMsg).toMatchObject({ type: "key", key: "F3", cursor: { row: 3, col: 22 } });
    w.unmount();
  });

  it("Ctrl+→/← で画面上の次/前の語頭へ自由カーソルが飛ぶ（ACS 頭出し・欄外テキストも対象）", async () => {
    // フィールド無し。row1 = "TEXT1  TEXT2"（桁1-5=TEXT1, 桁8-12=TEXT2）。初期カーソル (1,1)
    const s = snap([]);
    const put = (r: number, c0: number, text: string): void => {
      [...text].forEach((ch, i) => (s.cells[r]![c0 + i] = { ...s.cells[r]![c0 + i]!, char: ch }));
    };
    put(0, 0, "TEXT1");
    put(0, 7, "TEXT2");
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID,
      label: "t",
      snapshot: s,
      edits: new Map(),
      cursor: { row: 1, col: 1 },
      connected: true,
      readOnly: false,
      client: {} as WsClient
    });
    const w = mountPane();
    await nextTick();
    (w.find(".pane").element as HTMLElement).focus();
    // 自由カーソルのオーバーレイ位置で観測（left=(col-1)ch）。欄外なので .cursor が描画される
    // (1,1)=TEXT1 の T（語頭）から Ctrl+→ → 次の語 TEXT2 の頭（1,8）= left 7ch
    await w.find(".pane").trigger("keydown", { key: "ArrowRight", ctrlKey: true });
    await nextTick();
    expect(w.find(".cursor").attributes("style")).toContain("left: 7ch");
    // Ctrl+← で TEXT1 の頭（1,1）= left 0ch へ戻る
    await w.find(".pane").trigger("keydown", { key: "ArrowLeft", ctrlKey: true });
    await nextTick();
    expect(w.find(".cursor").attributes("style")).toContain("left: 0ch");
    w.unmount();
  });
});
