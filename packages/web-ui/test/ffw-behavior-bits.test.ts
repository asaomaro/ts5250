import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { rejectReason } from "../src/composables/fieldValidate.js";
import { findMandatoryViolation } from "../src/composables/mandatoryCheck.js";
import { MSG_BY_REASON, MSG_MANDATORY_ENTER, MSG_MANDATORY_FILL } from "../src/composables/opMessages.js";
import type { Cell, Field, ScreenSnapshot } from "@as400web/core";
import type { WsClient } from "../src/ws-client.js";

/**
 * **FFW の挙動ビットに従う。**
 *
 * ホストは FFW で「この欄をどう扱え」と指示してくるが、定義だけあって参照ゼロのビットが
 * 残っていた。実装の根拠は 2 本立て:
 *
 * - **原典**: GNU tn5250 `display.c` / `field.c` と tn5250j `Screen5250.java`
 * - **実測**: 実機 / IBM i 7.5（2026-07-29）。`scripts/research-ffw.mjs`
 *
 * とくに次の 2 つは実測でしか出てこなかった:
 *
 * 1. **MONOCASE は既定で立つ**（DDS の文字欄は `CHECK(LC)` を書かない限り載る）
 * 2. **ホストは CHECK(ME) / CHECK(MF) を検証しない**（空・部分入力のまま Enter が素通りした）
 *    ＝端末が止めなければ誰も止めない
 */

const COLS = 80;

function cell(char = " "): Cell {
  return { char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}

function fld(over: Partial<Field> & { index: number; row: number; col: number; length: number }): Field {
  return {
    protected: false, hidden: false, numeric: false, mdt: false, value: "", ...over
  } as Field;
}

function snapOf(fields: Field[], cursor = { row: 5, col: 10 }): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) row.push(cell());
    cells.push(row);
  }
  for (const f of fields) {
    [...f.value].forEach((ch, i) => (cells[f.row - 1]![f.col - 1 + i] = cell(ch)));
  }
  return { sessionId: "s", rows: 24, cols: COLS, cursor, keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}

// ---------------------------------------------------------------------------
// 純ロジック
// ---------------------------------------------------------------------------

describe("打鍵時の型フィルタ（シフト種別）", () => {
  const base = { index: 1, row: 5, col: 10, length: 6 };

  it("alpha-only（DDS の X）は英字・`,`・`.`・`-`・空白を通し、数字を弾く", () => {
    const f = fld({ ...base, alphaOnly: true });
    for (const ch of ["A", "z", ",", ".", "-", " "]) {
      expect(rejectReason(f, ch), ch).toBeUndefined();
    }
    expect(rejectReason(f, "1")).toBe("alpha-only");
    expect(rejectReason(f, "#")).toBe("alpha-only");
  });

  it("キーボード入力不可（DDS の I）は**何を打っても**弾く", () => {
    const f = fld({ ...base, keyboardInhibited: true });
    for (const ch of ["A", "1", " ", "あ"]) {
      expect(rejectReason(f, ch), ch).toBe("kbd-inhibited");
    }
  });

  it("**カタカナシフトは制限ではない**（何も弾かない）", () => {
    // 参照実装 2 つとも素通し。制限だと誤解して実装しないよう固定する
    const f = fld(base); // katakana は Field に印を作っていない＝制限が無いことの表明
    for (const ch of ["A", "1", "#"]) expect(rejectReason(f, ch), ch).toBeUndefined();
  });

  it("弾いた理由には日本語の操作員メッセージがある", () => {
    expect(MSG_BY_REASON["alpha-only"]).toBeTruthy();
    expect(MSG_BY_REASON["kbd-inhibited"]).toBeTruthy();
  });
});

describe("送信前の必須検証（MANDATORY_ENTER / MANDATORY_FILL）", () => {
  const noEdits = new Map<number, string>();

  it("MANDATORY_ENTER 欄が空なら違反", () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 6, mandatoryEnter: true });
    expect(findMandatoryViolation([f], noEdits)).toEqual({ field: f, reason: "mandatory-enter" });
  });

  it("MANDATORY_ENTER 欄に値があれば通る（未送信の編集を優先して見る）", () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 6, mandatoryEnter: true });
    expect(findMandatoryViolation([f], new Map([[1, "A"]]))).toBeUndefined();
  });

  it("空白だけは「空」扱い", () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 6, mandatoryEnter: true });
    expect(findMandatoryViolation([f], new Map([[1, "   "]]))?.reason).toBe("mandatory-enter");
  });

  it("MANDATORY_FILL は**部分入力だけ**を弾く（空は通す）", () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 6, adjust: "mandatory-fill" });
    expect(findMandatoryViolation([f], noEdits), "空は通る").toBeUndefined();
    expect(findMandatoryViolation([f], new Map([[1, "12"]]))?.reason).toBe("mandatory-fill");
    expect(findMandatoryViolation([f], new Map([[1, "123456"]])), "満杯は通る").toBeUndefined();
  });

  it("MANDATORY_FILL の桁数は**送信バイト長**で見る（DBCS 欄）", () => {
    // length=6 は SO(1)+全角2×2(4)+SI(1) のバイト予算。全角 2 文字で満杯
    const f = fld({ index: 1, row: 5, col: 10, length: 6, adjust: "mandatory-fill", dbcsType: "open" });
    expect(findMandatoryViolation([f], new Map([[1, "あ"]]))?.reason, "全角1つでは足りない").toBe("mandatory-fill");
    expect(findMandatoryViolation([f], new Map([[1, "あい"]])), "全角2つで満杯").toBeUndefined();
  });

  it("保護欄は検査しない", () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 6, mandatoryEnter: true, protected: true });
    expect(findMandatoryViolation([f], noEdits)).toBeUndefined();
  });

  it("**非表示欄で未編集のものは検査しない**（値を持てないので判定できない）", () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 6, mandatoryEnter: true, hidden: true });
    expect(findMandatoryViolation([f], noEdits)).toBeUndefined();
    // 打ってあれば edits から見える
    expect(findMandatoryViolation([f], new Map([[1, "  "]]))?.reason).toBe("mandatory-enter");
  });

  it("画面順で最初の違反を返す", () => {
    const a = fld({ index: 1, row: 5, col: 10, length: 6, adjust: "mandatory-fill" });
    const b = fld({ index: 2, row: 6, col: 10, length: 6, mandatoryEnter: true });
    expect(findMandatoryViolation([a, b], new Map([[1, "12"]]))?.field.index).toBe(1);
    expect(findMandatoryViolation([a, b], new Map([[1, "123456"]]))?.field.index).toBe(2);
  });

  it("指定の無い欄は空でも通る", () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 6 });
    expect(findMandatoryViolation([f], noEdits)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ScreenGrid（打鍵時の作法）
// ---------------------------------------------------------------------------

describe("ScreenGrid: MONOCASE / FER / AUTO_ENTER", () => {
  beforeEach(() => document.body.replaceChildren());

  function mountGrid(fields: Field[], uppercaseInput = false) {
    return mount(ScreenGrid, {
      props: { snapshot: snapOf(fields), edits: new Map(), focused: true, busy: false,
        cursor: { row: 5, col: 10 }, uppercaseInput },
      attachTo: document.body
    });
  }
  const firstInput = (w: ReturnType<typeof mountGrid>) =>
    w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;

  async function type(el: HTMLInputElement, s: string) {
    for (const ch of s) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
      await nextTick();
    }
  }
  /** 最後に emit された編集値 */
  const lastEdit = (w: ReturnType<typeof mountGrid>) => {
    const e = w.emitted("edit") as unknown[][] | undefined;
    return e ? (e[e.length - 1]![1] as string) : undefined;
  };

  it("MONOCASE 欄では英小文字が大文字になる", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 5, monocase: true })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, "abc");
    expect(lastEdit(w)).toBe("ABC");
    w.unmount();
  });

  it("**MONOCASE でない欄（CHECK(LC)）では小文字が残る**", async () => {
    // ここが崩れると「全欄大文字化」と区別がつかない＝欄単位で見ている意味が消える
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 5 })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, "abc");
    expect(lastEdit(w)).toBe("abc");
    w.unmount();
  });

  it("カタカナ系 CCSID では MONOCASE が無くても大文字になる（別の理由なので併存する）", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 5 })], true);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, "abc");
    expect(lastEdit(w)).toBe("ABC");
    w.unmount();
  });

  it("FER 欄では満杯でも field-full を出さない（自動送りしない）", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 3, fieldExitRequired: true })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, "ABC");
    expect(w.emitted("field-full")).toBeUndefined();
    expect(w.emitted("aid")).toBeUndefined();
    w.unmount();
  });

  it("FER でない欄は従来どおり満杯で field-full を出す", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 3 })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, "ABC");
    expect(w.emitted("field-full")).toBeTruthy();
    w.unmount();
  });

  it("AUTO_ENTER 欄は満杯で Enter を送る（次欄へは送らない）", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 3, autoEnter: true })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, "ABC");
    expect(w.emitted("aid")).toEqual([["Enter"]]);
    expect(w.emitted("field-full")).toBeUndefined();
    w.unmount();
  });

  it("FER と AUTO_ENTER が同時なら FER が勝つ（原典も FER の枝で auto-enter を見ない）", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 3, autoEnter: true, fieldExitRequired: true })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, "ABC");
    expect(w.emitted("aid")).toBeUndefined();
    expect(w.emitted("field-full")).toBeUndefined();
    w.unmount();
  });
});

// ---------------------------------------------------------------------------
// EmulatorPane（送信を止めるかどうか）
// ---------------------------------------------------------------------------

describe("EmulatorPane: 必須検証は Enter のときだけ", () => {
  const SID = "s1";
  let sent: unknown[] = [];
  let mounted: ReturnType<typeof mount>[] = [];

  function seed(fields: Field[]): void {
    sent = [];
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID,
      label: "t",
      snapshot: snapOf(fields),
      edits: new Map(),
      cursor: { row: 5, col: 10 },
      connected: true,
      readOnly: false,
      // **在席の合図（`activity`）は数えない。** 打鍵のたびに WS へ流れるが、これは
      // サーバーのアイドル判定用でホストへは行かない（`20260729-session-lifetime-timeout`）。
      // ここで見たいのは「ホストへ送ってしまっていないか」なので、合図は除いて集める
      client: {
        send: (m: unknown) => {
          if ((m as { type?: string }).type !== "activity") sent.push(m);
        }
      } as unknown as WsClient
    });
  }
  function mountPane() {
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    mounted.push(w);
    return w;
  }
  const statusText = (w: ReturnType<typeof mountPane>) => w.findComponent({ name: "StatusBar" }).text();

  beforeEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });
  afterEach(() => {
    for (const w of mounted) w.unmount();
    mounted = [];
    document.body.innerHTML = "";
  });

  it("MANDATORY_ENTER 欄が空だと Enter を送らずメッセージを出す", async () => {
    seed([fld({ index: 1, row: 5, col: 10, length: 5, mandatoryEnter: true })]);
    const w = mountPane();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Enter" });
    expect(sent, "ホストへ送ってしまっている").toEqual([]);
    expect(statusText(w)).toContain(MSG_MANDATORY_ENTER);
  });

  it("MANDATORY_FILL 欄が部分入力だと Enter を送らずメッセージを出す", async () => {
    seed([fld({ index: 1, row: 5, col: 10, length: 5, adjust: "mandatory-fill" })]);
    sessionsStore.get(SID)!.edits.set(1, "12");
    const w = mountPane();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Enter" });
    expect(sent).toEqual([]);
    expect(statusText(w)).toContain(MSG_MANDATORY_FILL);
  });

  it("**F3 は止めない**（必須欄が空でも画面から出られる）", async () => {
    // 止めると必須欄が空の画面から抜けられなくなり利用者が詰む。
    // ホストはこの検証をしないので、こちらが止めれば本当に止まる
    seed([fld({ index: 1, row: 5, col: 10, length: 5, mandatoryEnter: true })]);
    const w = mountPane();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "F3" });
    expect(sent, "F3 が送られていない").toHaveLength(1);
    expect(statusText(w)).not.toContain(MSG_MANDATORY_ENTER);
  });

  it("条件を満たしていれば Enter は通る", async () => {
    seed([fld({ index: 1, row: 5, col: 10, length: 5, mandatoryEnter: true, value: "ABC" })]);
    const w = mountPane();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Enter" });
    expect(sent).toHaveLength(1);
  });

  it("指定の無い画面では素通しする（回帰の確認）", async () => {
    seed([fld({ index: 1, row: 5, col: 10, length: 5 })]);
    const w = mountPane();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Enter" });
    expect(sent).toHaveLength(1);
  });

  /**
   * **OIA の「⏎ 実行」ボタンは `EmulatorPane.onAid` を通らず `sendKey` を直に呼ぶ**
   * （`StatusBar.vue:62`）。最初は判定を `onAid` に置いたため、キーボードでは止まるのに
   * ボタンでは素通りしていた——**単体テストでは見えず、実機のブラウザ検証で初めて出た**。
   * 判定を `sendKey`（全送信経路の合流点）へ移したので、その経路を直接固定する。
   */
  describe("送信経路が複数あることの回帰（OIA ボタン相当）", () => {
    it("sendKey を直に呼んでも Enter は止まる", async () => {
      seed([fld({ index: 1, row: 5, col: 10, length: 5, mandatoryEnter: true })]);
      const { sendKey } = await import("../src/session-controller.js");
      const hit = sendKey(SID, "Enter", { row: 5, col: 10 });
      expect(sent, "ボタン経由でホストへ抜けている").toEqual([]);
      expect(hit?.reason).toBe("mandatory-enter");
      expect(sessionsStore.get(SID)!.notice).toBe(MSG_MANDATORY_ENTER);
    });

    it("sendKey を直に呼んだ F3 は止まらない", async () => {
      seed([fld({ index: 1, row: 5, col: 10, length: 5, mandatoryEnter: true })]);
      const { sendKey } = await import("../src/session-controller.js");
      expect(sendKey(SID, "F3", { row: 5, col: 10 })).toBeUndefined();
      expect(sent).toHaveLength(1);
    });
  });
});
