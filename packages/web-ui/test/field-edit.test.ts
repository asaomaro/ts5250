import { describe, it, expect } from "vitest";
import {
  initEdit,
  editValue,
  typeChar,
  backspace,
  del,
  moveCursor,
  home,
  end,
  toggleInsert,
  trailingRoom,
  reservedTail,
  paste
} from "../src/composables/fieldEdit.js";

describe("fieldEdit — 上書きモード（5250 既定）", () => {
  it("途中入力は後続をシフトせず置換する", () => {
    let s = initEdit("ABCDE", 5, 1); // cursor at B
    s = typeChar(s, "X");
    expect(editValue(s)).toBe("AXCDE"); // B が X に置換、C 以降そのまま
    expect(s.cursor).toBe(2);
  });

  it("フィールド満杯後の入力はブロックされる（5250: field-exit が必要）", () => {
    let s = initEdit("AB", 3, 2);
    s = typeChar(s, "C");
    expect(editValue(s)).toBe("ABC");
    expect(s.cursor).toBe(3); // 満杯位置
    s = typeChar(s, "D"); // 満杯のためブロック
    expect(editValue(s)).toBe("ABC");
  });
});

describe("fieldEdit — 挿入モード", () => {
  it("Insert トグルで挿入モードになり後続を右シフト（末尾溢れ）", () => {
    let s = initEdit("AB   ", 5, 1);
    s = toggleInsert(s);
    expect(s.insertMode).toBe(true);
    s = typeChar(s, "X");
    expect(editValue(s)).toBe("AXB  "); // B が右へ
  });
});

describe("fieldEdit — バックスペース/Delete", () => {
  it("バックスペースはカーソル左＋左詰め", () => {
    let s = initEdit("ABCDE", 5, 3); // cursor at D
    s = backspace(s);
    expect(editValue(s)).toBe("ABDE "); // C 削除、D 以降左詰め
    expect(s.cursor).toBe(2);
  });

  it("先頭でのバックスペースは無効", () => {
    let s = initEdit("ABC", 3, 0);
    s = backspace(s);
    expect(editValue(s)).toBe("ABC");
    expect(s.cursor).toBe(0);
  });

  it("Delete はカーソル位置削除＋左詰め", () => {
    let s = initEdit("ABCDE", 5, 1);
    s = del(s);
    expect(editValue(s)).toBe("ACDE ");
  });
});

describe("fieldEdit — カーソル移動", () => {
  it("Home/End/矢印", () => {
    let s = initEdit("AB   ", 5, 3);
    s = home(s);
    expect(s.cursor).toBe(0);
    s = end(s);
    expect(s.cursor).toBe(2); // "AB" の次
    s = moveCursor(s, -1);
    expect(s.cursor).toBe(1);
    s = moveCursor(s, 10);
    expect(s.cursor).toBe(5); // 末尾（len）でクランプ
  });

  it("矢印で末尾（len＝最終文字の後ろ）まで到達できる", () => {
    let s = initEdit("ABCDE", 5, 4); // 満杯・最終文字上
    s = moveCursor(s, 1);
    expect(s.cursor).toBe(5); // 末尾に止まれる（1 桁隣の欄外へ出ない）
    s = moveCursor(s, 1);
    expect(s.cursor).toBe(5); // クランプ
  });

  it("満杯欄でも末尾へ移動して Backspace で最終文字を削除できる", () => {
    let s = initEdit("ABCDE", 5, 0); // フルケタ
    s = end(s);
    expect(s.cursor).toBe(5); // End で末尾へ
    s = backspace(s);
    expect(editValue(s)).toBe("ABCD "); // 最終文字 E を削除
    expect(s.cursor).toBe(4);
  });

  it("末尾（len）での Delete は無操作（削除対象が無い）", () => {
    let s = initEdit("ABCDE", 5, 5);
    s = del(s);
    expect(editValue(s)).toBe("ABCDE");
    expect(s.cursor).toBe(5);
  });
});

describe("fieldEdit — paste", () => {
  it("複数文字を上書きモードで順に入力し超過は切り詰め", () => {
    let s = initEdit("     ", 5, 0);
    s = paste(s, "HELLO WORLD");
    expect(editValue(s)).toBe("HELLO"); // フィールド長 5 で切り詰め
  });
});

// ---------------------------------------------------------------------------
// 挿入モードの空き計算（`20260920-insert-mode-overflow`）
//
// ACS `PS5250.reserveRoomForInsert` の数え方に合わせる。**採否が割れる形**を選んで置く
// ——「取り置きがある／ない」だけでなく「**取り置きをどう効かせるか**」でも割れるため。
// ---------------------------------------------------------------------------
describe("trailingRoom — 末尾から数える", () => {
  const S = (s: string) => [...s];

  it("AC11: 末尾の連続空白だけを数える（途中の空白は数えない）", () => {
    // "AB  C " = 末尾 1 桁だけ空き。「どこかに空白があるか」で数えると 3 になる形
    expect(trailingRoom(S("AB  C "), { cursor: 0 })).toBe(1);
  });

  it("カーソルより手前は数えない", () => {
    // "AB    " の末尾空白は 4 だが、cursor=4 なら 2 までしか数えない
    expect(trailingRoom(S("AB    "), { cursor: 4 })).toBe(2);
  });

  it("末尾が非空白なら 0", () => {
    expect(trailingRoom(S("    12-"), { cursor: 0 })).toBe(0);
  });

  it("全角空白と NUL も空白として数える", () => {
    expect(trailingRoom(["A", "　", "\0"], { cursor: 0 })).toBe(2);
  });

  it("AC11c: **取り置きは開始位置をずらす。結果から引くのではない**", () => {
    // 符号付き数値欄の通常の形——符号は**最終桁**にある。
    // 開始位置をずらせば符号を飛ばして手前の空白 4 桁が見えるが、
    // 「末尾から数えてから 1 を引く」と 0-1 → 0 になり、**符号付き欄への挿入が全滅する**。
    // ここが両者を見分けられる唯一の形（design 改訂 3 の must 指摘）
    const chars = S("1    -");
    expect(trailingRoom(chars, { cursor: 1, reserved: 1 })).toBe(4);
    // 引き算だったら 0 になる、を明示しておく（退行したときに意図が読める）
    expect(Math.max(0, trailingRoom(chars, { cursor: 1 }) - 1)).toBe(0);
  });

  it("取り置きが欄長を超えても負にならない", () => {
    expect(trailingRoom(S("  "), { cursor: 0, reserved: 5 })).toBe(0);
  });
});

describe("reservedTail — 取り置く空白スロット数", () => {
  it("入力の組ごとに割れる（符号付き / DBCS / 両方 / どちらでもない）", () => {
    expect(reservedTail({})).toBe(0);
    expect(reservedTail({ signedNumeric: true })).toBe(1);
    expect(reservedTail({ dbcsReserved: true })).toBe(2); // 全角 1 文字ぶん
    expect(reservedTail({ signedNumeric: true, dbcsReserved: true })).toBe(3);
  });
});

describe("typeChar — 挿入モードで満杯のとき値を変えない", () => {
  const ins = (value: string, cursor: number) => ({ ...initEdit(value, value.length, cursor), insertMode: true });

  it("AC1: 満杯なら 1 桁も変わらない", () => {
    const s = ins("ABCDE", 2);
    expect(editValue(typeChar(s, "X"))).toBe("ABCDE");
  });

  it("AC5: 入り切るなら従来どおり（長さを保って右へずれる）", () => {
    const s = ins("AB   ", 1);
    const out = typeChar(s, "X");
    expect(editValue(out)).toBe("AXB  ");
    expect(out.chars.length).toBe(5);
  });

  it("AC2a: 符号付き数値欄で符号桁が落ちない（実機で観測した欠陥そのもの）", () => {
    // 実機では `-12` が `912` になっていた（test-result.md T1）
    const s = ins("    12-", 4);
    expect(editValue(typeChar(s, "9", { reserved: 1 }))).toBe("    12-");
  });

  // **`trailingRoom` が 4 を返すことと、`typeChar` が実際に挿せることは別**——
  // review ラウンド 1 の must 指摘。AC11c は純関数しか見ておらず、
  // 「数えた位置と捨てる位置が違う」欠陥を通していた（欄長 +1 に伸びて `fitsBytes` が落とす）。
  it("AC11c(typeChar): 符号桁が非空白でも、手前の空白を使って挿せる", () => {
    const s = ins("1    -", 1);
    const out = typeChar(s, "9", { reserved: 1 });
    expect(editValue(out)).toBe("19   -");
    expect(out.chars.length).toBe(6); // **欄長を超えて伸びない**
  });

  it("AC11c(typeChar): 取り置き桁は最後まで守られる（符号が押し出されない）", () => {
    let s = ins("1    -", 1);
    for (const ch of "999") s = typeChar(s, ch, { reserved: 1 });
    // "1" + 9 を 3 つ + 空白 1 + 符号。**符号は最後まで押し出されない**
    expect(editValue(s)).toBe("1999 -");
    expect(s.chars.length).toBe(6);
  });

  it("AC11b: 符号桁が空白なら、取り置きの有無で採否が割れる", () => {
    const s = ins("  123 ", 2);
    expect(editValue(typeChar(s, "9", { reserved: 1 }))).toBe("  123 "); // 取り置きあり → 弾く
    expect(editValue(typeChar(s, "9", { reserved: 0 }))).toBe("  9123"); // 取り置きなし → 通る
  });

  it("AC12: 最終桁の上では、空きが残っていても弾く（ACS `cursorSBA == getEndPos()`）", () => {
    const s = ins("ABC     Y ", 9); // 最終桁は空白＝空きはある
    expect(editValue(typeChar(s, "Z"))).toBe("ABC     Y ");
  });

  it("AC12: 上書きモードなら最終桁にも打てる（過剰に弾いていない）", () => {
    const s = { ...initEdit("ABC     Y ", 10, 9), insertMode: false };
    expect(editValue(typeChar(s, "Z"))).toBe("ABC     YZ");
  });

  it("空欄には普通に入る", () => {
    expect(editValue(typeChar(ins("     ", 0), "X"))).toBe("X    ");
  });

  it("全角（need=2）はバイト数を保ち、配列長が 1 減る", () => {
    const s = ins("AB    ", 1);
    const out = typeChar(s, "全", { need: 2 });
    expect(editValue(out)).toBe("A全B  ");
    expect(out.chars.length).toBe(5); // 空白 2 個を捨てて全角 1 個が入った
  });

  it("need=2 で空きが 1 桁しか無ければ弾く", () => {
    const s = ins("ABCD ", 1); // 末尾の空きは 1
    expect(editValue(typeChar(s, "全", { need: 2 }))).toBe("ABCD ");
  });

  it("AC-I2: 弾かれた打鍵は欄に何も残さない（state がそのまま返る）", () => {
    const s = ins("ABCDE", 2);
    expect(typeChar(s, "X")).toBe(s); // 同一参照＝新しい state すら作らない
  });
});

describe("AC6: ACS の参照コメントが実在する", () => {
  it("`fieldEdit.ts` に読んだクラス／メソッド名が書かれている", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // **コメントを落とす `code()` は使わない**（用途が逆。あれは「コメントで誤って緑になる」
    // のを防ぐもので、ここは逆にコメントの実在を見る）。
    // パスの組み立ては `field-at-contract.test.ts` と同じ流儀（`new URL` は vitest 環境で解決できない）
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "src", "composables", "fieldEdit.ts"), "utf8");
    expect(src).toContain("PS5250.reserveRoomForInsert");
    expect(src).toContain("PS5250.insertChar");
  });
});
