import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { MSG_PROTECTED } from "../src/composables/opMessages.js";
import { viewSettings } from "../src/stores/viewSettings.js";

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

/**
 * **ホスト側の行と同じ形にする**（`20260802-message-line-parity`）。
 *
 * ACS はクライアント側のメッセージも**画面のテキストとして**置くので、全角の前後に SO/SI が
 * 入る。こちらは自前の文字列をそのまま出していたため、`{ }` 表示のときに
 * **印が付かず、開始桁も 1 桁ずれていた**（利用者の指摘）。
 *
 * **SO/SI は印を出さないときも 1 桁を占める**——ここを省くと、ホストの行だけ 1 桁右にずれる。
 */
describe("ホストの行と同じ形にする（SO/SI）", () => {
  /**
   * **`textContent` で読む。** `wrapper.text()` は前後の空白を落とすので、
   * 「SO/SI が 1 桁を占める」という肝心のところが見えない（実際に踏んだ）。
   */
  const raw = (w: ReturnType<typeof mountPane>): string =>
    w.find(".opmsg").element.textContent ?? "";

  /**
   * 先頭の 1 桁は**属性バイトのぶん**（ホストの行は桁 2 から本文が始まる）。
   * SO/SI の検査とは別の話なので、ここで落として本文だけを見る。
   */
  const body = (w: ReturnType<typeof mountPane>): string => raw(w).replace(/^ /, "");

  afterEach(() => viewSettings.set("sosi", false));

  it("**`{ }` 表示のとき、全角の前後に印が付く**（ホストの行と同じ見え方）", async () => {
    viewSettings.set("sosi", true);
    seed(snap({ systemMessage: "あA" }));
    const w = mountPane();
    await nextTick();
    expect(body(w)).toBe("{あ}A");
  });

  it("**印を出さないときも SO/SI の 1 桁は残る**（ホストの行と桁が揃う）", async () => {
    seed(snap({ systemMessage: "あA" }));
    const w = mountPane();
    await nextTick();
    expect(body(w)).toBe(" あ A");
  });

  it("半角だけのメッセージには SO/SI を入れない", async () => {
    seed(snap({ systemMessage: "ABC" }));
    const w = mountPane();
    await nextTick();
    expect(body(w)).toBe("ABC");
  });

  it("全角で終わるメッセージは末尾にも SI が入る", async () => {
    viewSettings.set("sosi", true);
    seed(snap({ systemMessage: "Aあ" }));
    const w = mountPane();
    await nextTick();
    expect(body(w)).toBe("A{あ}");
  });
});

/**
 * **桁 1 は属性バイトぶん空ける**（`20260802-message-line-indent`）。
 *
 * ホストの操作員メッセージ行は桁 1 が属性で、本文は桁 2 から始まる。桁 1 から描くと
 * **ホストの行より 1 桁左にずれる**（利用者の指摘）。ACS も桁 2 から始まる。
 */
describe("行の左端", () => {
  it("**本文は桁 2 から始まる**（桁 1 は属性バイトぶん）", async () => {
    seed(snap({ systemMessage: "ABC" }));
    const w = mountPane();
    await nextTick();
    expect(w.find(".opmsg").element.textContent).toBe(" ABC");
  });
});
