import { describe, it, expect } from "vitest";
import { VtParser } from "../src/protocol/parser.js";
import { VtTerminal } from "../src/screen/terminal.js";
import type { VtCell } from "../src/screen/types.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 列を食わせて端末を返す（返り値のバイト列も取れる） */
function run(seq: string, rows = 6, cols = 20): { t: VtTerminal; replies: string[] } {
  const t = new VtTerminal(rows, cols, 100);
  const p = new VtParser();
  const replies = t.handle(p.feed(enc.encode(seq)));
  return { t, replies: replies.map((b) => dec.decode(b)) };
}

const lines = (t: VtTerminal): string[] =>
  t.snapshot().cells.map((r) => r.map((c: VtCell) => (c.width === 0 ? "" : c.char)).join("").replace(/ +$/u, ""));

const at = (t: VtTerminal, row: number, col: number): VtCell => t.snapshot().cells[row]![col]!;

describe("印字とカーソル", () => {
  it("普通に書ける", () => {
    const { t } = run("hello");
    expect(lines(t)[0]).toBe("hello");
    expect(t.buffer.col).toBe(5);
  });

  it("CUP で位置を決める（1 起点）", () => {
    const { t } = run("\x1b[3;5HX");
    expect(lines(t)[2]).toBe("    X");
  });

  it("CR / LF", () => {
    const { t } = run("ab\r\ncd");
    expect(lines(t).slice(0, 2)).toEqual(["ab", "cd"]);
  });

  it("**LF は桁を変えない**（LNM が無効なら CR は要る）", () => {
    const { t } = run("ab\ncd");
    expect(lines(t).slice(0, 2)).toEqual(["ab", "  cd"]);
  });

  it("`ESC[20h`（LNM）を立てると LF で行頭へも動く", () => {
    const { t } = run("\x1b[20hab\ncd");
    expect(lines(t).slice(0, 2)).toEqual(["ab", "cd"]);
  });

  it("BS は 1 桁戻る", () => {
    const { t } = run("abc\b\bX");
    expect(lines(t)[0]).toBe("aXc");
  });

  it("移動は画面の外へ出ない", () => {
    const { t } = run("\x1b[99;99HX", 6, 20);
    expect(lines(t)[5]).toBe("                   X");
  });
});

describe("遅延折返し（DEC の要）", () => {
  it("**右端に書いた直後はまだ折り返さない**", () => {
    const { t } = run("A".repeat(20), 6, 20);
    expect(t.buffer.row).toBe(0);
    expect(t.buffer.col).toBe(19);
    expect(lines(t)[1]).toBe("");
  });

  it("次の文字が来てはじめて行が変わる", () => {
    const { t } = run("A".repeat(20) + "B", 6, 20);
    expect(lines(t)[0]).toBe("A".repeat(20));
    expect(lines(t)[1]).toBe("B");
  });

  it("**右端ちょうどのあとに CRLF が来ても空行を作らない**（ls の桁揃えで頻出）", () => {
    const { t } = run("A".repeat(20) + "\r\nB", 6, 20);
    expect(lines(t)[0]).toBe("A".repeat(20));
    expect(lines(t)[1]).toBe("B");
    expect(lines(t)[2]).toBe("");
  });

  it("DECAWM を切ると右端で上書きし続ける", () => {
    const { t } = run("\x1b[?7l" + "A".repeat(25), 6, 20);
    expect(lines(t)[0]).toBe("A".repeat(20));
    expect(lines(t)[1]).toBe("");
  });
});

describe("消去", () => {
  it("ED 2 で画面全体", () => {
    const { t } = run("abc\r\ndef\x1b[2J");
    expect(lines(t).every((l) => l === "")).toBe(true);
  });

  it("EL 0 はカーソルから右", () => {
    const { t } = run("abcdef\x1b[1;3H\x1b[0K");
    expect(lines(t)[0]).toBe("ab");
  });

  it("EL 1 は左からカーソルまで（**カーソル位置も含む**）", () => {
    const { t } = run("abcdef\x1b[1;3H\x1b[1K");
    expect(lines(t)[0]).toBe("   def");
  });

  it("ECH は桁を詰めずに空白へ", () => {
    const { t } = run("abcdef\x1b[1;2H\x1b[3X");
    expect(lines(t)[0]).toBe("a   ef");
  });

  it("**消去は現在の背景色で埋める**（xterm と同じ）", () => {
    const { t } = run("\x1b[41m\x1b[2J");
    expect(at(t, 0, 0).style.bg).toEqual({ kind: "indexed", index: 1 });
  });
});

/**
 * **消去は背景色だけを引き継ぐ**（BCE = Back Color Erase）。
 *
 * 実機の pub400 で「下線を出したまま画面消去が来ると空行すべてに横罫が走る」
 * 「反転のまま消すと画面が地色で埋まる」が出た。xterm / DEC は消去に**背景色しか**
 * 使わないので、ここでその規則を全部の消去系に固定する。
 */
describe("消去の見た目（BCE）", () => {
  /** 「消えた桁」の見た目。既定へ戻っているべき項目をまとめて見る */
  const erased = (t: VtTerminal, row: number, col: number) => {
    const s = at(t, row, col).style;
    return { bold: s.bold, underline: s.underline, reverse: s.reverse, blink: s.blink, fg: s.fg };
  };
  const plain = { bold: false, underline: false, reverse: false, blink: false, fg: { kind: "default" } };

  it("**下線が有効なまま ED しても消えた桁は下線を持たない**（空行に横罫が走らない）", () => {
    const { t } = run("abc\x1b[4m\x1b[2J");
    expect(at(t, 0, 0).style.underline).toBe(false);
    expect(at(t, 3, 10).style.underline).toBe(false);
  });

  it("**反転が有効なまま ED しても画面が反転の地色にならない**", () => {
    const { t } = run("\x1b[7m\x1b[2J");
    expect(at(t, 0, 0).style.reverse).toBe(false);
  });

  it("太字・点滅・前景色も既定へ戻す", () => {
    const { t } = run("\x1b[1;5;31m\x1b[2J");
    expect(erased(t, 0, 0)).toEqual(plain);
  });

  it("**背景色だけは引き継ぐ**（SGR 41 → ED でセルの bg が赤）", () => {
    const { t } = run("\x1b[41m\x1b[2J");
    expect(at(t, 0, 0).style.bg).toEqual({ kind: "indexed", index: 1 });
    expect(erased(t, 0, 0)).toEqual(plain);
  });

  it("下線＋背景色でも背景色だけが残る", () => {
    const { t } = run("\x1b[4;44m\x1b[2J");
    expect(at(t, 2, 3).style.bg).toEqual({ kind: "indexed", index: 4 });
    expect(at(t, 2, 3).style.underline).toBe(false);
  });

  it("ED 0 / ED 1 も同じ規則", () => {
    expect(erased(run("\x1b[3;3H\x1b[4;41m\x1b[0J").t, 4, 0)).toEqual(plain);
    expect(erased(run("\x1b[3;3H\x1b[4;41m\x1b[1J").t, 0, 0)).toEqual(plain);
    expect(at(run("\x1b[3;3H\x1b[4;41m\x1b[0J").t, 4, 0).style.bg).toEqual({ kind: "indexed", index: 1 });
  });

  it("EL / ECH も同じ規則", () => {
    expect(erased(run("abcdef\x1b[4;41m\x1b[1;3H\x1b[0K").t, 0, 3)).toEqual(plain);
    expect(erased(run("abcdef\x1b[4;41m\x1b[1;3H\x1b[1K").t, 0, 0)).toEqual(plain);
    expect(erased(run("abcdef\x1b[4;41m\x1b[1;2H\x1b[3X").t, 0, 2)).toEqual(plain);
    expect(at(run("abcdef\x1b[4;41m\x1b[1;2H\x1b[3X").t, 0, 2).style.bg).toEqual({ kind: "indexed", index: 1 });
  });

  it("**挿入・削除で新しく現れる桁**も同じ規則（ICH / DCH）", () => {
    // ICH: 押し出したあとに空く桁
    const ich = run("abcdef\x1b[4;41m\x1b[1;2H\x1b[2@").t;
    expect(erased(ich, 0, 1)).toEqual(plain);
    expect(at(ich, 0, 1).style.bg).toEqual({ kind: "indexed", index: 1 });
    // DCH: 詰めたあとに右端へ足す桁
    const dch = run("abcdef\x1b[4;41m\x1b[1;2H\x1b[2P").t;
    expect(erased(dch, 0, 19)).toEqual(plain);
    expect(at(dch, 0, 19).style.bg).toEqual({ kind: "indexed", index: 1 });
  });

  it("**挿入・削除で新しく現れる行**も同じ規則（IL / DL）", () => {
    const il = run("a\r\nb\r\nc\x1b[4;41m\x1b[2;1H\x1b[1L").t;
    expect(erased(il, 1, 0)).toEqual(plain);
    expect(at(il, 1, 0).style.bg).toEqual({ kind: "indexed", index: 1 });
    const dl = run("a\r\nb\r\nc\x1b[4;41m\x1b[2;1H\x1b[1M").t;
    expect(erased(dl, 5, 0)).toEqual(plain);
  });

  it("**スクロールで湧く行**も同じ規則（SU / SD）", () => {
    expect(erased(run("\x1b[4;7;41m\x1b[2S").t, 5, 0)).toEqual(plain);
    expect(at(run("\x1b[4;7;41m\x1b[2S").t, 5, 0).style.bg).toEqual({ kind: "indexed", index: 1 });
    expect(erased(run("\x1b[4;7;41m\x1b[2T").t, 0, 0)).toEqual(plain);
  });

  it("**LF で押し出したときに湧く行**も同じ規則（下線のまま `cat` を流したときに出る）", () => {
    const { t } = run("\x1b[6;1H\x1b[4;41m\n", 6, 20);
    expect(erased(t, 5, 0)).toEqual(plain);
    expect(at(t, 5, 0).style.bg).toEqual({ kind: "indexed", index: 1 });
  });

  it("RI（`ESC M`）で上端に湧く行も同じ規則", () => {
    const { t } = run("\x1b[1;1H\x1b[4m\x1bM", 6, 20);
    expect(erased(t, 0, 0)).toEqual(plain);
  });

  it("**折返しで湧く行**も同じ規則（書いた文字だけが下線を持つ）", () => {
    const { t } = run("\x1b[6;1H\x1b[4m" + "A".repeat(21), 6, 20);
    expect(at(t, 5, 0).style.underline).toBe(true);  // 折り返して書いた 21 文字目
    expect(at(t, 5, 10).style.underline).toBe(false); // 書いていない桁
  });

  it("代替画面へ入るときの消去も同じ規則（`vi` は下線を出したまま入ってくる）", () => {
    const { t } = run("\x1b[4;41m\x1b[?1049h");
    expect(erased(t, 0, 0)).toEqual(plain);
    expect(at(t, 0, 0).style.bg).toEqual({ kind: "indexed", index: 1 });
  });

  it("DECCOLM（`?3h`）の消去も同じ規則", () => {
    const { t } = run("\x1b[4m\x1b[?3h");
    expect(erased(t, 0, 0)).toEqual(plain);
  });

  it("大きさを変えて増えた桁も同じ規則", () => {
    const { t } = run("\x1b[4;41m");
    t.resize(8, 30);
    expect(erased(t, 0, 25)).toEqual(plain);
    expect(at(t, 0, 25).style.bg).toEqual({ kind: "indexed", index: 1 });
  });

  it("**書くほうは今までどおり現在の見た目**（BCE を書き込みに広げない）", () => {
    const { t } = run("\x1b[4;7;1;41mX");
    const s = at(t, 0, 0).style;
    expect(s.underline).toBe(true);
    expect(s.reverse).toBe(true);
    expect(s.bold).toBe(true);
  });
});

describe("挿入・削除", () => {
  it("ICH は右へ押し出す", () => {
    const { t } = run("abcdef\x1b[1;2H\x1b[2@");
    expect(lines(t)[0]).toBe("a  bcdef");
  });

  it("DCH は左へ詰める", () => {
    const { t } = run("abcdef\x1b[1;2H\x1b[2P");
    expect(lines(t)[0]).toBe("adef");
  });

  it("IL / DL は行を動かす", () => {
    const { t } = run("a\r\nb\r\nc\x1b[2;1H\x1b[1L");
    expect(lines(t).slice(0, 4)).toEqual(["a", "", "b", "c"]);
  });
});

describe("スクロール領域（DECSTBM）", () => {
  it("領域の中だけが動く", () => {
    const { t } = run("1\r\n2\r\n3\r\n4\x1b[2;3r\x1b[3;1H\n5", 6, 20);
    // 2〜3 行目が領域。3 行目で LF すると 2 行目が押し出される
    expect(lines(t).slice(0, 4)).toEqual(["1", "3", "5", "4"]);
  });

  it("**DECSTBM はカーソルを原点へ戻す**（戻さないと less の初回描画がずれる）", () => {
    const { t } = run("\x1b[5;10H\x1b[2;4r");
    expect(t.buffer.row).toBe(0);
    expect(t.buffer.col).toBe(0);
  });

  it("原点モード（DECOM）では CUP が領域の上端を 1 行目とする", () => {
    const { t } = run("\x1b[3;5r\x1b[?6h\x1b[1;1HX");
    expect(lines(t)[2]).toBe("X");
  });

  it("**領域を切っている間はスクロールバックに送らない**", () => {
    const { t } = run("\x1b[1;3r" + "\n".repeat(10));
    expect(t.snapshot().scrollback.length).toBe(0);
  });
});

describe("スクロールバック", () => {
  it("画面全体を使っているときの押し出しは履歴に入る", () => {
    const { t } = run("1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7", 6, 20);
    const s = t.snapshot();
    expect(s.scrollback.length).toBe(1);
    expect(s.scrollback[0]!.map((c) => c.char).join("").trim()).toBe("1");
  });

  it("上限を超えたら古い方から捨てる", () => {
    const t = new VtTerminal(3, 10, 2);
    const p = new VtParser();
    t.handle(p.feed(enc.encode("1\r\n2\r\n3\r\n4\r\n5\r\n6")));
    expect(t.snapshot().scrollback.length).toBe(2);
  });
});

describe("代替画面（vi / less が使う）", () => {
  it("`?1049h` で入り、`?1049l` で**元の画面が丸ごと戻る**", () => {
    const { t } = run("main\x1b[?1049halt\x1b[?1049l");
    expect(lines(t)[0]).toBe("main");
  });

  it("代替画面ではスクロールバックが増えない（spec D7）", () => {
    const { t } = run("\x1b[?1049h" + "x\r\n".repeat(20), 6, 20);
    expect(t.snapshot().scrollback.length).toBe(0);
  });

  it("`1049` はカーソルも退避して戻す", () => {
    const { t } = run("\x1b[4;7H\x1b[?1049h\x1b[1;1Hzz\x1b[?1049l");
    expect(t.buffer.row).toBe(3);
    expect(t.buffer.col).toBe(6);
  });

  it("`47` / `1047` も同じ実装に寄せる", () => {
    const { t } = run("main\x1b[?47halt\x1b[?47l");
    expect(lines(t)[0]).toBe("main");
  });
});

describe("SGR", () => {
  it("16 色は indexed のまま持つ（RGB へ潰さない）", () => {
    const { t } = run("\x1b[31mR");
    expect(at(t, 0, 0).style.fg).toEqual({ kind: "indexed", index: 1 });
  });

  it("明色（90-97）は 8-15 の indexed。**bold と混ぜない**", () => {
    const { t } = run("\x1b[94mB");
    expect(at(t, 0, 0).style.fg).toEqual({ kind: "indexed", index: 12 });
    expect(at(t, 0, 0).style.bold).toBe(false);
  });

  it("256 色（セミコロン形）", () => {
    const { t } = run("\x1b[38;5;208mO");
    expect(at(t, 0, 0).style.fg).toEqual({ kind: "indexed", index: 208 });
  });

  it("24 ビット色（セミコロン形とコロン形の両方）", () => {
    expect(at(run("\x1b[38;2;10;20;30mX").t, 0, 0).style.fg).toEqual({ kind: "rgb", r: 10, g: 20, b: 30 });
    expect(at(run("\x1b[38:2::10:20:30mX").t, 0, 0).style.fg).toEqual({ kind: "rgb", r: 10, g: 20, b: 30 });
  });

  it("**個別解除**（vi が 27m 23m 29m を並べて出す）", () => {
    const { t } = run("\x1b[1;3;4;7;9m\x1b[23m\x1b[27m\x1b[29mX");
    const s = at(t, 0, 0).style;
    expect(s.bold).toBe(true);
    expect(s.underline).toBe(true);
    expect(s.italic).toBe(false);
    expect(s.reverse).toBe(false);
    expect(s.strike).toBe(false);
  });

  it("`ESC[m` はパラメータ無しで全解除", () => {
    const { t } = run("\x1b[1;31m\x1b[mX");
    expect(at(t, 0, 0).style).toMatchObject({ bold: false, fg: { kind: "default" } });
  });
});

describe("全角", () => {
  it("**2 桁を占める**（左に文字・右は継続）", () => {
    const { t } = run("あA");
    expect(at(t, 0, 0)).toMatchObject({ char: "あ", width: 2 });
    expect(at(t, 0, 1)).toMatchObject({ char: "", width: 0 });
    expect(at(t, 0, 2)).toMatchObject({ char: "A", width: 1 });
  });

  it("**継続セルを名指しされたら左へ寄せ、全角ごと置き換える**（半分だけ残さない）", () => {
    // D6: カーソルは継続セルに留まれない。左へ寄るので全角がまるごと X になる
    const { t } = run("あ\x1b[1;2HX");
    expect(at(t, 0, 0).char).toBe("X");
    expect(at(t, 0, 1).char).toBe(" ");
    expect(at(t, 0, 1).width).toBe(1);
  });

  it("**左半分を上書きしたら継続セルも空白に戻す**", () => {
    const { t } = run("あい\x1b[1;3HX");
    expect(at(t, 0, 2).char).toBe("X");
    expect(at(t, 0, 3).char).toBe(" ");
    expect(at(t, 0, 3).width).toBe(1);
  });

  it("カーソルが継続セルに乗ったら左へ寄せる", () => {
    const { t } = run("あ\x1b[1;2H");
    expect(t.buffer.col).toBe(0);
  });

  it("**行末に 1 桁しか無い全角は次行へ送る**", () => {
    const { t } = run("A".repeat(19) + "あ", 6, 20);
    expect(lines(t)[0]).toBe("A".repeat(19));
    expect(at(t, 1, 0).char).toBe("あ");
  });

  it("折返しが無効なら書かずに捨てる（右端で潰し合わない）", () => {
    const { t } = run("\x1b[?7l" + "A".repeat(19) + "あ", 6, 20);
    expect(lines(t)[0]).toBe("A".repeat(19));
    expect(lines(t)[1]).toBe("");
  });

  it("結合文字は桁を消費せず直前に足す", () => {
    const { t } = run("éX");
    expect(at(t, 0, 0).char).toBe("é");
    expect(at(t, 0, 1).char).toBe("X");
  });
});

describe("文字集合（DEC 特殊図形）", () => {
  it("`ESC ( 0` で罫線になり、`ESC ( B` で戻る", () => {
    const { t } = run("\x1b(0qqq\x1b(Bqqq");
    expect(lines(t)[0]).toBe("───qqq");
  });

  it("SO / SI で G1 と G0 を切り替える", () => {
    const { t } = run("\x1b)0\x0eq\x0fq");
    expect(lines(t)[0]).toBe("─q");
  });
});

describe("タブ", () => {
  it("既定は 8 桁ごと", () => {
    const { t } = run("a\tb\tc");
    expect(lines(t)[0]).toBe("a       b       c");
  });

  it("HTS で位置を足し、TBC 3 で全部消す", () => {
    const { t } = run("\x1b[1;4H\x1bH\x1b[1;1Ha\tX", 6, 20);
    expect(lines(t)[0]).toBe("a  X");
  });

  it("CBT は前のタブ位置へ戻る", () => {
    const { t } = run("\x1b[1;18H\x1b[2ZX");
    expect(lines(t)[0]).toBe("        X");
  });
});

describe("ホストへの応答（返さないと待たされる）", () => {
  it("DA1", () => {
    expect(run("\x1b[c").replies).toEqual(["\x1b[?64;1;2;6;22c"]);
  });

  it("DA2 は xterm を名乗る", () => {
    expect(run("\x1b[>c").replies).toEqual(["\x1b[>41;0;0c"]);
  });

  it("DSR 5 は「異常なし」", () => {
    expect(run("\x1b[5n").replies).toEqual(["\x1b[0n"]);
  });

  it("CPR はカーソル位置を 1 起点で返す", () => {
    expect(run("\x1b[3;7H\x1b[6n").replies).toEqual(["\x1b[3;7R"]);
  });

  it("DECXCPR（`ESC[?6n`）は `?` つきで返す", () => {
    expect(run("\x1b[2;2H\x1b[?6n").replies).toEqual(["\x1b[?2;2R"]);
  });
});

describe("退避・復元・リセット", () => {
  it("DECSC / DECRC はカーソルと見た目をまとめて戻す", () => {
    const { t } = run("\x1b[2;3H\x1b[31m\x1b7\x1b[5;5H\x1b[mX\x1b8Y");
    expect(at(t, 1, 2).char).toBe("Y");
    expect(at(t, 1, 2).style.fg).toEqual({ kind: "indexed", index: 1 });
  });

  it("`ESC c`（RIS）は画面もスクロールバックも捨てる", () => {
    const { t } = run("1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\x1bc", 6, 20);
    expect(t.snapshot().scrollback.length).toBe(0);
    expect(lines(t).every((l) => l === "")).toBe(true);
  });

  it("`ESC[!p`（DECSTR）はモードを既定へ戻すが画面は残す", () => {
    const { t } = run("keep\x1b[?7l\x1b[!p");
    expect(t.modes.autoWrap).toBe(true);
    expect(lines(t)[0]).toBe("keep");
  });

  it("`ESC#8`（DECALN）は画面を E で埋める", () => {
    const { t } = run("\x1b#8", 3, 5);
    expect(lines(t)).toEqual(["EEEEE", "EEEEE", "EEEEE"]);
  });
});

describe("モードとタイトル", () => {
  it("`?1` `?25` `?2004` `?1006` を保持する", () => {
    const { t } = run("\x1b[?1h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h");
    expect(t.modes.applicationCursorKeys).toBe(true);
    expect(t.modes.cursorVisible).toBe(false);
    expect(t.modes.bracketedPaste).toBe(true);
    expect(t.modes.mouse).toBe("click");
    expect(t.modes.mouseEncoding).toBe("sgr");
  });

  it("`ESC=` / `ESC>` でキーパッドの様式が変わる", () => {
    expect(run("\x1b=").t.modes.applicationKeypad).toBe(true);
    expect(run("\x1b=\x1b>").t.modes.applicationKeypad).toBe(false);
  });

  it("`OSC 0` / `OSC 2` はタイトル。それ以外は読み飛ばす", () => {
    expect(run("\x1b]0;My Title\x07").t.title).toBe("My Title");
    expect(run("\x1b]2;X\x1b\\").t.title).toBe("X");
    expect(run("\x1b]52;c;AAAA\x07").t.title).toBe("");
  });

  it("挿入モード（IRM）", () => {
    const { t } = run("abc\x1b[1;1H\x1b[4hX");
    expect(lines(t)[0]).toBe("Xabc");
  });
});

describe("実機で採取した列（research 2.1）", () => {
  it("**vi に入って抜けるまでを通しで流しても壊れない**", () => {
    const t = new VtTerminal(24, 80, 100);
    const p = new VtParser();
    t.handle(p.feed(enc.encode("$ ls\r\nfile1 file2\r\n$ ")));
    const before = t.snapshot().cells.map((r) => r.map((c) => c.char).join(""));
    const viIn =
      "\x1b[?1049h\x1b[22;0;0t\x1b[>4;2m\x1b[?1h\x1b=\x1b[?2004h\x1b[1;24r" +
      "\x1b[?12h\x1b[?12l\x1b[22;2t\x1b[22;1t\x1b[27m\x1b[23m\x1b[29m\x1b[m" +
      "\x1b[H\x1b[2J\x1b[?25l\x1b[24;1H\"/etc/hostname\" 1 line\x1b[1;1Hhostname";
    t.handle(p.feed(enc.encode(viIn)));
    expect(t.snapshot().alternate).toBe(true);
    expect(t.snapshot().cells[0]!.map((c) => c.char).join("").trim()).toBe("hostname");

    const viOut = "\x1b[?2004l\x1b[>4;m\x1b[23;2t\x1b[23;1t\x1b[?1l\x1b>\x1b[?1049l\x1b[?25h";
    t.handle(p.feed(enc.encode(viOut)));
    expect(t.snapshot().alternate).toBe(false);
    expect(t.snapshot().cells.map((r) => r.map((c) => c.char).join(""))).toEqual(before);
    expect(t.modes.applicationCursorKeys).toBe(false);
    expect(t.modes.cursorVisible).toBe(true);
  });

  it("IBM i（pub400）のサインオン画面の断片が桁どおりに並ぶ", () => {
    const t = new VtTerminal(24, 80, 100);
    const p = new VtParser();
    t.handle(
      p.feed(
        enc.encode(
          "\x1b[?3l\x1b[?7h\x1b[1;1H\x1b[2J\x1b[0m        \x1b[1mWelcome to PUB400.COM" +
            "\x1b[0m\x1b[2;47H Server name . . . :   PUB400"
        )
      )
    );
    const l = t.snapshot().cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/u, ""));
    expect(l[0]).toBe("        Welcome to PUB400.COM");
    expect(l[1]!.slice(46)).toBe(" Server name . . . :   PUB400");
  });
});

describe("大きさを変える", () => {
  it("桁が減ったら右を切る（**行の再折返しはしない**）", () => {
    const t = new VtTerminal(4, 20, 10);
    const p = new VtParser();
    t.handle(p.feed(enc.encode("abcdefghij")));
    t.resize(4, 5);
    expect(t.snapshot().cols).toBe(5);
    expect(t.snapshot().cells[0]!.map((c) => c.char).join("")).toBe("abcde");
  });

  it("行が減ったら**上から履歴へ送る**（入力中の行を消さない）", () => {
    const t = new VtTerminal(4, 10, 10);
    const p = new VtParser();
    t.handle(p.feed(enc.encode("1\r\n2\r\n3\r\n4")));
    t.resize(2, 10);
    expect(t.snapshot().cells.map((r) => r.map((c) => c.char).join("").trim())).toEqual(["3", "4"]);
    expect(t.snapshot().scrollback.length).toBe(2);
  });

  it("切った縁に全角の左半分だけを残さない", () => {
    const t = new VtTerminal(2, 6, 10);
    const p = new VtParser();
    t.handle(p.feed(enc.encode("abcdあ")));
    t.resize(2, 5);
    expect(t.snapshot().cells[0]!.map((c) => c.char).join("")).toBe("abcd ");
  });
});

describe("代替画面のまま大きさを変える", () => {
  it("**抜けたときに行数の合った主画面が戻る**", () => {
    const t = new VtTerminal(6, 20, 10);
    const p = new VtParser();
    t.handle(p.feed(enc.encode("main1\r\nmain2")));
    t.handle(p.feed(enc.encode("\x1b[?1049halt")));
    t.resize(3, 10);
    t.handle(p.feed(enc.encode("\x1b[?1049l")));
    const s = t.snapshot();
    expect(s.rows).toBe(3);
    expect(s.cells.length).toBe(3);
    expect(s.cells.every((r) => r.length === 10)).toBe(true);
    // 上から詰められるので main2 は残る
    expect(s.cells.map((r) => r.map((c) => c.char).join("").trim())).toContain("main2");
  });

  it("カーソルも画面の中に収まる", () => {
    const t = new VtTerminal(10, 20, 10);
    const p = new VtParser();
    t.handle(p.feed(enc.encode("\x1b[9;18H\x1b[?1049h")));
    t.resize(4, 8);
    t.handle(p.feed(enc.encode("\x1b[?1049l")));
    expect(t.buffer.row).toBeLessThan(4);
    expect(t.buffer.col).toBeLessThan(8);
  });
});
