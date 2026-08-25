import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { WsClient } from "../src/ws-client.js";
import { rejectReason, isSignPosition } from "../src/composables/fieldValidate.js";
import { MSG_BY_REASON, wsErrorNotice } from "../src/composables/opMessages.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **打鍵の型規則（実機 `ASAOLIB/AUDPGM` で確かめた 3 件）。**
 *
 * ① 数字専用欄（FFW シフト 5）に `.` `,` `+` `-` 空白が**打ててしまい**、Enter で
 *    core の送信時検証が `FIELD_TYPE` を投げて**1 バイトも飛ばない**——しかも画面には
 *    何も出ないので「Enter が効かない」としか見えなかった。
 * ② その `-` / `+` が Field− / Field+ に化けて、**カーソル以降が消えて次欄へ飛んで**いた。
 * ③ 符号付き数値欄（`6S 0`・欄長 7）の符号桁に数字が打て、画面は `1234567` なのに
 *    ホストは `123456` を受け取っていた（送信時に符号桁を落とすため）。
 *
 * 打鍵経路だけの規則で、ペースト・マクロ・MCP は core の送信時検証を通る。
 */

const COLS = 80;

function cell(char = " "): Cell {
  return { char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}
function fld(over: Partial<Field> & { index: number; row: number; col: number; length: number }): Field {
  return { protected: false, hidden: false, numeric: false, mdt: false, value: "", ...over } as Field;
}
function snapOf(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) row.push(cell());
    cells.push(row);
  }
  for (const f of fields) [...f.value].forEach((ch, i) => (cells[f.row - 1]![f.col - 1 + i] = cell(ch)));
  return { sessionId: "s", rows: 24, cols: COLS, cursor: { row: 5, col: 10 },
    keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}

describe("数字専用欄（digitsOnly）は数字しか受け付けない", () => {
  const digits = fld({ index: 1, row: 5, col: 10, length: 6, numeric: true, digitsOnly: true });

  it("`.` `,` `+` `-` 空白を拒否する（理由は数値）", () => {
    for (const ch of [".", ",", "+", "-", " "]) expect(rejectReason(digits, ch)).toBe("numeric");
    for (const ch of ["0", "5", "9"]) expect(rejectReason(digits, ch)).toBeUndefined();
  });

  it("数字専用でない数値欄では従来どおり `.` `-` を受ける（signed-num の欄）", () => {
    const num = fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true });
    for (const ch of [".", ",", "+", "-", " "]) expect(rejectReason(num, ch)).toBeUndefined();
  });
});

describe("符号桁（符号付き数値欄の最終桁）", () => {
  const signed = fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true });

  it("最終桁だけを符号桁とみなす", () => {
    expect(isSignPosition(signed, 5, 7)).toBe(false);
    expect(isSignPosition(signed, 6, 7)).toBe(true);
  });

  it("符号付きでない欄には符号桁が無い", () => {
    const num = fld({ index: 1, row: 5, col: 10, length: 7, numeric: true });
    expect(isSignPosition(num, 6, 7)).toBe(false);
  });
});

describe("ScreenGrid: 打鍵", () => {
  beforeEach(() => document.body.replaceChildren());

  function mountGrid(fields: Field[]) {
    return mount(ScreenGrid, {
      props: { snapshot: snapOf(fields), edits: new Map(), focused: true, busy: false, cursor: { row: 5, col: 10 } },
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
  const lastEdit = (w: ReturnType<typeof mountGrid>) => {
    const e = w.emitted("edit") as unknown[][] | undefined;
    return e ? (e[e.length - 1]![1] as string) : undefined;
  };
  const notices = (w: ReturnType<typeof mountGrid>) =>
    ((w.emitted("notice") as unknown[][] | undefined) ?? []).map((a) => a[0] as string);

  async function typeInto(fields: Field[], text: string) {
    const w = mountGrid(fields);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, text);
    const out = { value: lastEdit(w), notices: notices(w) };
    w.unmount();
    return out;
  }

  it("数字専用欄: `1.5` は `.` を弾いて `15` になり、理由が出る", async () => {
    const r = await typeInto(
      [fld({ index: 1, row: 5, col: 10, length: 6, numeric: true, digitsOnly: true })],
      "1.5"
    );
    expect(r.value?.trimEnd()).toBe("15");
    expect(r.notices).toContain(MSG_BY_REASON["numeric"]);
  });

  it("**数字専用欄の `-` は Field− にしない**（打った桁が消えて次欄へ飛ばない）", async () => {
    const r = await typeInto(
      [fld({ index: 1, row: 5, col: 10, length: 6, numeric: true, digitsOnly: true })],
      "1234-"
    );
    expect(r.value?.trimEnd()).toBe("1234"); // 右寄せも消去も起きない
    expect(r.notices).toContain(MSG_BY_REASON["numeric"]);
  });

  it("符号付き数値欄では従来どおり `-` が Field− になる（退行防止）", async () => {
    const r = await typeInto(
      [fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true })],
      "12-"
    );
    expect(r.value).toBe("    12-");
  });

  it("符号付き数値欄: 7 桁目（符号桁）に数字は入らない", async () => {
    const r = await typeInto(
      [fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true })],
      "1234567"
    );
    // 画面に見えている桁がそのままホストへ行く（符号桁は空白のまま＝末尾空白は emit で落ちる）
    expect(r.value).toBe("123456");
    expect(r.notices).toContain(MSG_BY_REASON["sign-position"]);
  });
});

describe("送信が拒否された理由の通知", () => {
  it("FIELD_TYPE は日本語の要約＋元の文で出す", () => {
    const m = wsErrorNotice("FIELD_TYPE", 'numeric field accepts digits only: "1.5"');
    expect(m).toContain("入力できない文字があるため送信しませんでした");
    expect(m).toContain('"1.5"');
  });

  it("未知のコードでも黙らない", () => {
    expect(wsErrorNotice("SOMETHING_NEW", "boom")).toContain("boom");
  });
});

describe("送信が拒否された理由の通知（画面に出るところまで）", () => {
  const SID = "kr1";

  it("**`SessionState.notice` として画面の最下行に出る**", async () => {
    // サーバーの `error` フレームはここへ入る（`session-controller.ts`）。
    // 出す場所は画面の中（`20260802-message-line`）なので、ペインごとマウントして見る。
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID,
      label: "t",
      snapshot: snapOf([]),
      edits: new Map(),
      cursor: { row: 1, col: 1 },
      connected: true,
      readOnly: false,
      client: { send: () => {} } as unknown as WsClient
    });
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true } });
    await nextTick();
    expect(w.text()).not.toContain("送信しませんでした");

    sessionsStore.get(SID)!.notice = wsErrorNotice("FIELD_TYPE", 'numeric field accepts digits only: "1.5"');
    await nextTick();
    expect(w.find(".opmsg").text()).toContain("入力できない文字があるため送信しませんでした");
    w.unmount();
  });
});
