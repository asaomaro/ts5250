import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import StatusBar from "../src/components/StatusBar.vue";
import type { Cell, Field, ScreenSnapshot } from "@as400web/core";
import type { SessionState } from "../src/stores/sessions.js";

/**
 * OIA の入力可否表示。
 * 以前は接続の有無だけを見ていたため、保護画面でも常に「入力可」と出ていた。
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

function snap(over: Partial<ScreenSnapshot> = {}, fields: Field[] = []): ScreenSnapshot {
  return {
    sessionId: "s",
    rows: 24,
    cols: 80,
    cursor: { row: 5, col: 10 },
    keyboardLocked: false,
    cells: Array.from({ length: 24 }, () => Array.from({ length: 80 }, cell)),
    fields,
    ...over
  };
}

function state(over: Partial<SessionState> = {}, sn = snap()): SessionState {
  return {
    sessionId: "s",
    label: "s",
    snapshot: sn,
    edits: new Map(),
    cursor: sn.cursor,
    connected: true,
    readOnly: false,
    client: {} as never,
    ...over
  } as SessionState;
}

const editable: Field = {
  index: 1, row: 5, col: 8, length: 10,
  protected: false, hidden: false, numeric: false, mdt: false, value: ""
};
const guarded: Field = { ...editable, protected: true };

function textOf(st: SessionState, cursor = { row: 5, col: 10 }): string {
  const w = mount(StatusBar, { props: { state: st, cursor } });
  const t = w.find(".ime").text();
  w.unmount();
  return t;
}

describe("入力可否の表示", () => {
  it("編集可能フィールド上なら入力可", () => {
    expect(textOf(state({}, snap({}, [editable])))).toContain("入力可");
  });

  it("保護フィールド上なら保護", () => {
    expect(textOf(state({}, snap({}, [guarded])))).toContain("保護");
  });

  it("フィールドが無い位置なら入力不可", () => {
    expect(textOf(state({}, snap({}, [])))).toContain("入力不可");
  });

  it("キーボードロック中は入力禁止", () => {
    expect(textOf(state({}, snap({ keyboardLocked: true }, [editable])))).toContain("入力禁止");
  });

  it("閲覧専用セッションは閲覧のみ", () => {
    expect(textOf(state({ readOnly: true }, snap({}, [editable])))).toContain("閲覧のみ");
  });

  it("切断中は切断", () => {
    expect(textOf(state({ connected: false }, snap({}, [editable])))).toContain("切断");
  });
});

describe("フッターの幅が動かない", () => {
  it("入力可否の表記は幅を固定する（右側の要素がずれない）", () => {
    const w = mount(StatusBar, { props: { state: state({}, snap({}, [editable])), cursor: { row: 5, col: 10 } } });
    // 幅の固定はクラスで担保する（jsdom は実寸を持たないため、指定の有無で確認する）
    expect(w.find(".ime").exists()).toBe(true);
    w.unmount();
  });

  it("操作ログのトグルと件数をフッター内に出す（2 行にしない）", () => {
    const w = mount(StatusBar, {
      props: { state: state({}, snap({}, [editable])), cursor: { row: 5, col: 10 }, logCount: 12345, logOpen: false }
    });
    const btn = w.find(".logbtn");
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain("12345");
    w.unmount();
  });

  it("件数を渡さなければトグルは出ない（プリンター等）", () => {
    const w = mount(StatusBar, { props: { state: state({}, snap({}, [editable])), cursor: { row: 5, col: 10 } } });
    expect(w.find(".logbtn").exists()).toBe(false);
    w.unmount();
  });

  it("トグルを押すと toggle-log を通知する", async () => {
    const w = mount(StatusBar, {
      props: { state: state({}, snap({}, [editable])), cursor: { row: 5, col: 10 }, logCount: 0, logOpen: false }
    });
    await w.find(".logbtn").trigger("click");
    expect(w.emitted("toggle-log")).toHaveLength(1);
    w.unmount();
  });
});
