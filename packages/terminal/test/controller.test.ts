import { describe, it, expect, vi } from "vitest";
import { TerminalController, KeyDecoder, type SessionLike } from "../src/index.js";
import { sessionFrom } from "./helpers.js";
import { MSG_BY_REASON, MSG_NO_ROOM } from "../src/app/editing.js";
import { SO_MARK, SI_MARK } from "@ts5250/tn5250/edit/fieldValidate";

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
