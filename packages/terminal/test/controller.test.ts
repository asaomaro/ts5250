import { describe, it, expect, vi } from "vitest";
import { TerminalController, KeyDecoder, type SessionLike } from "../src/index.js";
import { sessionFrom } from "./helpers.js";

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

  it("全角は第 1 段では受けない（値を変えない）", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const c = new TerminalController(s);
    await press(c, "日");
    expect(c.note).toContain("未対応");
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
