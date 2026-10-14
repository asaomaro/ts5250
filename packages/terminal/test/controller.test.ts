import { describe, it, expect, vi } from "vitest";
import { TerminalController, KeyDecoder, type SessionLike } from "../src/index.js";
import { sessionFrom } from "./helpers.js";
import { overlayField } from "../src/app/overlay.js";
import { MSG_BY_REASON, MSG_NO_ROOM } from "../src/app/editing.js";
import type { Field } from "@ts5250/tn5250";
import type { KeyEvent } from "../src/index.js";
import { SO_MARK, SI_MARK, DEAD_MARK } from "@ts5250/tn5250/edit/fieldValidate";

const keys = (s: string) => new KeyDecoder().feed(s);
async function press(c: TerminalController, s: string): Promise<void> {
  for (const e of keys(s)) await c.handle(e);
}

describe("TerminalController（実機の記録を再生した本物の Session5250 で）", () => {
  it("サインオン画面: 入力欄に打ち、Tab でパスワード欄へ", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const c = new TerminalController(s);
    expect(c.cursor).toEqual({ row: 5, col: 25 });
    await press(c, "MYUSER");
    expect(s.snapshot().fields.find((f) => f.row === 5)?.value).toBe("MYUSER");
    expect(c.cursor).toEqual({ row: 5, col: 31 });
    await press(c, "\t");
    expect(c.cursor.row).toBe(6);
  });

  it("入力できない場所では何も書かず、知らせる", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const c = new TerminalController(s);
    c.cursor = { row: 1, col: 1 };
    await press(c, "x");
    expect(c.note).toContain("入力できません");
  });

  it("全角は半角欄に打てない（理由を示して値を変えない）", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const c = new TerminalController(s);
    await press(c, "日");
    expect(c.note).toBe(MSG_BY_REASON.alphanumeric);
    expect(s.snapshot().fields.find((f) => f.row === 5)?.value).toBe("");
  });

  it("Backspace は 1 桁戻って消す", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const c = new TerminalController(s);
    await press(c, "AB\x7f");
    expect(s.snapshot().fields.find((f) => f.row === 5)?.value).toBe("A");
    expect(c.cursor.col).toBe(26);
  });

  it("Enter で AID を送る（カーソル位置を添える）", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const spy = vi.spyOn(s, "sendAid");
    const c = new TerminalController(s);
    await press(c, "U\r");
    expect(spy).toHaveBeenCalledWith("Enter", { cursor: expect.objectContaining({ row: 5 }) });
  });

  it("矢印は画面の端で反対側へ巻く", async () => {
    const s = await sessionFrom("pub400-jobinfo");
    const c = new TerminalController(s);
    c.cursor = { row: 1, col: 1 };
    await press(c, "\x1b[D");
    expect(c.cursor).toEqual({ row: 24, col: 80 });
  });
});

describe("キー割り当て（偽のセッションで AID だけを見る）", () => {
  const fake = async () => {
    const real = await sessionFrom("pub400-jobinfo");
    const sent: string[] = [];
    const s: SessionLike = {
      snapshot: () => real.snapshot(),
      sendAid: async (k) => void sent.push(k),
      setField: () => {},
      dismissHostError: () => false,
      disconnect: () => {}
    };
    return { c: new TerminalController(s), sent };
  };

  it.each([
    ["\x1bOP", "F1"], ["\x1b[24~", "F12"], ["\x1b[1;2P", "F13"], ["\x1b[24;2~", "F24"],
    ["\x1b[5~", "PageUp"], ["\x1b[6~", "PageDown"], ["\r", "Enter"],
    ["\x1da", "Attn"], ["\x1ds", "SysReq"], ["\x1dh", "Help"], ["\x1dp", "Print"], ["\x1dc", "Clear"],
    ["\x1d1", "PA1"], ["\x1d3", "PA3"]
  ])("%j → %s", async (seq, aid) => {
    const { c, sent } = await fake();
    await press(c, seq);
    expect(sent).toEqual([aid]);
  });

  it("接頭キー + q で終了", async () => {
    const { c } = await fake();
    await press(c, "\x1dq");
    expect(c.quit).toBe(true);
  });

  it("入力禁止中は AID を送らない（SysReq・Attn は別）", async () => {
    const real = await sessionFrom("pub400-jobinfo");
    const sent: string[] = [];
    const s: SessionLike = {
      snapshot: () => ({ ...real.snapshot(), keyboardLocked: true }),
      sendAid: async (k) => void sent.push(k),
      setField: () => {}, dismissHostError: () => false, disconnect: () => {}
    };
    const c = new TerminalController(s);
    await press(c, "\r");
    await press(c, "\x1ds");
    expect(sent).toEqual(["SysReq"]);
  });
});

describe("TerminalController の編集（第 3 段）", () => {
  const valueOf = (s: Awaited<ReturnType<typeof sessionFrom>>, row: number): string | undefined =>
    s.snapshot().fields.find((f) => f.row === row)?.value;

  it("挿入モード: 途中に挿入して後ろを押し出す（Insert キー）", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const c = new TerminalController(s);
    await press(c, "AC\x1b[D\x1b[2~B");
    expect(c.insertMode).toBe(true);
    expect(valueOf(s, 5)).toBe("ABC");
    expect(c.cursor).toEqual({ row: 5, col: 27 });
  });

  it("接頭キーの i でも挿入を切り替える。Enter の後は上書きへ戻る", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const c = new TerminalController(s);
    await press(c, "\x1d");
    await press(c, "i");
    expect(c.insertMode).toBe(true);
    await press(c, "\r");
    expect(c.insertMode).toBe(false);
  });

  it("Delete は後ろを左へ詰める", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const c = new TerminalController(s);
    await press(c, "ABC\x1b[D\x1b[D\x1b[D\x1b[3~");
    expect(valueOf(s, 5)).toBe("BC");
    expect(c.cursor).toEqual({ row: 5, col: 25 });
  });

  it("行をまたぐ欄（コマンド行）: 行末の次の字は次の行の 1 桁目へ続く", async () => {
    const s = await sessionFrom("pub400-jobinfo");
    const c = new TerminalController(s);
    c.cursor = { row: 20, col: 80 };
    await press(c, "XY");
    const f = s.snapshot().fields.find((x) => !x.protected)!;
    expect(f.value.slice(73, 75)).toBe("XY");
    expect(c.cursor).toEqual({ row: 21, col: 2 });
  });

  it("Field Exit は以降を消して次の入力欄へ", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const c = new TerminalController(s);
    await press(c, "ABCD\x1b[D\x1b[D");
    await press(c, "\x1d");
    await press(c, "e");
    expect(valueOf(s, 5)).toBe("AB");
    expect(c.cursor.row).toBe(6);
  });
});

/** O 欄（SO/SI を桁に持つ）は実機の記録に無いので、記録の画面の入力欄を O 欄に置き換えた偽のセッションで糊を確かめる */
describe("TerminalController の O 欄（SO/SI 補完）", () => {
  async function openSession() {
    const real = await sessionFrom("pub400-signon-to-menu");
    const base = real.snapshot();
    const f0 = base.fields.find((f) => !f.protected)!;
    const snap = { ...base, fields: base.fields.map((f) => (f === f0 ? { ...f, dbcsType: "open" as const } : f)) };
    const writes: string[] = [];
    const sess: SessionLike = {
      snapshot: () => snap,
      sendAid: async () => undefined,
      setField: (_t, v) => void writes.push(v),
      dismissHostError: () => false,
      disconnect: () => undefined
    };
    return { sess, writes, f0 };
  }

  it("全角を打つと SO 字 SI を補い、カーソルは SO 字の直後へ", async () => {
    const { sess, writes, f0 } = await openSession();
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: f0.row, col: f0.col };
    await press(c, "日");
    expect(writes.at(-1)).toBe(`${SO_MARK}日${SI_MARK}`);
    expect(c.cursor).toEqual({ row: f0.row, col: f0.col + 3 });
  });

  it("半角はそのまま打てる", async () => {
    const { sess, writes, f0 } = await openSession();
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: f0.row, col: f0.col };
    await press(c, "A");
    expect(writes.at(-1)).toBe("A");
    expect(c.note).toBe("");
  });

  it("MSG の語彙を実体で参照している", () => {
    expect(MSG_NO_ROOM).toBe("挿入する余地がありません");
  });
});

/** 継続欄・語送り欄は実機の記録に無いので、記録の画面の欄を書き換えた偽のセッションで糊を確かめる（実機は未確認） */
describe("TerminalController の継続欄・語送り欄（第 4 段）", () => {
  async function fake(fieldsOf: (proto: Field) => Field[]) {
    const real = await sessionFrom("pub400-signon-to-menu");
    const base = real.snapshot();
    const proto = base.fields.find((f) => !f.protected)!;
    const fields = fieldsOf(proto);
    const snap = { ...base, fields };
    const sess: SessionLike = {
      snapshot: () => snap,
      sendAid: async () => undefined,
      setField: (t, v) => {
        const f = fields.find((x) => x.index === t.index);
        if (f) f.value = v;
      },
      dismissHostError: () => false,
      disconnect: () => undefined
    };
    return { sess, fields };
  }
  const seg = (proto: Field, index: number, col: number, cont: "first" | "middle" | "last", value: string) =>
    ({ ...proto, index, row: 5, col, length: 2, continued: cont, value });

  it("継続欄: 区間の終わりまで打つと次の区間の先頭へ進む", async () => {
    const { sess, fields } = await fake((p) => [seg(p, 90, 10, "first", ""), seg(p, 91, 13, "middle", ""), seg(p, 92, 16, "last", "")]);
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: 5, col: 10 };
    await press(c, "123");
    expect(fields.map((f) => f.value)).toEqual(["12", "3", ""]);
    expect(c.cursor).toEqual({ row: 5, col: 14 });
  });

  it("継続欄: Delete は区間をまたいで詰める。Backspace は区間の頭で前の区間の末尾を消す", async () => {
    const { sess, fields } = await fake((p) => [seg(p, 90, 10, "first", "12"), seg(p, 91, 13, "middle", "34"), seg(p, 92, 16, "last", "56")]);
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: 5, col: 10 };
    await c.handle({ kind: "key", name: "Delete" } as KeyEvent);
    expect(fields.map((f) => f.value)).toEqual(["23", "45", "6"]);
    c.cursor = { row: 5, col: 13 };
    await c.handle({ kind: "key", name: "Backspace" } as KeyEvent);
    expect(fields.map((f) => f.value)).toEqual(["24", "56", ""]);
    expect(c.cursor).toEqual({ row: 5, col: 11 });
  });

  it("継続欄: Field Exit は続く区間まで消す", async () => {
    const { sess, fields } = await fake((p) => [seg(p, 90, 10, "first", "12"), seg(p, 91, 13, "middle", "34"), seg(p, 92, 16, "last", "56")]);
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: 5, col: 11 };
    await press(c, "\x1d" + "e");
    expect(fields.map((f) => f.value)).toEqual(["1", "", ""]);
  });

  it("語送り: 行末にかかった語は次の行へ送り、行の残りは空き（NUL）で埋める", async () => {
    const { sess, fields } = await fake((p) => [{ ...p, index: 90, row: 5, col: 75, length: 10, wordWrap: true, monocase: false, value: "ab cd" }]);
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: 5, col: 80 };
    await press(c, "e");
    expect(fields[0].value).toBe(`ab ${DEAD_MARK}${DEAD_MARK}${DEAD_MARK}cde`);
    expect(c.note).toBe("");
  });
});

describe("TerminalController の継続した O 欄（鎖）", () => {
  it("全角を打つと区間の終わりで次の区間へ送る（実機は未確認。偽のセッション）", async () => {
    const real = await sessionFrom("pub400-signon-to-menu");
    let snap = real.snapshot();
    const proto = snap.fields.find((f) => !f.protected)!;
    const mk = (index: number, col: number, cont: "first" | "last"): Field =>
      ({ ...proto, index, row: 5, col, length: 4, dbcsType: "open", continued: cont, value: "" });
    snap = { ...snap, fields: [mk(90, 10, "first"), mk(91, 20, "last")] };
    const sess: SessionLike = {
      snapshot: () => snap,
      sendAid: async () => undefined,
      setField: (t, v) => {
        const f = snap.fields.find((x) => x.index === t.index)!;
        snap = overlayField(snap, f, v);
      },
      dismissHostError: () => false,
      disconnect: () => undefined
    };
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: 5, col: 10 };
    await press(c, "日本");
    const second = snap.fields.find((f) => f.index === 91)!.value;
    expect([...second].some((ch) => ch === "本")).toBe(true);
    expect(c.note).toBe("");
  });
});

/** J・E・G 欄は実機の記録に無いので、記録の画面の欄を書き換えた偽のセッションで糊を確かめる（実機は未確認） */
describe("TerminalController の J・E・G 欄（第 6 段）", () => {
  async function fakeJeg(type: "only" | "pure" | "either", length: number, cellsOf?: (proto: import("@ts5250/tn5250").Cell) => import("@ts5250/tn5250").Cell[]) {
    const real = await sessionFrom("pub400-signon-to-menu");
    let snap = real.snapshot();
    const proto = snap.fields.find((f) => !f.protected)!;
    const field: Field = { ...proto, index: 90, row: 5, col: 10, length, dbcsType: type, value: "", fieldExitRequired: true };
    // 欄の下の画面の文字を空き（生バイトを持たない空白）にする
    const blank = snap.cells.map((r, i) => (i === 4 ? r.map((c) => { const b = { ...c, kind: "sbcs" as const, char: " " }; delete b.rawByte; return b; }) : r));
    snap = { ...snap, cells: blank, fields: [field] };
    const writes: string[] = [];
    const sess: SessionLike = {
      snapshot: () => snap,
      sendAid: async () => undefined,
      setField: (_t, v) => {
        writes.push(v);
        snap = overlayField(snap, field, v);
      },
      dismissHostError: () => false,
      disconnect: () => undefined
    };
    void cellsOf;
    return { sess, writes };
  }

  it("J: 全角を打つと SO 字 NUL の組 SI の形で送り、半角の空白は全角空白になる", async () => {
    const { sess, writes } = await fakeJeg("only", 10);
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: 5, col: 10 };
    await press(c, "日");
    expect(writes.at(-1)).toBe(`${SO_MARK}日${DEAD_MARK.repeat(6)}${SI_MARK}`);
    expect(c.cursor).toEqual({ row: 5, col: 13 });
    await press(c, " ");
    expect(writes.at(-1)).toBe(`${SO_MARK}日\u3000${DEAD_MARK.repeat(4)}${SI_MARK}`);
  });

  it("J: 半角は打てない", async () => {
    const { sess, writes } = await fakeJeg("only", 10);
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: 5, col: 10 };
    await press(c, "A");
    expect(writes).toEqual([]);
    expect(c.note).toBe(MSG_BY_REASON["dbcs-required"]);
  });

  it("G: SO/SI なしで全角空白を詰める。欄いっぱいまで打つと余地なし", async () => {
    const { sess, writes } = await fakeJeg("pure", 4);
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: 5, col: 10 };
    await press(c, "日本");
    expect(writes.at(-1)).toBe("日本");
    await press(c, "語");
    expect(c.note).not.toBe("");
  });

  it("E: 最初の字で半角・全角が決まり、途中で混ぜると理由を示して断る", async () => {
    const { sess, writes } = await fakeJeg("either", 10);
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: 5, col: 10 };
    await press(c, "A");
    expect(writes.at(-1)).toBe("A");
    await press(c, "日");
    expect(c.note).toContain("半角で入力中");
    expect(writes.at(-1)).toBe("A");
  });

  it("J: 挿入は空きの桁へ押し出す", async () => {
    const { sess, writes } = await fakeJeg("only", 12);
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: 5, col: 11 };
    await press(c, "あい");
    c.cursor = { row: 5, col: 11 };
    await c.handle({ kind: "key", name: "Insert" } as KeyEvent);
    await press(c, "う");
    expect(c.note).toBe("");
    expect(writes.at(-1)).toBe(`${SO_MARK}うあい${DEAD_MARK.repeat(4)}${SI_MARK}`);
  });

  it("J: ホストが全角空白で埋めた欄にも挿入できる（末尾の全角空白は空き）", async () => {
    const { sess, writes } = await fakeJeg("only", 12);
    const c = new TerminalController(sess, { sbcsOnly: false });
    c.cursor = { row: 5, col: 11 };
    await press(c, "あい\u3000\u3000\u3000");
    c.cursor = { row: 5, col: 11 };
    await c.handle({ kind: "key", name: "Insert" } as KeyEvent);
    await press(c, "う");
    expect(c.note).toBe("");
    expect(writes.at(-1)).toBe(`${SO_MARK}うあい\u3000\u3000${SI_MARK}`);
  });
});
