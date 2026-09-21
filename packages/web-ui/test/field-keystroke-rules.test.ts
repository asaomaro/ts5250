import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { WsClient } from "../src/ws-client.js";
import { rejectReason, isSignPosition } from "../src/composables/fieldValidate.js";
import {
  MSG_BY_REASON,
  MSG_FIELD_EXIT_KEY_INVALID,
  MSG_UNKNOWN_ERROR,
  fieldAtLabel,
  noticeFor,
  wsErrorNotice
} from "../src/composables/opMessages.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **打鍵の型規則（実機 `TESTLIB/AUDPGM` で確かめた 3 件）。**
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

  // ~~数字専用でない数値欄では従来どおり `.` `-` を受ける（signed-num の欄）~~ → ACS は符号付き数値欄を数字だけにする
  // （`PS5250.checkSBCSField` のエラー 0016。実機の ACS で `-` と `.` がエラー。`20260921-numpad-field-sign`）
  it("数値専用（0x0300）の欄は `.` `,` `+` `-` 空白を受ける（ACS `checkNumericOnlyChar` と同じ集合）", () => {
    const num = fld({ index: 1, row: 5, col: 10, length: 6, numeric: true });
    for (const ch of [".", ",", "+", "-", " "]) expect(rejectReason(num, ch)).toBeUndefined();
  });

  it("**符号付き数値（0x0700）の欄は数字だけ**（`.` `,` `+` `-` 空白は理由つきで拒否）", () => {
    const signed = fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true });
    for (const ch of [".", ",", "+", "-", " "]) expect(rejectReason(signed, ch)).toBe("numeric");
    expect(rejectReason(signed, "7")).toBeUndefined();
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

  // ~~符号付き数値欄では従来どおり `-` が Field− になる（退行防止）~~ → ACS はメイン行の `-` を文字として扱い、
  // 符号付き数値欄ではエラーにする（実機の ACS: `12-` → `12` のままエラー。`20260921-numpad-field-sign`）
  it("符号付き数値欄のメイン行の `-` はエラー（値は `12` のまま。Field− はテンキー）", async () => {
    const r = await typeInto(
      [fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true })],
      "12-"
    );
    expect(r.value).toBe("12");
    expect(r.notices).toContain(MSG_BY_REASON["numeric"]);
  });

  it("符号付き数値欄: 数字桁を埋めた後の 7 桁目は入らず、エラー 0018", async () => {
    const r = await typeInto(
      [fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true })],
      "1234567"
    );
    // 画面に見えている桁がそのままホストへ行く（符号桁は空白のまま＝末尾空白は emit で落ちる）
    expect(r.value).toBe("123456");
    // ~~符号桁の拒否（sign-position）~~ → ACS は最終の数字桁に留まって「出た」状態になり、次の文字は 0018
    // （`processCharKeyStroke` の `setErrorCode(24)`。実機でも 6S0 に 6 桁打つと 19,25 に留まった。
    // `20260921-field-exit-required-types` research F4・F5）
    expect(r.notices).toContain(MSG_FIELD_EXIT_KEY_INVALID);
  });

  it("符号付き数値欄: 符号桁にカーソルを置いて数字を打つと入らない（理由が出る）", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(6, 6);
    await type(el, "7");
    expect(notices(w)).toContain(MSG_BY_REASON["sign-position"]);
    expect(w.emitted("edit")).toBeUndefined();
    w.unmount();
  });
});

/**
 * ~~FIELD_TYPE は日本語の要約＋元の文で出す~~ → **元の文は出さない**
 * （`20260920-field-error-no-value` decisions D2）。
 *
 * サーバーの message には**打鍵した値が入りうる**——マクロの秘密を型の合わない欄へ再生すると、
 * **復号済みの平文がここから画面へ出ていた**（同 research F1）。
 * `AGENTS.md`「秘密の扱い」の「API/ブラウザには平文も暗号文も返さない」。
 * 「どの欄か」は**位置**（`field at (行,桁)`）だけを拾って伝える。
 */
describe("送信が拒否された理由の通知", () => {
  it("FIELD_TYPE は**理由**＋**欄の位置**で出す（値は出さない）", () => {
    const m = wsErrorNotice("FIELD_TYPE", "field at (20,7) accepts digits only");
    // 見出しへ畳まず、4 つある理由のうちどれかを出す（FR2 / US1）
    expect(m).toContain(MSG_BY_REASON.numeric);
    expect(m).toContain(fieldAtLabel(20, 7));
    expect(m, "英語の原文は出さない").not.toContain("accepts digits only");
  });

  /**
   * **`FIELD_TYPE` は 4 つの理由を 1 つの code で運ぶ。** 見出しだけにすると
   * 「何をどう直せばよいか」が消えるので、**閉じた語彙**に一致したときだけ理由を日本語にする
   * （`20260920-field-error-no-value` review の指摘）。
   */
  it("4 つの理由がそれぞれ別の日本語になる", () => {
    const at = "field at (20,7)";
    expect(wsErrorNotice("FIELD_TYPE", `${at} accepts digits only`)).toContain(MSG_BY_REASON.numeric);
    expect(wsErrorNotice("FIELD_TYPE", `${at} accepts alphabetic characters only`)).toContain(
      MSG_BY_REASON["alpha-only"]
    );
    expect(wsErrorNotice("FIELD_TYPE", `${at} accepts double-byte characters only`)).toContain(
      MSG_BY_REASON["dbcs-required"]
    );
    const cp = wsErrorNotice("FIELD_TYPE", `${at} cannot hold characters outside CCSID 37`);
    expect(cp, "CCSID 番号は出さない").not.toContain("37");
    // 4 つが互いに違う文言になっている（1 つに畳まれていない）
    const all = [
      wsErrorNotice("FIELD_TYPE", `${at} accepts digits only`),
      wsErrorNotice("FIELD_TYPE", `${at} accepts alphabetic characters only`),
      wsErrorNotice("FIELD_TYPE", `${at} accepts double-byte characters only`),
      cp
    ];
    expect(new Set(all).size).toBe(4);
  });

  /**
   * **code を見ずに拾うと、反射の残る経路でクライアントが表示文を選べる**
   * （`20260920-field-error-no-value` review ラウンド 4 で実測）。
   * 位置も理由も**欄の検証が作った文言にしか無い**ので、その code のときだけ中身を見る。
   */
  it("**欄の検証以外の code では message の中身を見ない**", () => {
    const crafted = "printer session field at (9,9) accepts digits only not found";
    for (const code of ["SESSION_NOT_FOUND", "NOT_FOUND", "CONFIG_ERROR", "CONNECT_FAILED"]) {
      const m = wsErrorNotice(code, crafted);
      expect(m, `${code} で理由を選ばせている`).not.toContain(MSG_BY_REASON.numeric);
      expect(m, `${code} で位置を出している`).not.toContain(fieldAtLabel(9, 9));
    }
    // 欄の検証の code なら従来どおり拾う
    expect(wsErrorNotice("FIELD_TYPE", "field at (9,9) accepts digits only")).toContain(
      MSG_BY_REASON.numeric
    );
  });

  it("**知らない文は理由として通さない**（サーバーの文が素通りしない）", () => {
    // 閉じた語彙に無い＝見出しへ落とす。message がそのまま出る経路を作らない
    const m = wsErrorNotice("FIELD_TYPE", "field at (20,7) LEAK_MARKER_XYZ を含みます");
    expect(m).not.toContain("LEAK_MARKER_XYZ");
    expect(m).toContain(noticeFor("FIELD_TYPE"));
  });

  it("**値が混ざった message を渡されても、値は画面に出さない**", () => {
    // core は値を入れなくなったが、ここで拾う対象を位置だけに限ることで二重に守る
    const m = wsErrorNotice("FIELD_TYPE", 'field at (20,7) rejects: "P@ssw0rd-1234"');
    expect(m).not.toContain("P@ssw0rd-1234");
    expect(m).toContain(fieldAtLabel(20, 7));
  });

  it("位置が無ければ理由だけ（位置は省く）", () => {
    // `validateFieldContent` を位置なしで呼ぶ経路（ライブラリとしての利用側）
    expect(wsErrorNotice("FIELD_TYPE", "field accepts digits only")).toBe(MSG_BY_REASON.numeric);
  });

  it("理由も位置も拾えなければ見出しだけ", () => {
    expect(wsErrorNotice("FIELD_TYPE", "something we do not recognise")).toBe(
      noticeFor("FIELD_TYPE")
    );
  });

  it("未知のコードでも黙らない（ただしサーバーの文は出さない）", () => {
    const m = wsErrorNotice("SOMETHING_NEW", "boom");
    // 文言リテラルではなく**定数を参照する**（`AGENTS.md`「UI デザインガイド」）
    expect(m).toBe(MSG_UNKNOWN_ERROR);
    expect(m, "サーバーの文を素通ししない").not.toContain("boom");
  });

  /**
   * **オブジェクトの継承プロパティを見出しと取り違えない。**
   * `NOTICE_BY_ERROR` は素のリテラルなので、素引きだと `constructor` 等で関数が返り
   * `??` の既定が効かない（`20260920-field-error-no-value` の cross 点検の指摘）。
   */
  it("`constructor` のような code でも文字列を返す", () => {
    for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const m = wsErrorNotice(code, "boom");
      expect(typeof m, code).toBe("string");
      expect(m, code).toBe(MSG_UNKNOWN_ERROR);
    }
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
      link: { state: "connected" },
      resumability: "resumable",
      readOnly: false,
      client: { send: () => {} } as unknown as WsClient
    });
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true } });
    await nextTick();
    expect(w.text()).not.toContain(MSG_BY_REASON.numeric);

    sessionsStore.get(SID)!.notice = wsErrorNotice("FIELD_TYPE", "field at (20,7) accepts digits only");
    await nextTick();
    // 見出しではなく**理由**が出る（FR2 / US1）。空白は描画側が入れるので詰めて見る
    expect(w.find(".opmsg").text().replace(/\s+/gu, "")).toContain(
      MSG_BY_REASON.numeric.replace(/\s+/gu, "")
    );
    w.unmount();
  });
});
