import { describe, it, expect } from "vitest";
import { overlayField } from "../src/app/overlay.js";
import { sessionFrom } from "./helpers.js";
import { SO_MARK, SI_MARK } from "@ts5250/tn5250/edit/fieldValidate";

describe("overlayField（編集値を画面へ重ねる）", () => {
  it("文字を桁へ置き、属性は元の桁のまま。元の画面は変えない", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const snap = s.snapshot();
    const f = snap.fields.find((x) => !x.protected)!;
    const out = overlayField(snap, f, "AB");
    const row = out.cells[f.row - 1]!;
    expect(row[f.col - 1]!.char).toBe("A");
    expect(row[f.col]!.char).toBe("B");
    expect(row[f.col - 1]!.underline).toBe(snap.cells[f.row - 1]![f.col - 1]!.underline);
    expect(out.fields.find((x) => x.index === f.index)!.value).toBe("AB");
    expect(snap.cells[f.row - 1]![f.col - 1]!.char).toBe(" ");
  });

  it("O 欄の SO/SI の印と全角（2 桁）を桁の種類へ展開する", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const snap = s.snapshot();
    const f = snap.fields.find((x) => !x.protected)!;
    const out = overlayField(snap, f, `${SO_MARK}日${SI_MARK}`);
    const kinds = out.cells[f.row - 1]!.slice(f.col - 1, f.col + 3).map((c) => c.kind);
    expect(kinds).toEqual(["so", "dbcs-lead", "dbcs-tail", "si"]);
  });

  it("非表示の欄は値を伏せる", async () => {
    const s = await sessionFrom("pub400-signon-to-menu");
    const snap = s.snapshot();
    const f = snap.fields.find((x) => x.hidden)!;
    const out = overlayField(snap, f, "SECRET");
    expect(out.cells[f.row - 1]!.slice(f.col - 1, f.col + 5).map((c) => c.char).join("")).toBe("      ");
  });
});
