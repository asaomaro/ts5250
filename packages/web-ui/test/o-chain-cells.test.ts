import { describe, it, expect } from "vitest";
import { chainInsert, chainOverwrite, chainDelete, chainBackspace, type ChainPos, type ChainResult } from "../src/composables/oChainCells.js";
import { eraseToEnd, toCells, fromCells, nulCell, type OCell } from "../src/composables/oFieldCells.js";
import { DEAD_MARK, SO_MARK, SI_MARK, hasShiftMarks, dbcsByteLength, columnView } from "../src/composables/fieldValidate.js";

/**
 * **継続した O 欄の鎖の編集**（`20260928-cont-o-cells`）。期待値は実機の ACS のコアに同じ打鍵をさせてホストが受け取ったバイト列
 * （DSM の CONTOX・`scripts/acs-probe/cont-o-edit.txt`・research F2）を、区間ごとのセルの記法に直したもの:
 * `<` = SO、`>` = SI、全角は字（2 桁）、`_` = 空き（NUL）、`~` = 死んだ桁、`.` = 空白（0x40。中身）、ほかは半角。区間は 8 桁ずつ 3 つ。
 * 画面は先頭 `<いえ>X_`（い＝4482・え＝4484）・中間 `YZ______`・最終 空き
 */
function seg(spec: string): OCell[] {
  const out: OCell[] = [];
  for (const ch of spec) {
    if (ch === "<") out.push({ k: "so", ch: "" });
    else if (ch === ">") out.push({ k: "si", ch: "" });
    else if (ch === "_") out.push(nulCell());
    else if (ch === ".") out.push({ k: "sb", ch: " " });
    else if (ch === "~") out.push({ k: "sb", ch: " ", dead: true });
    else if (/[　-鿿]/.test(ch)) out.push({ k: "lead", ch }, { k: "tail", ch: "" });
    else out.push({ k: "sb", ch });
  }
  while (out.length < 8) out.push(nulCell());
  return out;
}
function show(cells: readonly OCell[]): string {
  let s = "";
  for (const c of cells) s += c.k === "so" ? "<" : c.k === "si" ? ">" : c.k === "tail" ? "" : c.dead ? "~" : c.nul ? "_" : c.ch === " " ? "." : c.ch;
  return s;
}
const start = (): OCell[][] => [seg("<いえ>X_"), seg("YZ"), seg("")];
function ok(r: ChainResult): { segs: string[]; cursor: ChainPos } {
  if (!("segs" in r)) throw new Error(`止まった: ${JSON.stringify(r)}`);
  return { segs: r.segs.map(show), cursor: r.cursor };
}

describe("継続した O 欄の挿入（ACS の 12 通りの測定）", () => {
  it("C01: SI の上に全角 → 先頭の区間が埋まり X が中間の区間へ。カーソルは区間の最後の SI を飛ばして中間の頭", () => {
    expect(ok(chainInsert(start(), { seg: 0, c: 5 }, "う"))).toEqual({ segs: ["<いえう>", "X_YZ____", "________"], cursor: { seg: 1, c: 0 } });
  });
  it("C02: 並びの直後の半角に全角 → SO が区間の最後の 2 桁に来るので並びごと中間へ送り、残りは死んだ桁", () => {
    expect(ok(chainInsert(start(), { seg: 0, c: 6 }, "え"))).toEqual({ segs: ["<いえ>~~", "<え>X_YZ", "________"], cursor: { seg: 1, c: 3 } });
  });
  it("C03: 中間の区間の頭に全角 → 中間の区間の中だけで入る（語送りの欄ではないので YZ は送らない）", () => {
    expect(ok(chainInsert(start(), { seg: 1, c: 0 }, "お"))).toEqual({ segs: ["<いえ>X_", "<お>YZ__", "________"], cursor: { seg: 1, c: 3 } });
  });
  it("C04: 並びの最初の全角に半角 → 受け付けて並びを割る（空の SO SI・字・SO…）。い の後ろは SI＋死んだ桁で閉じ、え は中間で開き直す", () => {
    expect(ok(chainInsert(start(), { seg: 0, c: 1 }, "Q"))).toEqual({ segs: ["<>Q<い>~", "<え>X_YZ", "________"], cursor: { seg: 0, c: 3 } });
  });
  it("C11: SO の上に全角 → SO の直後に入り、X は中間へ", () => {
    expect(ok(chainInsert(start(), { seg: 0, c: 0 }, "き"))).toEqual({ segs: ["<きいえ>", "X_YZ____", "________"], cursor: { seg: 0, c: 3 } });
  });
  it("C12: 並びの中に 2 字続けて → 2 字目で え が中間へ押し出され、先頭の区間は最後の桁の SI で閉じ中間は SO から", () => {
    const a = chainInsert(start(), { seg: 0, c: 3 }, "き");
    expect(ok(a)).toEqual({ segs: ["<いきえ>", "X_YZ____", "________"], cursor: { seg: 0, c: 5 } });
    const b = chainInsert((a as { segs: OCell[][] }).segs, { seg: 0, c: 5 }, "く");
    expect(ok(b)).toEqual({ segs: ["<いきく>", "<え>X_YZ", "________"], cursor: { seg: 1, c: 0 } });
  });
  it("死んだ桁は次の詰め直しで捨てる（C02 の後にもう 1 字——先頭の区間の死んだ桁の分だけ余地が戻る）", () => {
    const a = (chainInsert(start(), { seg: 0, c: 6 }, "え") as { segs: OCell[][] }).segs;
    // 先頭の区間の死んだ桁（6）に半角: 死んだ桁は捨てて字を置き、後ろ（中間の区間）はそのまま詰め直す
    expect(ok(chainInsert(a, { seg: 0, c: 6 }, "A"))).toEqual({ segs: ["<いえ>A~", "<え>X_YZ", "________"], cursor: { seg: 0, c: 7 } });
  });
  it("**区間をまたいで割れた並びは繋いでから詰め直す**（SI の直後の SO を取り除く。ACS `mergeDBCSString`）", () => {
    // C12 の後の形（先頭 `<いきく>`・中間 `<え>X_YZ`）で い に全角: き く え が 1 つの並びとして詰め直り、中間は SO から開き直す
    const a = [seg("<いきく>"), seg("<え>X_YZ"), seg("")];
    expect(ok(chainInsert(a, { seg: 0, c: 1 }, "あ")).segs).toEqual(["<あいき>", "<くえ>X_", "YZ______"]);
  });
  it("SO が区間の最後の 3 桁ちょうどなら送り、4 桁なら区間の中で始める", () => {
    expect(ok(chainInsert([seg("ABCDEX"), seg("")], { seg: 0, c: 5 }, "あ")).segs).toEqual(["ABCDE~~~", "<あ>X___"]);
    expect(ok(chainInsert([seg("ABCDX"), seg("")], { seg: 0, c: 4 }, "あ")).segs).toEqual(["ABCD<あ>", "X_______"]);
  });
  it("SI の上の全角で前半が区間の最後の 2 桁目に来たら、そこを SI・最後の桁を死んだ桁にして字は次の区間へ", () => {
    expect(ok(chainInsert([seg("ABC<あ>_"), seg("")], { seg: 0, c: 6 }, "い"))).toEqual({ segs: ["ABC<あ>~", "<い>____"], cursor: { seg: 1, c: 3 } });
  });
  it("余地は足りても、死んだ桁の分だけ溢れるなら 0012（ACS の試し書きが偽）", () => {
    // 余地 3＋8＝11・中身 9（SO 字 SI＋XYZ＋FG）だが、SO を送った 3 桁が死んだ桁になり G が入らない
    expect(chainInsert([seg("ABCDEXYZ"), seg("FG")], { seg: 0, c: 5 }, "あ")).toEqual({ error: 0x12 });
  });
  it("SI が区間の最後の桁のとき、その上の全角は 0012（ACS は前半・後半を区間の間で割る——当 PJ の値では持てない既知の差）", () => {
    // 実機の ACS: `SO い き く 44 | 81 え SI X…`（`scripts/acs-probe/cont-o-last-lead.txt`）
    expect(chainInsert([seg("<いきく>"), seg("<え>X_YZ"), seg("")], { seg: 0, c: 7 }, "あ")).toEqual({ error: 0x12 });
  });
  it("隣り合う SI SO を取り除いたら見直す（`SI SI SO SO` の外側の組も繋ぐ）", () => {
    expect(ok(chainInsert([seg("<あ>><<い>__"), seg("")], { seg: 0, c: 0 }, "A")).segs).toEqual(["A<あい>_____", "________"]);
  });
  it("収まらない挿入は 0012 で何も変えない（末尾の空きだけが余地）", () => {
    const full = [seg("<いえ>XA"), seg("BCDEFGHI"), seg("JKLMNOPQ")];
    expect(chainInsert(full, { seg: 0, c: 6 }, "Z")).toEqual({ error: 0x12 });
    expect(full.map(show)).toEqual(["<いえ>XA", "BCDEFGHI", "JKLMNOPQ"]);
  });
  it("並びの外の後半（表に無い位置）は 0012", () => {
    expect(chainInsert([[{ k: "sb", ch: "A" }, { k: "tail", ch: "" }, { k: "sb", ch: " " }]], { seg: 0, c: 1 }, "B")).toEqual({ error: 0x12 });
  });
  it("区間の最後のセルでも余地があれば入る（継続でない O 欄の最終セルの 0012 は無い）", () => {
    expect(ok(chainInsert([seg("ABCDEFG"), seg("")], { seg: 0, c: 7 }, "Z"))).toEqual({ segs: ["ABCDEFGZ", "________"], cursor: { seg: 1, c: 0 } });
  });
});

describe("継続した O 欄の上書き・Delete・Backspace・Erase EOF（ACS の測定）", () => {
  it("C05: 区間の終わりで全角が入らない → カーソルの次から区間の終わりを死んだ桁にし、中間の頭で打ち直す（X は残る）", () => {
    expect(ok(chainOverwrite(start(), { seg: 0, c: 6 }, "か"))).toEqual({ segs: ["<いえ>X~", "<か>____", "________"], cursor: { seg: 1, c: 3 } });
  });
  it("最終区間の終わりは従来のエラー（全角 0005）", () => {
    expect(chainOverwrite([seg(""), seg("ABCDEFG")], { seg: 1, c: 7 }, "か")).toEqual({ error: 0x05 });
  });
  it("区間の最後の桁に半角を上書きするとカーソルは次の区間の頭へ", () => {
    expect(ok(chainOverwrite(start(), { seg: 0, c: 7 }, "A")).cursor).toEqual({ seg: 1, c: 0 });
  });
  it("C06: 全角で Delete → 鎖全体を 2 桁詰め、中間の頭が先頭の区間の最後へ", () => {
    expect(ok(chainDelete(start(), { seg: 0, c: 1 }))).toEqual({ segs: ["<え>X_YZ", "________", "________"], cursor: { seg: 0, c: 1 } });
  });
  it("C07: 中間の頭で Backspace → 前の区間の最後の桁を消し、中間の頭が詰まる", () => {
    expect(ok(chainBackspace(start(), { seg: 1, c: 0 }))).toEqual({ segs: ["<いえ>XY", "Z_______", "________"], cursor: { seg: 0, c: 7 } });
  });
  it("C08: 並びの中で Erase EOF → SI で閉じて区間の残りを消す（続く区間の全消去は画面の側）", () => {
    expect(show(eraseToEnd(start()[0]!, 3, nulCell()))).toBe("<い>____");
  });
  it("鎖の頭の Backspace は 0005", () => {
    expect(chainBackspace(start(), { seg: 0, c: 0 })).toEqual({ error: 0x05 });
  });
  // 単独の SO/SI の Delete（実機の ACS のコア D1〜D8。`scripts/acs-probe/cont-o-lone-shift.txt`）: 0065 を出すが詰め直しは回る
  it("D1・D2: 単独の SO・SI の Delete は値を変えず 0065（欄は MDT のまま送られる）。カーソルも動かない", () => {
    for (const c of [0, 5]) {
      const r = chainDelete(start(), { seg: 0, c });
      expect(r).toMatchObject({ warn: 0x65, cursor: { seg: 0, c } });
      expect(ok(r).segs).toEqual(["<いえ>X_", "YZ______", "________"]);
    }
  });
  it("D3・D4: 単独の SO/SI の次の Backspace は 0065 で何もしない（詰め直しも回らない）", () => {
    expect(chainBackspace(start(), { seg: 0, c: 1 })).toEqual({ error: 0x65 });
    expect(chainBackspace(start(), { seg: 0, c: 6 })).toEqual({ error: 0x65 });
  });
  it("区間の頭の Backspace が前の区間の最後の単独の SI を消すときも、0065 を出したうえで詰め直しが回る（カーソルは消そうとした桁）", () => {
    const r = chainBackspace([seg("<いええ>"), seg("YZ"), seg("")], { seg: 1, c: 0 });
    expect(r).toMatchObject({ warn: 0x65, cursor: { seg: 0, c: 7 } });
    expect(ok(r).segs).toEqual(["<いええ>", "YZ______", "________"]);
  });
  it("D7・D8: 死んだ桁があるときは詰め直しで捨てられ、SI と SO の間が繋がる（SI でも SO でも同じ）", () => {
    const a = (chainInsert(start(), { seg: 0, c: 6 }, "え") as { segs: OCell[][] }).segs; // <いえ>~~ / <え>X_YZ
    for (const c of [5, 0]) {
      const r = chainDelete(a, { seg: 0, c });
      expect(r).toMatchObject({ warn: 0x65, cursor: { seg: 0, c } });
      expect(ok(r).segs).toEqual(["<いええ>", "X_YZ____", "________"]);
    }
  });
  it("死んだ桁の Delete は 2 桁（ACS: DBCSPlane が 0 でない桁）。区間の最後の 2 桁は次の区間の頭で上書きし、詰め直しで元の並びに戻る", () => {
    const a = (chainInsert(start(), { seg: 0, c: 6 }, "え") as { segs: OCell[][] }).segs; // <いえ>~~ / <え>X_YZ
    // 6 で 2 桁詰め: 6・7 ← 中間の頭 2 桁（SO・え の前半）、中間は 2 桁詰まる。詰め直しで SO がまた区間の最後の 2 桁に来るので、同じ形へ戻る
    expect(ok(chainDelete(a, { seg: 0, c: 6 }))).toEqual({ segs: ["<いえ>~~", "<え>X_YZ", "________"], cursor: { seg: 0, c: 6 } });
    // 死んだ桁 1 つの後ろに字があれば、その字も一緒に消える（2 桁）
    expect(ok(chainDelete([seg("AB~CD"), seg("")], { seg: 0, c: 2 })).segs).toEqual(["ABD_____", "________"]);
    // 半角の区間の死んだ桁も 2 桁ずつ消え、区間の最後の 2 桁は次の区間の頭（D E）。途中の空き（NUL）は中身として残る（捨てるのは死んだ桁だけ）
    const b = [seg("ABC~~"), seg("DE")];
    expect(ok(chainDelete(b, { seg: 0, c: 3 })).segs).toEqual(["ABC___DE", "________"]);
  });
});

describe("空き（NUL）と空白（0x40）の区別（実機の ACS の C09・C10・P4・P7・P8。`20260930-cont-o-nul`）", () => {
  it("C09: 空白で埋めた鎖への挿入は、空白を中身として最終区間まで押し出す（空きなら押し出さない）", () => {
    const spaces = [seg("<いえ>X."), seg("YZ......"), seg("")];
    expect(ok(chainInsert(spaces, { seg: 0, c: 5 }, "う"))).toEqual({ segs: ["<いえう>", "X.YZ....", "..______"], cursor: { seg: 1, c: 0 } });
    // 同じ形で空白でなく空きなら、末尾は詰めない
    const frees = [seg("<いえ>X_"), seg("YZ"), seg("")];
    expect(ok(chainInsert(frees, { seg: 0, c: 5 }, "う")).segs).toEqual(["<いえう>", "X_YZ____", "________"]);
  });

  it("空白で欄いっぱいまで埋まった鎖には、空きが無いので入らない（0012）。空きで埋まっていれば入る", () => {
    const full = [seg("<いえ>..."), seg("........"), seg("........")];
    expect(chainInsert(full, { seg: 0, c: 5 }, "う")).toEqual({ error: 0x12 });
    const empty = [seg("<いえ>___"), seg("________"), seg("________")];
    expect("segs" in chainInsert(empty, { seg: 0, c: 5 }, "う")).toBe(true);
  });

  it("Delete で末尾に空くのは空き（NUL）: 空白は中身のまま詰めて残る", () => {
    const r = ok(chainDelete([seg("<いえ>X."), seg("YZ"), seg("")], { seg: 0, c: 1 }));
    expect(r.segs).toEqual(["<え>X.YZ", "________", "________"]);
  });

  it("明示の並び（SO/SI の印入り）の中の U+0000 も空きのセル。列ビューでは空白 1 桁", () => {
    const v = [SO_MARK, "い", SI_MARK, "\u0000", "A"];
    expect(toCells(v, 8).map((c) => (c.nul ? "_" : c.k === "so" ? "<" : c.k === "si" ? ">" : c.k === "tail" ? "" : c.ch))).toEqual(["<", "い", "", ">", "_", "A", "_", "_"]);
    expect(columnView(v.join(""), "{", "}")).toBe("{い} A");
  });

  it("toCells / fromCells: U+0000 は空き（nul）のセルへ往復する。詰め物も空き", () => {
    const v = ["A", "\u0000", " ", "B"];
    const cells = toCells(v, 6);
    expect(cells.map((c) => (c.nul ? "_" : c.ch))).toEqual(["A", "_", " ", "B", "_", "_"]);
    expect(fromCells(cells)).toEqual(["A", "\u0000", " ", "B", "\u0000", "\u0000"]);
    expect(toCells(v, 5).map((c) => c.nul === true)).toEqual([false, true, false, false, true]);
  });
});

describe("死んだ桁の印（値の中の表し方）", () => {
  it("toCells / fromCells で往復し、明示の並びとして数える（半角だけの区間でも）", () => {
    const v = ["A", "B", DEAD_MARK, DEAD_MARK];
    expect(hasShiftMarks(v)).toBe(true);
    const cells = toCells(v, 4);
    expect(cells[2]).toEqual({ k: "sb", ch: " ", dead: true });
    expect(fromCells(cells)).toEqual(v);
    expect(dbcsByteLength(v.join(""))).toBe(4);
    expect(columnView([SO_MARK, "い", SI_MARK, DEAD_MARK].join(""), "{", "}")).toBe("{い} ");
  });
});
