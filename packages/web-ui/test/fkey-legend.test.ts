import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Session5250, ReplayTransport, parseTraceJsonl } from "@as400web/tn5250";
import { detectFkeyLegends, detectWindowRect, rowText } from "../src/composables/fkeyLegend.js";
import type { Cell, ScreenSnapshot } from "@as400web/tn5250";

// ---- 合成スナップショットの組み立て（実機で観測した行をそのまま写す） ----

function cell(ch: string, kind: Cell["kind"] = "sbcs"): Cell {
  return { char: ch, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false };
}

/**
 * 行文字列（表示文字）から Cell 行を作る。全角は lead + tail の 2 セルにする
 * （実機と同じ「1 セル = 1 桁」）。
 */
function toCells(line: string, cols = 80): Cell[] {
  const out: Cell[] = [];
  for (const ch of line) {
    const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch);
    if (wide) {
      out.push(cell(ch, "dbcs-lead"));
      out.push(cell(" ", "dbcs-tail"));
    } else out.push(cell(ch));
  }
  while (out.length < cols) out.push(cell(" "));
  return out.slice(0, cols);
}

function snapOf(lines: string[], extra: Partial<ScreenSnapshot> = {}): ScreenSnapshot {
  const rows = 24;
  const cols = 80;
  const cells: Cell[][] = [];
  for (let r = 0; r < rows; r++) cells.push(toCells(lines[r] ?? "", cols));
  return {
    sessionId: "t", rows, cols, cursor: { row: 1, col: 1 }, keyboardLocked: false,
    cells, fields: [], ...extra,
  } as ScreenSnapshot;
}

describe("rowText（桁空間モデル・spec D1）", () => {
  it("全角の tail を飛ばし、文字列 index を正しい桁へ写す", () => {
    // "AB終了CD" → A=1 B=2 終=3(2桁) 了=5(2桁) C=7 D=8
    const rt = rowText(toCells("AB終了CD"), 80);
    expect(rt.text.startsWith("AB終了CD")).toBe(true);
    expect(rt.colOf.slice(0, 6)).toEqual([1, 2, 3, 5, 7, 8]);
    expect(rt.widthOf.slice(0, 6)).toEqual([1, 1, 2, 2, 1, 1]);
  });
});

describe("凡例検出（実機で観測した行）", () => {
  it("日本語メニューの 6 キーを DBCS 補正された桁で検出する", () => {
    // 実機の日本語メインメニュー下部（research で採取）
    const snap = snapOf([
      ...Array(21).fill(""),
      " F3= 終了    F4=プロンプト   F5= 最新表示    F12= 取り消し",
      " F13= この画面の使用法                    F24= キーの続き",
    ]);
    const got = detectFkeyLegends(snap);
    expect(got.map((s) => s.key)).toEqual(["F3", "F4", "F5", "F12", "F13", "F24"]);
    expect(got.map((s) => s.label)).toEqual(["終了", "プロンプト", "最新表示", "取り消し", "この画面の使用法", "キーの続き"]);
    // 桁は DBCS を 2 桁として数える。マジックナンバーではなく
    // 「その桁に実際に 'F' が立っている」という不変条件で確かめる（行を編集しても壊れない）。
    const rt = rowText(snap.cells[21]!, 80);
    for (const s of got.filter((x) => x.row === 22)) {
      expect(rt.text[rt.colOf.indexOf(s.col)]).toBe("F");
    }
    // 文字列 index と桁が実際にずれていること（ずれない実装なら検出が壊れている）
    const f12 = got.find((x) => x.key === "F12" && x.row === 22)!;
    expect(f12.col).toBeGreaterThan(rt.text.indexOf("F12") + 1);
  });

  it("語境界で REF3= や XF1= を拾わない", () => {
    const snap = snapOf([" ITEM  QTY   REF3=ABC   XF1=9"]);
    expect(detectFkeyLegends(snap)).toEqual([]);
  });

  it("F25 以上と、ラベルが空のものは拾わない", () => {
    const snap = snapOf([" F25=Nope   F3=     F4=OK"]);
    expect(detectFkeyLegends(snap).map((s) => s.key)).toEqual(["F4"]);
  });

  it("凡例の無い画面では 0 件（URL や広告文で誤検出しない）", () => {
    const snap = snapOf([
      "- Check out https://pub400.com for news, tools, chat, forum",
      "connect with SSH to port 2222 -> ssh username  -p 2222",
    ]);
    expect(detectFkeyLegends(snap)).toEqual([]);
  });
});

describe("窓の内側限定（spec D3・F1 ヘルプの実データ）", () => {
  // 実機の F1 ヘルプ（研究で採取した行をそのまま写す）。
  // 窓は `.`（上下端）と `:`（左右）で描かれ、gui.windows には出ない。
  const HELP = [
    "                              サインオフ  (SIGNOFF)",
    "",
    "  選択項目を入力して，実行キーを押してください。",
    "",
    "  ジョブ・ログ  . . . . . . . . . > 2NOLIST       *NOLIST, *LIST",
    "  回線切断  .  ................................................................",
    "  接続の終了   :                 ジョブ・ログ  (LOG) －ヘルプ                 :",
    "               :                                                             :",
    "               :  この対話式ジョブのジョブ・ログを削除するか，あるいは印刷の  :",
    "               :                                                              :",
    "               :                                                              :",
    "               :                                                              :",
    "               :                                                              :",
    "               :                                                              :",
    "               :                                                              :",
    "               :                                                              :",
    "               :                                                              :",
    "               :                                                              :",
    "               :                                                              :",
    "               :                                                    終わり    :",
    "               :  F2= 拡張ヘルプ   F3= ヘルプ終了   F10= 最初へ移動           :",
    " F3= 終了    F :  F12= 取消し      F13= 情報援助    F14= ヘルプの印刷         :",
    " F13= この画   :                                                              :",
    "  パラメータ   :..............................................................:",
  ];

  it("窓の矩形を罫線から検出する", () => {
    const rect = detectWindowRect(snapOf(HELP));
    expect(rect).not.toBeNull();
    expect(rect!.row1).toBe(7);
    expect(rect!.row2).toBe(23);
  });

  it("窓の中の凡例だけを採用し、下の画面の凡例は除外する", () => {
    const got = detectFkeyLegends(snapOf(HELP));
    expect(got.map((s) => s.key)).toEqual(["F2", "F3", "F10", "F12", "F13", "F14"]);
    // 下の画面の紛らわしい "F3= 終了"（押すと窓の文脈で「ヘルプ終了」になる）は入らない
    expect(got.filter((s) => s.col < 17)).toEqual([]);
    // 窓に隠れて切れた "F13= この画" も入らない（正しい F13 は窓の中のもの）
    expect(got.find((s) => s.key === "F13")!.label).toBe("情報援助");
  });

  it("ラベルに窓の罫線が混入しない", () => {
    const got = detectFkeyLegends(snapOf(HELP));
    expect(got.find((s) => s.key === "F10")!.label).toBe("最初へ移動");
    expect(got.every((s) => !/[.:：|│]/.test(s.label))).toBe(true);
  });

  it("窓が無い画面では画面全体が対象（点線の見出しを窓と誤認しない）", () => {
    const snap = snapOf([
      "  ジョブ・ログ  . . . . . . . . . > 2NOLIST",
      "  回線切断  . . . . . . . . . . . > *DEVD",
      ...Array(20).fill(""),
      " F3= 終了    F12= 取り消し",
    ]);
    expect(detectWindowRect(snap)).toBeNull();
    expect(detectFkeyLegends(snap).map((s) => s.key)).toEqual(["F3", "F12"]);
  });
});

describe("ホスト宣言の優先（spec FR-8）", () => {
  it("gui.selectionFields がある行では凡例を検出しない", () => {
    const lines = [" F3= 終了    F12= 取り消し"];
    const withGui = snapOf(lines, {
      gui: {
        selectionFields: [{ id: 1, row: 1, col: 2, kind: "pushbutton", fieldType: 0x11, multiple: false, choices: [] }],
        windows: [], scrollBars: [], gridLines: [],
      },
    } as Partial<ScreenSnapshot>);
    expect(detectFkeyLegends(withGui)).toEqual([]);
    // 宣言が無ければ従来どおり検出する
    expect(detectFkeyLegends(snapOf(lines)).map((s) => s.key)).toEqual(["F3", "F12"]);
  });

  it("拡張5250 の窓は中身の全行を拾う（先頭行・最終行を落とさない）", () => {
    // 実機 TESTLIB/EXTPGM の WINDOW: row=6 col=17 46桁×10行。
    // **ホストが送る位置は枠の左上**なので、中身は 1 行下・3 桁右の 行 7〜16 / 桁 20〜65。
    // 宣言された位置をそのまま中身と見なすと最終行と右端 4 桁が範囲から外れる。
    const lines = Array(24).fill("");
    lines[6] = " ".repeat(19) + "F2=先頭行";   // 窓の**先頭行**（r7・col 20）
    lines[13] = " ".repeat(31) + "F12=Cancel"; // 窓の中ほど（r14）
    lines[15] = " ".repeat(19) + "F5=最終行";   // 窓の**最終行**（r16）
    lines[0] = " F3=外側";                      // 窓の外（下の画面）
    const snap = snapOf(lines, {
      gui: {
        selectionFields: [],
        windows: [{ id: 1, row: 6, col: 17, width: 46, height: 10, restrictCursor: false, pulldown: false }],
        scrollBars: [], gridLines: [],
      },
    } as Partial<ScreenSnapshot>);
    const rect = detectWindowRect(snap)!;
    expect([rect.row1, rect.row2, rect.col1, rect.col2]).toEqual([7, 16, 20, 65]);
    // 先頭行・最終行の凡例も拾い、窓の外は拾わない
    expect(detectFkeyLegends(snap).map((s) => s.key)).toEqual(["F2", "F12", "F5"]);
  });

  it("gui.windows があればそれを窓として使う（罫線検出より優先）", () => {
    // 窓 row=3 col=3 40x4 → 中身は 行 4〜7 / 桁 6〜45
    const snap = snapOf([" F3= 外側", "", "", "      F12= 内側"], {
      gui: { selectionFields: [], windows: [{ id: 1, row: 3, col: 3, width: 40, height: 4, restrictCursor: false, pulldown: false }], scrollBars: [], gridLines: [] },
    } as Partial<ScreenSnapshot>);
    const got = detectFkeyLegends(snap);
    expect(got.map((s) => s.key)).toEqual(["F12"]);
  });
});

describe("実機キャプチャ（PUB400）での検出", () => {
  // vitest の cwd は packages/web-ui（AGENTS.md: web-ui のテストはパッケージ dir から実行する）
  const fixtures = join(process.cwd(), "../tn5250/test/fixtures");

  async function snapFromTrace(name: string): Promise<ScreenSnapshot> {
    const entries = parseTraceJsonl(readFileSync(join(fixtures, name), "utf8"));
    const s = await Session5250.connect({ transport: new ReplayTransport(entries), id: "t" });
    return s.snapshot()!;
  }

  it("メインメニューの 6 キーを検出する", async () => {
    const snap = await snapFromTrace("pub400-autosignon-menu.jsonl");
    const got = detectFkeyLegends(snap);
    expect(got.map((s) => s.key)).toEqual(["F3", "F4", "F9", "F12", "F13", "F23"]);
    expect(got.map((s) => s.label)).toEqual([
      "Exit", "Prompt", "Retrieve", "Cancel", "Information Assistant", "Set initial menu",
    ]);
    expect(got.find((s) => s.key === "F3")!.col).toBe(2);
  });

  it("サインオン画面では 0 件", async () => {
    const snap = await snapFromTrace("pub400-signon.jsonl");
    expect(detectFkeyLegends(snap)).toEqual([]);
  });
});

describe("占有幅はラベルと同じ切り出し（review R1）", () => {
  // 描画は「桁（width）」で切り出すため、ラベルから罫線を除いても幅に残っていると
  // **ボタンが隣の罫線を飲み込む**。両者を一致させる。
  it("罫線が密着していても、ボタンの幅に罫線を含めない", () => {
    const got = detectFkeyLegends(snapOf(["|F3=終了|"]));
    expect(got).toHaveLength(1);
    expect(got[0]!.label).toBe("終了");
    // 桁: | =1, F=2,3=3,==4, 終=5-6, 了=7-8, |=9 → 幅は 2〜8 の 7 桁
    expect(got[0]!.col).toBe(2);
    expect(got[0]!.width).toBe(7);
  });

  it("空白 1 個を挟んだ罫線も幅に含めない", () => {
    const got = detectFkeyLegends(snapOf([" F3=終了 :  F4=OK"]));
    expect(got.map((s) => [s.key, s.width])).toEqual([["F3", 7], ["F4", 5]]);
  });

  it("実データ（ラベルの後ろに空白 2 個以上）では幅が変わらない", () => {
    const got = detectFkeyLegends(snapOf([" F3= 終了    F12= 取り消し"]));
    // "F3= 終了" = F,3,=,空白,終(2),了(2) → 8 桁
    expect(got[0]!.width).toBe(8);
    expect(got[0]!.label).toBe("終了");
  });
});
