import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { MSG_NO_ROOM } from "../src/composables/opMessages.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **挿入モードで欄が満杯のとき、どの経路でも黙って文字を捨てない**
 * （`20260920-insert-mode-overflow` AC3 / AC4 / AC7 / AC-I3 / AC-I4）。
 *
 * **関数を共有しているだけでは足りない。** 直前の work（`20260920-field-error-no-value`）で、
 * 同じ関数を呼んでいても**呼ぶ位置がずれていれば緑になる**と実測している
 * （条項 `paired-artifact-sync`）。だから経路ごとに**実際に発火させて**確かめる。
 *
 * 経路は 4 つ（`decisions.md` D3）: 打鍵 / 貼り付け（`insertInto`）/ DBCS 打鍵 / IME 確定。
 * `fieldEdit.paste()` は本番の呼び出し元が無いので対象外。
 */

const COLS = 80;

function cell(char = " "): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false
  } as Cell;
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
  return {
    sessionId: "s", rows: 24, cols: COLS, cursor: { row: 5, col: 10 },
    keyboardLocked: false, cells, fields
  } as unknown as ScreenSnapshot;
}

describe("挿入モードのあふれ: 経路をまたいで同じ規則", () => {
  beforeEach(() => document.body.replaceChildren());

  function mountGrid(fields: Field[], insertMode = true) {
    return mount(ScreenGrid, {
      props: {
        snapshot: snapOf(fields), edits: new Map(), focused: true, busy: false,
        cursor: { row: 5, col: 10 }, insertMode
      },
      attachTo: document.body
    });
  }
  const firstInput = (w: ReturnType<typeof mountGrid>) =>
    w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
  const notices = (w: ReturnType<typeof mountGrid>) =>
    ((w.emitted("notice") as unknown[][] | undefined) ?? []).map((a) => a[0] as string);
  const lastEdit = (w: ReturnType<typeof mountGrid>) => {
    const e = w.emitted("edit") as unknown[][] | undefined;
    return e ? (e[e.length - 1]![1] as string) : undefined;
  };

  /** 満杯の欄（末尾まで詰まっている）。挿入の余地が 0 */
  const full = () => fld({ index: 1, row: 5, col: 10, length: 5, value: "ABCDE" });

  it("AC3 打鍵: 値を変えず `MSG_NO_ROOM` を出す", async () => {
    const w = mountGrid([full()]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(2, 2);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "X", bubbles: true, cancelable: true }));
    await nextTick();
    expect(notices(w)).toContain(MSG_NO_ROOM);
    expect(lastEdit(w)).toBeUndefined(); // 値は 1 度も書き換えない
    w.unmount();
  });

  it("AC-I3 弾かれた打鍵はカーソルを進めない（次の欄へ送らない）", async () => {
    const w = mountGrid([full(), fld({ index: 2, row: 6, col: 10, length: 5 })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(2, 2);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "X", bubbles: true, cancelable: true }));
    await nextTick();
    // 自動送りが起きていれば 2 つ目の欄がフォーカスを持つ
    expect(document.activeElement).toBe(el);
    w.unmount();
  });

  it("AC4 貼り付け: 入り切らなければ値を書かず `MSG_NO_ROOM`（既存の振る舞い）", async () => {
    const w = mountGrid([full()]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    el.dispatchEvent(
      Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
        clipboardData: { getData: () => "X" }
      })
    );
    await nextTick();
    expect(notices(w)).toContain(MSG_NO_ROOM);
    expect(lastEdit(w)).toBeUndefined();
    w.unmount();
  });

  it("AC4 貼り付け: 符号付き数値欄では符号桁を取り置く（1 桁ぶん早く弾く）", async () => {
    // 欄長 6・値 4 桁＝素の空きは 2。符号桁を 1 つ取り置くので 2 桁の貼り付けは入らない
    const f = fld({ index: 1, row: 5, col: 10, length: 6, value: "12", numeric: true, signedNumeric: true });
    const w = mountGrid([f]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(2, 2);
    el.dispatchEvent(
      Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
        clipboardData: { getData: () => "3456" }
      })
    );
    await nextTick();
    expect(notices(w)).toContain(MSG_NO_ROOM);
    w.unmount();
  });

  it("AC4 貼り付け: 符号桁が埋まっていても、手前の空白へは貼れる（must 3）", async () => {
    // 欄長 6・`"1    -"` ＝符号桁は非空白だが**手前に空白が 4 桁ある**。
    // 取り置きを「予算から引く」形にすると、符号桁が `out` に残ったまま予算だけ減って
    // **二重に数え**、貼れるはずの 1 文字が拒否される（review ラウンド 1 の must 3）
    const f = fld({ index: 1, row: 5, col: 10, length: 6, value: "1    -", numeric: true, signedNumeric: true });
    const w = mountGrid([f]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(1, 1);
    el.dispatchEvent(
      Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
        clipboardData: { getData: () => "9" }
      })
    );
    await nextTick();
    expect(notices(w)).not.toContain(MSG_NO_ROOM);
    expect(lastEdit(w)).toBe("19   -");
    w.unmount();
  });

  it("AC-I4 上書きモードなら従来どおり書ける（過剰に弾いていない）", async () => {
    const w = mountGrid([full()], false); // insertMode=false
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(2, 2);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "X", bubbles: true, cancelable: true }));
    await nextTick();
    expect(lastEdit(w)).toBe("ABXDE");
    expect(notices(w)).not.toContain(MSG_NO_ROOM);
    w.unmount();
  });

  it("AC-I4 空きがあれば挿入モードでも従来どおり右へずれる", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 5, value: "AB" })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(1, 1);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "X", bubbles: true, cancelable: true }));
    await nextTick();
    expect(lastEdit(w)).toBe("AXB");
    expect(notices(w)).not.toContain(MSG_NO_ROOM);
    w.unmount();
  });

  it("AC12 最終桁の上では、空きが残っていても弾く", async () => {
    // 欄長 5・値 "ABC" ＝末尾に空きがあるが、カーソルを最終桁（index 4）に置く
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 5, value: "ABC" })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(4, 4);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Z", bubbles: true, cancelable: true }));
    await nextTick();
    expect(notices(w)).toContain(MSG_NO_ROOM);
    expect(lastEdit(w)).toBeUndefined();
    w.unmount();
  });

  // -------------------------------------------------------------------------
  // `either` を取り置かない判断（`decisions.md` D5）を固定する。
  //
  // **この 2 本が無いと、D5 を逆に倒しても全テストが緑のまま通る**——実際に mutation で
  // 確かめて素通りした（`test-result.md` T20）。判断があるだけで回帰資産が無い状態だった。
  // -------------------------------------------------------------------------
  const dbcsFld = (t: "either" | "pure") =>
    fld({ index: 1, row: 5, col: 10, length: 6, dbcsType: t });

  async function typeFullWidth(t: "either" | "pure", n: number) {
    // **挿入モードで測る**——取り置きは挿入のときだけ効く（review ラウンド 1 の must 2）。
    // 当初これを上書きで書いており、「予算の検査はモードに依らない」という誤った前提だった
    const w = mountGrid([dbcsFld(t)], true);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    for (let i = 0; i < n; i++) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "\u5168", bubbles: true, cancelable: true }));
      await nextTick();
    }
    const out = { notices: notices(w), value: lastEdit(w) };
    w.unmount();
    return out;
  }

  // **SO/SI の分を数える**——孤立した全角 1 文字は SO+2+SI＝4 バイト、2 文字なら SO+4+SI＝6 バイト。
  // したがって 6 バイト欄では: 取り置き無し（either）なら全角 2 文字、
  // 取り置き 2 バイト（pure）なら 1 文字しか入らない。**ここで両者が割れる。**
  // **取り置きは挿入モードだけの話**（review ラウンド 1 の must 2）。
  // 上書きは桁を増やさないので予算を削ってはいけない——削ると 5250 の既定である
  // 上書きモードで、埋まった DBCS 欄に 1 文字も打てなくなる（退行）。
  it("上書きモードでは取り置きを掛けない（DBCS 専用欄・退行防止）", async () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 10, dbcsType: "only", value: "あいうえ" });
    const w = mountGrid([f], false); // 上書き
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "\u304b", bubbles: true, cancelable: true }));
    await nextTick();
    expect(notices(w)).not.toContain(MSG_NO_ROOM);
    expect(lastEdit(w)).toBe("かいうえ");
    w.unmount();
  });

  // **拒否したら、選択を消す前の状態へ戻す**（review ラウンド 2 の must）。
  // `deleteSelection` は `edit` を破壊的に書き換えるので、戻さずに `return` すると
  // モデル（選択が消えた）と DOM（選択が残った表示）がずれ、**次の打鍵で文字が勝手に消える**。
  it("DBCS 欄: 選択置換が入り切らなかったら、消す前の値へ戻す", async () => {
    // 予算 10 バイトに SBCS 8 桁。1 桁消して全角を入れると SO+2+SI で 11 バイト＝入らない
    const f = fld({ index: 1, row: 5, col: 10, length: 10, dbcsType: "open", value: "ABCDEFGH" });
    const w = mountGrid([f], false); // 上書き
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 1); // "A" を選択
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "\u5168", bubbles: true, cancelable: true }));
    await nextTick();
    expect(lastEdit(w), "入り切らないので値は書き換えない").toBeUndefined();

    // **次の打鍵で差が出る**。戻していれば "A" が残っているので X が A を置き換える。
    // 戻していなければ A は既に消えており、X が B を置き換えてしまう
    el.setSelectionRange(0, 0);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "X", bubbles: true, cancelable: true }));
    await nextTick();
    expect(lastEdit(w)).toBe("XBCDEFGH");
    w.unmount();
  });

  // **「挿入する余地がありません」は挿入モードのときだけ出す。**
  // 上書きで予算を超えたときに出すと筋が違う（挿入していないので）。
  // この規則は**対の片方だけ直す形でこの work で 4 回漏れた**ので、経路ごとに振る舞いで固定する。
  // ※ 走査テストでも止めようとしたが、位置ベースの判定では IME のゲート外しを取りこぼした
  //   （mutation で素通り）。**通ってしまうテストは偽の安心になる**ので振る舞いに寄せた。
  it("上書きモードの DBCS 打鍵で予算を超えても通知は出さない", async () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 6, dbcsType: "open", value: "Aあ" });
    const w = mountGrid([f], false); // 上書き
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(4, 4); // 末尾桁
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "\u5168", bubbles: true, cancelable: true }));
    await nextTick();
    // **拒否されたことを先に確かめる**——通っているなら「通知が無い」は当たり前で検査にならない
    expect(lastEdit(w), "予算を超えるので書き換わらないはず").toBeUndefined();
    expect(notices(w)).not.toContain(MSG_NO_ROOM);
    w.unmount();
  });

  it("上書きモードの IME 確定で予算を超えても通知は出さない", async () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 6, dbcsType: "open", value: "Aあ" });
    const w = mountGrid([f], false); // 上書き
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(2, 2);
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await nextTick();
    el.value = "Aあ全";
    el.dispatchEvent(new CompositionEvent("compositionend", { data: "全", bubbles: true }));
    await nextTick();
    expect(notices(w)).not.toContain(MSG_NO_ROOM);
    w.unmount();
  });

  // 通知の述語は**利用者の実モード**（`base.insertMode` は選択置換で true に化ける）
  it("上書きモードの DBCS 選択置換が入り切らなくても通知は出さない", async () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 10, dbcsType: "open", value: "ABCDEFGH" });
    const w = mountGrid([f], false); // 上書き
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 1);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "\u5168", bubbles: true, cancelable: true }));
    await nextTick();
    expect(lastEdit(w), "入り切らないので書き換わらないはず").toBeUndefined();
    expect(notices(w)).not.toContain(MSG_NO_ROOM);
    w.unmount();
  });

  // **IME の事前検査が 2 つ目の出口になっていた**（review ラウンド 5 の must）。
  // `rejected` を立てずに break していたので、消した選択がそのまま確定し送信値が 1 文字欠けた。
  it("挿入モードの IME: 満杯欄で拒否されても、消した選択が確定しない", async () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 5, value: "ABCDE" });
    const w = mountGrid([f], true); // 挿入モード
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(4, 5); // 最終桁 "E" を選択
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await nextTick();
    el.value = "ABCDX";
    el.dispatchEvent(new CompositionEvent("compositionend", { data: "X", bubbles: true }));
    await nextTick();
    const edits = ((w.emitted("edit") as unknown[][] | undefined) ?? []).map((a) => a[1]);
    // **"ABCD"（E が消えただけ）を確定してはいけない**
    expect(edits).not.toContain("ABCD");
    w.unmount();
  });

  // 選択置換の扱いを打鍵と IME で揃える（review ラウンド 5 の should）
  it("選択置換は打鍵でも IME でも同じ結果になる（最終桁・符号桁）", async () => {
    const run = async (kind: "key" | "ime", value: string, sel: [number, number], ch: string, signed = false) => {
      const f = fld({ index: 1, row: 5, col: 10, length: value.length, value, numeric: signed, signedNumeric: signed });
      const w = mountGrid([f], true);
      await nextTick();
      const el = firstInput(w);
      el.focus();
      el.setSelectionRange(sel[0], sel[1]);
      if (kind === "key") {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
      } else {
        el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        await nextTick();
        // **合成前の前置部分を含めた値を置く**——ハンドラは `composePrefixLen` から先だけを読む。
        // 前置を省くと「確定文字が 0 個」になり、経路の検査にならない（最初この形で空振りした）
        el.value = value.slice(0, sel[0]) + ch;
        el.dispatchEvent(new CompositionEvent("compositionend", { data: ch, bubbles: true }));
      }
      await nextTick();
      const out = lastEdit(w);
      w.unmount();
      return out;
    };
    expect(await run("ime", "ABCDE", [4, 5], "X")).toBe(await run("key", "ABCDE", [4, 5], "X"));
    expect(await run("ime", "12345-", [0, 1], "9", true)).toBe(await run("key", "12345-", [0, 1], "9", true));
  });

  // **`typeChar` は拒否すると同じ state を返す**ので、戻り値の真偽だけでは余地不足を検知できない。
  // 同一参照の判定を外すと、IME だけ無言で文字が落ちる（mutation で素通りしたので足した）。
  it("挿入モードの IME: 満杯欄なら値を変えず `MSG_NO_ROOM` を出す（選択なし）", async () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 5, value: "ABCDE" });
    const w = mountGrid([f], true); // 挿入モード
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(2, 2); // 選択なし・欄の途中
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await nextTick();
    el.value = "ABX"; // 前置 "AB" ＋ 確定文字 "X"
    el.dispatchEvent(new CompositionEvent("compositionend", { data: "X", bubbles: true }));
    await nextTick();
    const edits = ((w.emitted("edit") as unknown[][] | undefined) ?? []).map((a) => a[1]);
    expect(edits, "満杯なので値は変えない").not.toContain("ABXCD");
    expect(notices(w), "無言で落とさない").toContain(MSG_NO_ROOM);
    w.unmount();
  });

  // **合成状態の寿命**（review ラウンド 6 の must）。
  // `composeReplacedSelection` / `composeBeforeDelete` はモジュール変数で、
  // 合成の終わりで消さないと**次の合成が前の合成の控えで復元**する。
  // 別の欄で起きると**他欄の値が書き込まれて送信される**（元の不具合より重い）。
  it("前の合成の控えが、次の合成の欄へ漏れない", async () => {
    const f1 = fld({ index: 1, row: 5, col: 10, length: 8, value: "ABCDEFGH" });
    const f2 = fld({ index: 2, row: 6, col: 10, length: 8, value: "12345678" });
    const w = mountGrid([f1, f2], false);
    await nextTick();
    const els = Array.from(
      w.element.querySelectorAll("input.grid-input:not([readonly])")
    ) as HTMLInputElement[];

    // 欄 1: 選択置換で合成 → 確定（ここで控えが残る）
    els[0]!.focus();
    els[0]!.setSelectionRange(0, 1);
    els[0]!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await nextTick();
    els[0]!.value = "X";
    els[0]!.dispatchEvent(new CompositionEvent("compositionend", { data: "X", bubbles: true }));
    await nextTick();

    // 欄 2: **応答待ち（busy）中に合成を開始する**——`onCompositionStart` は `inhibited` で
    // 早期 return するので、**欄 1 の控えが残ったまま**になる。ここが再現の肝
    await w.setProps({ busy: true });
    await nextTick();
    els[1]!.focus();
    els[1]!.setSelectionRange(0, 0);
    els[1]!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await nextTick();
    await w.setProps({ busy: false }); // 応答が返って解除
    await nextTick();
    els[1]!.value = "";
    els[1]!.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true }));
    await nextTick();

    const edits = ((w.emitted("edit") as unknown[][] | undefined) ?? []) as [number, string][];
    const forField2 = edits.filter((e) => e[0] === 2).map((e) => e[1]);
    expect(forField2, "欄 2 に欄 1 の値が書き込まれてはいけない").not.toContain("ABCDEFGH");
    w.unmount();
  });

  // **同じ欄で 2 回合成する場合**（review ラウンド 6 の must の同一欄版）。
  // 欄番号の照合だけでは救えない——控えが残っていると**その欄の編集前の値へ巻き戻る**。
  // 合成状態を「開始のガードより前」で初期化していることが、ここで効く。
  it("同じ欄で合成し直しても、前の合成の控えで巻き戻らない", async () => {
    const f1 = fld({ index: 1, row: 5, col: 10, length: 8, value: "ABCDEFGH" });
    const w = mountGrid([f1], false);
    await nextTick();
    const el = firstInput(w);

    // 1 回目: 選択置換で確定（控えが作られる）
    el.focus();
    el.setSelectionRange(0, 1);
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await nextTick();
    el.value = "X";
    el.dispatchEvent(new CompositionEvent("compositionend", { data: "X", bubbles: true }));
    await nextTick();

    // 2 回目: **busy 中に開始**（開始が早期 return する）→ 解除後に確定文字 0 個で確定
    await w.setProps({ busy: true });
    await nextTick();
    el.setSelectionRange(2, 2);
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await nextTick();
    await w.setProps({ busy: false });
    await nextTick();
    el.value = "";
    el.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true }));
    await nextTick();

    const edits = ((w.emitted("edit") as unknown[][] | undefined) ?? []) as [number, string][];
    expect(edits.map((e) => e[1]), "編集前の値へ巻き戻してはいけない").not.toContain("ABCDEFGH");
    w.unmount();
  });

  // **欄末尾に止まっているときは「拒否」ではない**（review ラウンド 7 の must）。
  // `typeChar` は `cursor >= chars.length` でモードに関係なく同一参照を返すので、
  // それを無条件に拒否とみなすと**上書き中に挿入の文言が出て `field-full` が出なくなる**。
  it("上書きモードで欄末尾に止まっていても、通知を出さず field-full を出す", async () => {
    const f = fld({ index: 1, row: 5, col: 10, length: 5, value: "ABCDE" });
    const w = mountGrid([f], false); // 上書き（5250 の既定）
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(5, 5); // 欄末尾（cursor === len）
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "X", bubbles: true, cancelable: true }));
    await nextTick();
    expect(notices(w), "挿入していないのに挿入の文言を出さない").not.toContain(MSG_NO_ROOM);
    expect(w.emitted("field-full"), "満杯として次の欄へ送る合図は出す").toBeTruthy();
    w.unmount();
  });

  it("D5: `either` 欄は取り置かない——6 バイト欄に全角 2 文字が入る", async () => {
    const r = await typeFullWidth("either", 2);
    expect(r.notices).not.toContain(MSG_NO_ROOM);
    expect(r.value).toBe("全全");
  });

  it("D5: `pure` 欄は 2 バイト取り置く——全角 2 文字目で弾く", async () => {
    const r = await typeFullWidth("pure", 2);
    expect(r.notices).toContain(MSG_NO_ROOM);
    expect(r.value).toBe("全");
  });
});
