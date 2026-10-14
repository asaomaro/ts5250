import { describe, it, expect } from "vitest";
import { renderFrame, paintDiff, sgrOf } from "../src/index.js";
import { sessionFrom, plain } from "./helpers.js";

const VP = { cols: 80, rows: 25 };

describe("renderFrame", () => {
  it("24 行 + 状態行を返し、文字が画面どおりに出る", async () => {
    const snap = (await sessionFrom("pub400-jobinfo")).snapshot();
    const f = renderFrame(snap, { viewport: VP, colorMode: "truecolor" });
    expect(f.rows).toHaveLength(25);
    expect(plain(f.rows[0]!)).toContain("IBM i Main Menu");
    expect(plain(f.rows[24]!)).toContain("入力可");
    expect(f.cursor).toEqual(snap.cursor);
  });

  it("各行は CUP で始まり、改行を使わない（桁ずれがスクロールに化けない）", async () => {
    const snap = (await sessionFrom("pub400-jobinfo")).snapshot();
    const f = renderFrame(snap, { viewport: VP, colorMode: "truecolor" });
    f.rows.forEach((r, i) => {
      expect(r.startsWith(`\x1b[${i + 1};1H`)).toBe(true);
      expect(r).not.toMatch(/[\r\n]/);
    });
  });

  it("全角は CHA で桁を固定し、右半分（tail）は描かない", async () => {
    const snap = (await sessionFrom("synthetic-dbcs", 1399)).snapshot();
    const f = renderFrame(snap, { viewport: VP, colorMode: "truecolor" });
    const row = f.rows[0]!;
    // SO は 7 桁目。日（8 桁目）の前に `\x1b[8G` が来る
    expect(row).toContain("\x1b[8G日");
    expect(plain(row)).toContain("日本語");
    // 日本語の 3 字ぶんで、桁の指定が 3 つ（2 桁ずつ進む: 8・10・12）
    expect(row).toContain("\x1b[10G本");
    expect(row).toContain("\x1b[12G語");
  });

  it("端末が小さければ切り、状態行で知らせる", async () => {
    const snap = (await sessionFrom("pub400-jobinfo")).snapshot();
    const f = renderFrame(snap, { viewport: { cols: 40, rows: 10 }, colorMode: "256" });
    expect(f.rows).toHaveLength(10);
    expect(plain(f.rows[9]!)).toContain("端末が小さい");
  });

  it("カーソルが切り詰めで見えないときは出さない", async () => {
    const snap = (await sessionFrom("pub400-jobinfo")).snapshot(); // カーソル 20/7
    const f = renderFrame(snap, { viewport: { cols: 80, rows: 10 }, colorMode: "256" });
    expect(f.cursor).toBeUndefined();
  });
});

describe("sgrOf（下線・桁区切りは画面定義に従う）", () => {
  const base = {
    char: "A", kind: "sbcs", color: "green", reverse: false, underline: false, blink: false,
    columnSeparator: false, nonDisplay: false
  } as const;
  it("underline が真なら実線の下線", () => {
    expect(sgrOf({ ...base, underline: true }, "truecolor")).toContain(";4m");
  });
  it("下線も桁区切りも無ければ下線を足さない", () => {
    expect(sgrOf({ ...base }, "truecolor")).not.toMatch(/;4/);
  });
  it("桁区切りだけなら点線の下線（4:4）", () => {
    expect(sgrOf({ ...base, columnSeparator: true }, "truecolor")).toContain("4:4");
  });
  it("反転・点滅を出す", () => {
    const s = sgrOf({ ...base, reverse: true, blink: true }, "256");
    expect(s).toContain(";7");
    expect(s).toContain(";5");
  });
});

describe("paintDiff", () => {
  it("同じフレームなら行を書かない（カーソルだけ）", async () => {
    const snap = (await sessionFrom("pub400-jobinfo")).snapshot();
    const f = renderFrame(snap, { viewport: VP, colorMode: "truecolor" });
    const out = paintDiff(f.rows, f);
    expect(out).not.toContain("IBM i");
    expect(out.startsWith("\x1b[?2026h")).toBe(true);
    expect(out.endsWith("\x1b[?2026l")).toBe(true);
  });
  it("変わった行だけを書く", async () => {
    const snap = (await sessionFrom("pub400-jobinfo")).snapshot();
    const a = renderFrame(snap, { viewport: VP, colorMode: "truecolor" });
    const b = renderFrame(snap, { viewport: VP, colorMode: "truecolor", note: "テスト" });
    // note は状態行だけを変える（システムメッセージが無いとき）
    const out = paintDiff(a.rows, b);
    expect(plain(out)).toContain("テスト");
    expect(plain(out)).not.toContain("IBM i Main Menu");
  });
});
