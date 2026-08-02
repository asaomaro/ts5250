import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@as400web/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { MSG_PROTECTED } from "../src/composables/opMessages.js";

/**
 * **操作員メッセージの行**（`20260802-message-line`）。
 *
 * ACS は**ホスト側もクライアント側もエミュレータ画面の最下行**に出す。以前はステータスバー
 * （画面の外）に出していたので、同じ性質のものが 2 か所に散っていた。
 *
 * ここで守るのは 2 点:
 *
 * 1. **画面の中（`.grid` の中）に出る**——外に置くと font-size が画面と揃わず、
 *    画面が拡縮されたときに字だけ取り残される
 * 2. **クライアント側がホスト側を隠し、消えれば戻る**（ACS の同居のしかた）
 */
const SID = "s1";

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

function snap(opts: { systemMessage?: string } = {}): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  // 入力欄を 1 つ置く（欄の無い画面はペインが別の経路を通るため）
  const fields: Field[] = [
    { index: 1, row: 5, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
  ];
  return {
    sessionId: SID,
    rows: 24,
    cols: 80,
    cursor: { row: 10, col: 1 },
    keyboardLocked: false,
    cells,
    fields,
    ...(opts.systemMessage !== undefined ? { systemMessage: opts.systemMessage } : {})
  } as ScreenSnapshot;
}

function seed(s: ScreenSnapshot): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID,
    label: "t",
    snapshot: s,
    edits: new Map(),
    cursor: s.cursor,
    connected: true,
    readOnly: false,
    client: { send: () => {} } as unknown as WsClient
  });
}

const mountPane = () =>
  mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });

/**
 * 欄の外（保護領域）へカーソルを出す。**マウント時は入力欄に focus が入る**ので、
 * ここを踏まないと打鍵が欄に届いてしまい、クライアント側のメッセージが出ない
 * （`pane-protected-input.test.ts` と同じ前提）。
 */
async function moveOutOfField(w: ReturnType<typeof mountPane>): Promise<void> {
  await w.find(".pane").trigger("keydown", { key: "ArrowDown" });
  await nextTick();
}

/** 操作員メッセージの行（無ければ空文字） */
const line = (w: ReturnType<typeof mountPane>): string =>
  w.find(".opmsg").exists() ? w.find(".opmsg").text() : "";

beforeEach(() => seed(snap()));

describe("置き場所", () => {
  it("**画面（`.grid`）の中に出る**（外に置くと字の大きさが画面と揃わない）", async () => {
    seed(snap({ systemMessage: "HOST MSG" }));
    const w = mountPane();
    await nextTick();
    expect(w.find(".grid .opmsg").exists()).toBe(true);
  });

  it("**ステータスバーには出さない**（同じ性質のものを 2 か所に散らさない）", async () => {
    seed(snap({ systemMessage: "HOST MSG" }));
    const w = mountPane();
    await nextTick();
    expect(w.findComponent({ name: "StatusBar" }).text()).not.toContain("HOST MSG");
  });
});

describe("ホスト側とクライアント側の同居", () => {
  it("ホスト側だけならそれを出す", async () => {
    seed(snap({ systemMessage: "HOST MSG" }));
    const w = mountPane();
    await nextTick();
    expect(line(w)).toBe("HOST MSG");
  });

  it("**クライアント側がホスト側を隠す**", async () => {
    seed(snap({ systemMessage: "HOST MSG" }));
    const w = mountPane();
    await nextTick();
    // 欄外（保護領域）で文字を打つ＝クライアント側のメッセージ
    await moveOutOfField(w);
    await w.find(".pane").trigger("keydown", { key: "A" });
    expect(line(w)).toBe(MSG_PROTECTED);
    expect(w.text(), "ホスト側が同時に見えている").not.toContain("HOST MSG");
  });

  it("**消えれば元のホスト側へ戻る**（復帰のために状態を持たない）", async () => {
    seed(snap({ systemMessage: "HOST MSG" }));
    const w = mountPane();
    await nextTick();
    await moveOutOfField(w);
    await w.find(".pane").trigger("keydown", { key: "A" });
    expect(line(w)).toBe(MSG_PROTECTED);
    // AID を送るとクライアント側の通知は消える
    await w.find(".pane").trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(line(w)).toBe("HOST MSG");
  });

  it("どちらも無ければ行そのものを出さない（空の帯を残さない）", async () => {
    const w = mountPane();
    await nextTick();
    expect(w.find(".opmsg").exists()).toBe(false);
  });
});
