import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { MSG_MANDATORY_ENTER, MSG_MANDATORY_ENTER_EXIT, MSG_MANDATORY_FILL } from "../src/composables/opMessages.js";
import { rawSentinel, selfCheckDigitOk } from "@ts5250/tn5250/browser";
import { MSG_SELF_CHECK } from "../src/composables/opMessages.js";

/**
 * **Field Exit の検査の配線と、MDT を立てる編集キー**（`20260921-field-exit-checks` の節目 10 の独立点検 B-M1・B-S1〜B-S4）。
 *
 * - **B-M1**: 継続欄の MDT を並び全体で見る修正は、画面の全欄を渡す配線が 4 か所（ScreenGrid の Field Exit・ペインの欄を出る検査・
 *   `sendKey` の送信前検査・ME の検査）ある。純関数のテストだけでは、3 か所を戻しても全テストが緑だった——コンポーネントを通して固定する
 * - **B-S1**: 「欄の先頭」は型で決まる（J は空でも SO が先頭にある。G・O は SO を飛ばさない）
 * - **B-S2・S3**: 字を置く以外の編集キー（Backspace・Delete・Erase EOF）・SBCS 欄の貼り付けも、値が変わらなくても MDT
 */
const COLS = 80;
const cell = (char = " ", kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;
const fld = (index: number, row: number, extra: Partial<Field> = {}): Field =>
  ({ index, row, col: 20, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "", ...extra }) as Field;

function snapOf(fields: Field[], put: (cells: Cell[][]) => void = () => {}, cursor = { row: fields[0]!.row, col: fields[0]!.col }): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  for (const f of fields) if (!f.dbcsType) [...f.value].forEach((ch, i) => (cells[f.row - 1]![f.col - 1 + i] = cell(ch)));
  put(cells);
  return { sessionId: "w1", rows: 24, cols: COLS, cursor, keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}

/** 全角始まりの DBCS 欄（(5,20) から）を SO・あ・SI で描く */
const jCells = (row: number, col: number) => (cells: Cell[][]) => {
  const r = cells[row - 1]!;
  r[col - 1] = cell(" ", "so");
  r[col] = cell("あ", "dbcs-lead");
  r[col + 1] = cell("", "dbcs-tail");
  r[col + 2] = cell(" ", "si");
};

let send: Mock<(m: unknown) => void>;
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});
beforeEach(() => {
  send = vi.fn<(m: unknown) => void>();
});
function seed(snapshot: ScreenSnapshot): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: "w1", label: "t", snapshot, edits: new Map(), cursor: snapshot.cursor,
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send } as unknown as WsClient
  });
}
async function pane(snapshot: ScreenSnapshot) {
  seed(snapshot);
  const w = mount(EmulatorPane, { props: { sessionId: "w1", focused: true }, attachTo: document.body });
  mounted.push(w);
  await nextTick();
  return { w, inputs: w.findAll("input.grid-input:not([readonly])[data-slice='0']").map((x) => x.element as HTMLInputElement) };
}
const press = async (key: string, opts: KeyboardEventInit = {}) => {
  (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
  await nextTick();
  await nextTick();
};
const fieldExit = () => press("Enter", { ctrlKey: true });
const opmsg = (w: ReturnType<typeof mount>) => (w.find(".opmsg").exists() ? w.find(".opmsg").text().replace(/\s/g, "") : "");
const norm = (s: string) => s.replace(/\s/g, "");
const keysSent = () => send.mock.calls.map((c) => c[0] as { type: string; key?: string }).filter((m) => m.type === "key").map((m) => m.key);

/** 1 区間目（row5）・2 区間目（row6）だけの ME の継続欄。1 区間目にだけ値があり MDT が立っている */
const contSegs = (over1: Partial<Field> = {}, over2: Partial<Field> = {}): Field[] => [
  fld(1, 5, { length: 2, continued: "first", mandatoryEnter: true, mdt: true, value: "12", ...over1 }),
  fld(2, 6, { length: 2, continued: "last", mandatoryEnter: true, ...over2 }),
  fld(3, 8, {})
];

describe("継続欄の MDT は並び全体（配線の 4 か所を固定）", () => {
  it("**ScreenGrid の Field Exit**: 1 区間目だけ MDT の ME の継続欄の 2 区間目で、先頭以外から Field Exit しても 0021 にしない", async () => {
    const { w, inputs } = await pane(snapOf(contSegs(), () => {}, { row: 6, col: 20 }));
    inputs[1]!.focus();
    inputs[1]!.setSelectionRange(1, 1); // 2 区間目の先頭以外
    await nextTick();
    await fieldExit();
    expect(opmsg(w), "0021 で止めない").not.toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });

  it("**ペインの欄を出る検査**: 継続欄の MF は、どの区間かに MDT があれば全区間が対象（1 区間目を打った後、2 区間目の部分入力で Tab → 止まる）", async () => {
    // MF の 2 区間（1 区間目は満杯 `12`・2 区間目は 1 字だけ）。1 区間目に MDT。2 区間目から Tab で出ようとする
    const f = [
      fld(1, 5, { length: 2, continued: "first", adjust: "mandatory-fill", mdt: true, value: "12" }),
      fld(2, 6, { length: 2, continued: "last", adjust: "mandatory-fill", value: "3" }),
      fld(3, 8, {})
    ];
    const { w, inputs } = await pane(snapOf(f, () => {}, { row: 6, col: 20 }));
    inputs[1]!.focus();
    inputs[1]!.setSelectionRange(1, 1);
    await nextTick();
    await press("Tab");
    expect(opmsg(w), "MF で止まる").toBe(norm(MSG_MANDATORY_FILL));
  });

  it("**`sendKey` の送信前検査（AID の ME）**: 1 区間目だけ MDT の ME の継続欄は Enter で送れる（2 区間目を打っていなくても）", async () => {
    const { inputs } = await pane(snapOf(contSegs(), () => {}, { row: 8, col: 20 }));
    inputs[2]!.focus();
    await nextTick();
    await press("Enter");
    expect(keysSent(), "ME で止めずに送る").toEqual(["Enter"]);
  });

  it("**`sendKey` の送信前検査（AID の MF）**: 継続欄の MF は、1 区間目にだけ MDT があっても 2 区間目の部分入力で Enter が止まる（区間ごとに見ない）", async () => {
    const f = [
      fld(1, 5, { length: 2, continued: "first", adjust: "mandatory-fill", mdt: true, value: "12" }),
      fld(2, 6, { length: 2, continued: "last", adjust: "mandatory-fill", value: "3" }),
      fld(3, 8, {})
    ];
    const { w, inputs } = await pane(snapOf(f, () => {}, { row: 6, col: 20 }));
    inputs[1]!.focus();
    await nextTick();
    await press("Enter");
    expect(keysSent(), "MF で止まる").toEqual([]);
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_FILL));
  });

  it("**AID の ME は、どの区間にも MDT が無ければ止める**（並びを 1 つとして見て、区間ごとに見ない）", async () => {
    // 画面に別の MDT（3 番の欄）があるので「画面が変更済み」だが、継続欄の並びには MDT が無い
    const f = contSegs({ mdt: false }, {});
    f[2] = fld(3, 8, { mdt: true, value: "x" });
    const { w, inputs } = await pane(snapOf(f, () => {}, { row: 8, col: 20 }));
    inputs[2]!.focus();
    await nextTick();
    await press("Enter");
    expect(keysSent()).toEqual([]);
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_ENTER));
  });
});

describe("Field Exit の「欄の先頭」は型で決まる（B-S1）", () => {
  const dbcsPane = async (type: NonNullable<Field["dbcsType"]>, over: Partial<Field> = {}, content = true) => {
    const f = [fld(1, 5, { length: 8, dbcsType: type, value: content ? "あ" : "", ...over }), fld(2, 8, {})];
    return pane(snapOf(f, content ? jCells(5, 20) : () => {}, { row: 5, col: 20 }));
  };
  const at = async (el: HTMLInputElement, caret: number) => {
    el.focus();
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
  };

  it("**G（pure）: 最初の字が先頭**——ME・MDT ありで先頭から Field Exit は 0021 で止まる（SO が無いので論理位置 0 が先頭）", async () => {
    const { w, inputs } = await dbcsPane("pure", { mandatoryEnter: true, mdt: true });
    await at(inputs[0]!, 0);
    await fieldExit();
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });

  it("**O（open）: 先頭は先頭のまま**（Tab は SO を飛ばさない）——ME・MDT ありで 0021", async () => {
    const { w, inputs } = await dbcsPane("open", { mandatoryEnter: true, mdt: true });
    await at(inputs[0]!, 1);
    await fieldExit();
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });

  it("**J（only）: 最初の字は先頭ではない**——ME・MDT ありで最初の字から Field Exit は止めない", async () => {
    const { w, inputs } = await dbcsPane("only", { mandatoryEnter: true, mdt: true });
    await at(inputs[0]!, 1);
    await fieldExit();
    expect(opmsg(w)).not.toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });

  it("**空の J も SO が先頭にある**（作成時に置く）——打って消した（MDT）ME の J 欄の Field Exit は通す", async () => {
    const { w, inputs } = await dbcsPane("only", { mandatoryEnter: true, mdt: true }, false);
    await at(inputs[0]!, 0);
    await fieldExit();
    expect(opmsg(w), "空でも論理位置 0 は先頭ではない").not.toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });

  it("E（either）: 全角で始まれば SO が先頭（J と同じ）・空なら先頭", async () => {
    const withContent = await dbcsPane("either", { mandatoryEnter: true, mdt: true });
    await at(withContent.inputs[0]!, 1);
    await fieldExit();
    expect(opmsg(withContent.w), "全角始まり").not.toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });
});

describe("MDT を立てる編集キー（値が変わらなくても。B-S2・B-S3）", () => {
  const meField = (value: string): Field[] => [fld(1, 5, { mandatoryEnter: true, value }), fld(2, 8, {})];

  it("**Erase EOF**: 消えるものが無くても MDT（ホストの値 `ABC` の末尾で Erase EOF → Field Exit は 0021 にしない）", async () => {
    const { w, inputs } = await pane(snapOf(meField("ABC")));
    inputs[0]!.focus();
    inputs[0]!.setSelectionRange(6, 6);
    await nextTick();
    await press("Delete", { ctrlKey: true }); // Erase EOF（既定の割り当て）
    await fieldExit();
    expect(opmsg(w)).not.toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });

  it("**Field Exit の消去そのものが MDT を立てる**（ME でない欄。消えるものが無い末尾から Field Exit しても、編集が出る＝READ MDT に載る）", async () => {
    const edits = new Map<number, string>();
    const g = mount(ScreenGrid, {
      props: {
        snapshot: snapOf([fld(1, 5, { value: "AB" }), fld(2, 8, {})]),
        edits,
        focused: true,
        busy: false,
        cursor: { row: 5, col: 20 },
        onEdit: (i: number, v: string) => void edits.set(i, v)
      },
      attachTo: document.body
    });
    mounted.push(g as never);
    await nextTick();
    const el = g.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
    el.focus();
    el.setSelectionRange(1, 1);
    // keydown が native caret を編集モデルへ写してから 1 桁進める（= 2）。カーソル移動だけでは編集は出ない
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await nextTick();
    expect(edits.size, "カーソルを動かしただけでは MDT にしない").toBe(0);
    (g.vm as unknown as { fieldExit: () => void }).fieldExit();
    await nextTick();
    expect(edits.get(1), "消去の操作で MDT が立つ（値は同じ）").toBe("AB");
  });

  it("**Backspace**（消えるものが無い桁でも）: 欄の中ほどで空白の桁の Backspace → MDT", async () => {
    const { w, inputs } = await pane(snapOf(meField("AB")));
    inputs[0]!.focus();
    inputs[0]!.setSelectionRange(5, 5); // 値の後ろの空白の桁
    await nextTick();
    await press("Backspace");
    inputs[0]!.setSelectionRange(1, 1);
    await nextTick();
    await fieldExit();
    expect(opmsg(w)).not.toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });

  it("**Delete**（消えるものが無い桁でも）: 値の後ろの空白の桁の Delete → MDT（ACS `processDeleteChar` は `setMDT`。`scripts/acs-probe/erase-eof-mdt.txt`）", async () => {
    const { w, inputs } = await pane(snapOf(meField("AB")));
    inputs[0]!.focus();
    inputs[0]!.setSelectionRange(5, 5); // 値の後ろの空白の桁（消えるものが無い）
    await nextTick();
    await press("Delete");
    inputs[0]!.setSelectionRange(1, 1);
    await nextTick();
    await fieldExit();
    expect(opmsg(w)).not.toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });

  it("**SBCS 欄への貼り付け**: ホストの値と同じ字を貼っても MDT（主経路。DBCS の単一行だけでなかった）", async () => {
    const { w, inputs } = await pane(snapOf(meField("AB")));
    inputs[0]!.focus();
    inputs[0]!.setSelectionRange(0, 0);
    await nextTick();
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    ev.clipboardData = { getData: () => "A" };
    inputs[0]!.dispatchEvent(ev);
    await nextTick();
    inputs[0]!.setSelectionRange(1, 1);
    await nextTick();
    await fieldExit();
    expect(opmsg(w)).not.toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });

  it("**カーソルを動かすだけ・触らない欄は MDT にしない**（従来どおり）", async () => {
    const { w, inputs } = await pane(snapOf(meField("AB")));
    inputs[0]!.focus();
    inputs[0]!.setSelectionRange(1, 1);
    await nextTick();
    await press("ArrowRight");
    await fieldExit();
    expect(opmsg(w), "MDT が無いので 0021").toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });
});

describe("表示の配線（`ccsid`）と字を置く印の持ち越し（B-S4）", () => {
  it("**ゾーン D の桁は、セッションの CCSID の字で見える**（273 の 0xD0 は `ü`。`ccsid` をペインから ScreenGrid へ渡す配線）", async () => {
    const snapshot = snapOf([fld(1, 5, { numeric: true, value: "" })]);
    seed(snapshot);
    (sessionsStore.get("w1") as unknown as { ccsid: number; edits: Map<number, string> }).ccsid = 273;
    (sessionsStore.get("w1") as unknown as { edits: Map<number, string> }).edits.set(1, `12${rawSentinel(0xd0)}`);
    const w = mount(EmulatorPane, { props: { sessionId: "w1", focused: true }, attachTo: document.body });
    mounted.push(w);
    await nextTick();
    const el = w.find("input.grid-input:not([readonly])").element as HTMLInputElement;
    expect(el.value.trimEnd()).toBe("12ü");
  });

  it("ScreenGrid 単体でも `ccsid` の prop が効く", async () => {
    const g = mount(ScreenGrid, {
      props: { snapshot: snapOf([fld(1, 5, { numeric: true })]), edits: new Map([[1, `12${rawSentinel(0xd0)}`]]), focused: false, busy: false, cursor: { row: 1, col: 1 }, ccsid: 273 }
    });
    await nextTick();
    expect((g.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement).value.trimEnd()).toBe("12ü");
    g.unmount();
  });

  it("**継続欄の挿入が置けなかったとき、印を次の同期へ持ち越さない**（触っていない欄に MDT を立てない）", async () => {
    // 2 区間とも満杯の継続欄で挿入モードの文字は置けない（0012）。その後、別の欄を触らずにカーソルだけ動かしても、編集は出ない
    const f = [
      fld(1, 5, { length: 2, continued: "first", value: "12", numeric: true }),
      fld(2, 6, { length: 2, continued: "last", value: "34", numeric: true }),
      fld(3, 8, { mandatoryEnter: true, value: "AB" })
    ];
    const { w, inputs } = await pane(snapOf(f, () => {}, { row: 5, col: 20 }));
    inputs[0]!.focus();
    inputs[0]!.setSelectionRange(0, 0);
    await nextTick();
    await press("Insert");
    await press("5"); // 置けない（0012。エラー状態に入る）
    // Reset（左 Ctrl を単独で押して離す）でエラー状態を抜ける
    const active = document.activeElement as HTMLElement;
    active.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true, bubbles: true, cancelable: true }));
    active.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));
    await nextTick();
    // 3 番の ME 欄（MDT 無し）へ移って何もせず Field Exit——MDT が持ち越されていれば 0021 にならない
    inputs[2]!.focus();
    inputs[2]!.setSelectionRange(1, 1);
    await nextTick();
    await fieldExit();
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });
});

describe("印の持ち越し（継続欄で押し出した先の入力が無いとき）", () => {
  it("**同期しなかった印は次の同期へ持ち越さない**（触っていない欄に MDT を立てない）", async () => {
    // 継続欄（1 区間目に空きが 1 桁）へ挿入モードで字を置くと、押し出しの結果が 2 区間目に及ぶ。2 区間目の入力が無い状況を作る
    const f = [
      fld(1, 5, { length: 3, continued: "first", value: "12", numeric: true }),
      fld(2, 6, { length: 3, continued: "last", value: "", numeric: true }),
      fld(3, 8, { mandatoryEnter: true, value: "AB" })
    ];
    const { w, inputs } = await pane(snapOf(f, () => {}, { row: 5, col: 20 }));
    inputs[0]!.focus();
    inputs[0]!.setSelectionRange(2, 2); // 1 区間目の最後の空きの桁。ここへ挿入するとカーソルが 2 区間目へ渡る
    await nextTick();
    await press("Insert");
    // 押し出しの先（2 区間目）の入力を DOM から外す
    w.findAll("input.grid-input[data-field-index='2']").forEach((x) => x.element.remove());
    await press("5");
    // 触っていない 3 番の ME 欄（MDT 無し）で、カーソルを動かすだけ→ Field Exit。印が持ち越されていると、カーソル移動の同期が編集を出して MDT が立ち、
    // Field Exit が 0021 にならない（Field Exit 自身の同期は印を自分で決めるので、この経路でないと持ち越しが見えない）
    inputs[2]!.focus();
    inputs[2]!.setSelectionRange(1, 1);
    await nextTick();
    await press("ArrowRight");
    await fieldExit();
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_ENTER_EXIT));
  });
});

/**
 * **Field Exit・Field± で出るときは、出た後の MF・自己点検を掛けない**（B-S5。ACS `processFieldPlusMinusAndExit` は MF を出る前に自分で見るだけで、
 * `moveCursorWithMandFillCheck` も `checkModulusField` も呼ばない）。Tab など他の経路は従来どおり掛かる
 */
describe("Field Exit の後は自己点検・MF を見直さない（B-S5）", () => {
  const bad = ["12", "13", "14", "15", "1"].find((t) => !selfCheckDigitOk(t, "mod10"))!;
  const typeBad = async (inputs: HTMLInputElement[]) => {
    inputs[0]!.focus();
    await nextTick();
    for (const ch of bad) await press(ch);
  };

  it("**検査桁の合わない自己点検欄でも、Field Exit は次の欄へ進む**（操作員エラーを出さない）", async () => {
    const { w, inputs } = await pane(snapOf([fld(1, 5, { selfCheck: "mod10" }), fld(2, 7)]));
    await typeBad(inputs);
    await fieldExit();
    expect(opmsg(w)).toBe("");
    expect((document.activeElement as HTMLInputElement).dataset["fieldIndex"]).toBe("2");
  });

  it("**Field+ でも同じ**", async () => {
    const { w, inputs } = await pane(snapOf([fld(1, 5, { selfCheck: "mod10" }), fld(2, 7)]));
    await typeBad(inputs);
    await press("+", { ctrlKey: true });
    expect(opmsg(w)).toBe("");
    expect((document.activeElement as HTMLInputElement).dataset["fieldIndex"]).toBe("2");
  });

  it("**Tab で出るときは従来どおり止まる**（自己点検の 0021。Field Exit だけが例外）", async () => {
    const { w, inputs } = await pane(snapOf([fld(1, 5, { selfCheck: "mod10" }), fld(2, 7)]));
    await typeBad(inputs);
    await press("Tab");
    expect(opmsg(w)).toBe(norm(MSG_SELF_CHECK));
  });

  it("**Field Exit の後に mute が残らない**: 続けて別の欄を Tab で出れば、その欄の検査は掛かる", async () => {
    const { w, inputs } = await pane(snapOf([fld(1, 5), fld(2, 7, { selfCheck: "mod10" }), fld(3, 9)]));
    inputs[0]!.focus();
    await nextTick();
    await fieldExit(); // 1 → 2（検査なし）
    for (const ch of bad) await press(ch); // 2 に不正な値
    await press("Tab"); // 2 を Tab で出る → 止まる
    expect(opmsg(w)).toBe(norm(MSG_SELF_CHECK));
  });
});

/**
 * **編集の印（`ScreenGrid.vue` の `mdtKeyed`）の受け渡し**（節目 10 の独立点検 B-S4）。立てる側（打鍵・貼り付け・IME）と読む側（`sync`・`syncDbcs`）が
 * モジュール変数で繋がるので、(a) 同期のたびに下ろす、(b) 置けなかったときは立てない、(c) 値が同じでも置いたら立てる、のどれが崩れても
 * 「触っていない欄に MDT が立つ」か「打ち直した欄が READ MDT に載らない」になる。純関数のテストでは見えないので ScreenGrid を通して固定する
 */
describe("編集の印は同期ごとに下ろし、置けなかったときは立てない（B-S4）", () => {
  const typeKey = (el: HTMLInputElement, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  async function grid(fields: Field[], cursor = { row: fields[0]!.row, col: fields[0]!.col }, put: (cells: Cell[][]) => void = () => {}) {
    const edits = new Map<number, string>();
    const w = mount(ScreenGrid, {
      props: { snapshot: snapOf(fields, put, cursor), edits, focused: true, busy: false, cursor, onEdit: (i: number, v: string) => void edits.set(i, v) },
      attachTo: document.body
    });
    mounted.push(w as never);
    await nextTick();
    const el = w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
    el.focus();
    await nextTick();
    return { w, el, edited: () => ((w.emitted("edit") as unknown[][] | undefined) ?? []).map((a) => a[1]) };
  }
  const paste = async (el: HTMLInputElement, text: string) => {
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    ev.clipboardData = { getData: () => text };
    el.dispatchEvent(ev);
    await nextTick();
  };

  it("**SBCS**: 値が変わる打鍵の印はその同期で下ろす（次のカーソルだけの同期で同じ編集を出し直さない）", async () => {
    const { el, edited } = await grid([fld(1, 5, { value: "AB" }), fld(2, 8, {})]);
    el.setSelectionRange(2, 2);
    typeKey(el, "C");
    await nextTick();
    expect(edited()).toEqual(["ABC"]);
    typeKey(el, "ArrowLeft");
    await nextTick();
    expect(edited(), "カーソルだけの同期で編集を出し直している（印が持ち越された）").toEqual(["ABC"]);
  });

  it("**DBCS**: 同じ（`syncDbcs` の側）", async () => {
    const { el, edited } = await grid([fld(1, 5, { length: 8, dbcsType: "only", value: "" }), fld(2, 8, {})]);
    typeKey(el, "あ");
    await nextTick();
    expect(edited()).toEqual(["あ"]);
    typeKey(el, "ArrowLeft");
    await nextTick();
    expect(edited(), "カーソルだけの同期で編集を出し直している（印が持ち越された）").toEqual(["あ"]);
  });

  it("**DBCS 欄への貼り付け**: 何も置けなかったら MDT にしない（半角の字は J 欄に入らない）", async () => {
    const { el, edited } = await grid([fld(1, 5, { length: 8, dbcsType: "only", value: "" }), fld(2, 8, {})]);
    await paste(el, "A");
    expect(edited()).toEqual([]);
  });

  it("**IME の確定**: 何も置けなかったら MDT にしない（数値欄に英字を確定）", async () => {
    const { el, edited } = await grid([fld(1, 5, { numeric: true, digitsOnly: true, value: "" }), fld(2, 8, {})]);
    el.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    el.value = "A";
    el.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await nextTick();
    expect(edited()).toEqual([]);
  });

  it("**継続欄の挿入が入らなかったとき**: 印を下ろす（次のカーソルだけの同期で MDT にしない）", async () => {
    const { el, edited } = await grid([
      fld(1, 5, { length: 2, continued: "first", value: "12" }),
      fld(2, 6, { length: 2, continued: "last", value: "34" }),
      fld(3, 8, {})
    ]);
    el.setSelectionRange(0, 0);
    typeKey(el, "Insert");
    typeKey(el, "X"); // 全区間が満杯なので入らない（エラー 0012）
    await nextTick();
    expect(edited()).toEqual([]);
    typeKey(el, "ArrowRight");
    await nextTick();
    expect(edited(), "入らなかった挿入の印が次の同期へ持ち越された").toEqual([]);
  });

  it("**継続欄の挿入**: 値が変わらない挿入（値の後ろへ空白）でも MDT（置いたので）", async () => {
    const { el, edited } = await grid([
      fld(1, 5, { length: 4, continued: "first", value: "AB" }),
      fld(2, 6, { length: 4, continued: "last", value: "" }),
      fld(3, 8, {})
    ]);
    el.setSelectionRange(2, 2);
    typeKey(el, "Insert");
    typeKey(el, " ");
    await nextTick();
    expect(edited().length, "置いたのに編集が出ない（READ MDT に載らない）").toBeGreaterThan(0);
  });

  it("**DBCS 欄の Delete**: 消えるものが無い桁（値の後ろ）でも MDT（SBCS 欄と同じ。ACS `processDeleteChar` は `setMDT`）", async () => {
    const { el, edited } = await grid([fld(1, 5, { length: 8, dbcsType: "open", value: "A" }), fld(2, 8, {})], undefined, (cells) => void (cells[4]![19] = cell("A")));
    el.setSelectionRange(1, 1);
    typeKey(el, "ArrowRight"); // 値の後ろへ
    typeKey(el, "Delete");
    await nextTick();
    expect(edited(), "消えるものが無くても MDT").toEqual(["A"]);
  });

  it("**DBCS 欄の Backspace**: 値の後ろの空白の桁でも MDT", async () => {
    const { el, edited } = await grid([fld(1, 5, { length: 8, dbcsType: "open", value: "A" }), fld(2, 8, {})], undefined, (cells) => void (cells[4]![19] = cell("A")));
    el.setSelectionRange(4, 4); // 値の後ろの空白の桁
    typeKey(el, "ArrowRight");
    typeKey(el, "Backspace");
    await nextTick();
    expect(edited().length, "消えるものが無くても MDT").toBeGreaterThan(0);
  });

  it("**Field Exit 必須の欄の最終桁に、値と同じ字を打つ**: 値は同じでも MDT（FER の経路）", async () => {
    const { el, edited } = await grid([fld(1, 5, { length: 3, fieldExitRequired: true, value: "ABC" }), fld(2, 8, {})]);
    el.setSelectionRange(2, 2);
    typeKey(el, "C");
    await nextTick();
    expect(edited()).toEqual(["ABC"]);
  });
});
