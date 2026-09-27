import { describe, it, expect, vi, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import type { Cell, Field } from "@ts5250/tn5250";
import { snapToInput, type ArrowDir } from "../src/composables/csrInputOnly.js";

/**
 * **SOH の CSRINPONLY（フラグ 0x10）: 矢印で入力欄の外へ出たら入力欄へ寄せる**（ACS `FFT5250.moveCursorToInput`。`20260927-key-edit-rest`）。
 * 期待値は実機の ACS のコア（`scripts/acs-probe/csr-input-only.txt`。入力欄 5,10・5,40・9,20〔6 桁〕）で測った位置
 */
const cell = (): Cell => ({ char: " ", kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;
const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: 80 }, cell));
const fld = (index: number, row: number, col: number): Field =>
  ({ index, row, col, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "" }) as Field;
const fields = [fld(1, 5, 10), fld(2, 5, 40), fld(3, 9, 20)];
/** ACS と同じく、矢印で 1 桁動いた先（`at`）から寄せる */
const snap = (dir: ArrowDir, row: number, col: number) => snapToInput(dir, { row, col }, fields, cells, 24, 80);

describe("CSRINPONLY の寄せ方（ACS の実測）", () => {
  it("右: 欄の最後の桁の右（5,16）→ 次の入力欄 5,40", () => expect(snap("right", 5, 16)).toEqual({ row: 5, col: 40 }));
  it("左: 5,40 の左（5,39）→ 5,15（同じ行のいちばん右の入力桁）", () => expect(snap("left", 5, 39)).toEqual({ row: 5, col: 15 }));
  it("下: 5,15 の下（6,15）→ 9,20（入力欄のある行まで下りる）", () => expect(snap("down", 6, 15)).toEqual({ row: 9, col: 20 }));
  it("**上: 9,20 の上（8,20）→ 5,40**（番地の差で比べるので、近い 5,15 ではなく右が選ばれる）", () =>
    expect(snap("up", 8, 20)).toEqual({ row: 5, col: 40 }));
  it("右: 最後の入力欄の外（9,26）→ 先頭の 5,10 へ巡回", () => expect(snap("right", 9, 26)).toEqual({ row: 5, col: 10 }));
  it("下: 5,26 の下（6,26）→ 9,25（その行の左の候補だけ）", () => expect(snap("down", 6, 26)).toEqual({ row: 9, col: 25 }));
  it("入力欄の中に着いたらそのまま", () => expect(snap("right", 5, 12)).toEqual({ row: 5, col: 12 }));
  it("保護された欄は入力欄に数えない", () => {
    const prot = [{ ...fld(1, 5, 10), protected: true }, fld(2, 5, 40)];
    expect(snapToInput("right", { row: 5, col: 11 }, prot, cells, 24, 80)).toEqual({ row: 5, col: 40 });
  });
});

describe("ペインの矢印（配線）", () => {
  afterEach(() => { document.body.innerHTML = ""; });
  function seed(cursorInputOnly: boolean): void {
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    const s = { sessionId: "ci", rows: 24, cols: 80, cursor: { row: 5, col: 16 }, keyboardLocked: false, cells, fields,
      ...(cursorInputOnly ? { cursorInputOnly: true } : {}) } as ScreenSnapshot;
    sessionsStore.add({ sessionId: "ci", label: "t", snapshot: s, edits: new Map(), cursor: s.cursor, link: { state: "connected" },
      resumability: "resumable", readOnly: false, client: { send: vi.fn() } as unknown as WsClient });
  }
  /** 欄の外（5,16）でペインに → を送る */
  async function rightOutside(): Promise<string | undefined> {
    const w = mount(EmulatorPane, { props: { sessionId: "ci", focused: true }, attachTo: document.body });
    await nextTick();
    (w.find(".pane").element as HTMLElement).focus();
    await w.find(".pane").trigger("keydown", { key: "ArrowRight" });
    await nextTick();
    const idx = (document.activeElement as HTMLElement | null)?.dataset["fieldIndex"];
    w.unmount();
    return idx;
  }
  it("**CSRINPONLY なら欄の外からの → で次の入力欄（5,40）へ**", async () => {
    seed(true);
    expect(await rightOutside(), "5,40 の欄").toBe("2");
  });
  it("立っていなければ従来どおり 1 桁（5,17＝欄の外。対照）", async () => {
    seed(false);
    expect(await rightOutside()).toBeUndefined();
  });
});
