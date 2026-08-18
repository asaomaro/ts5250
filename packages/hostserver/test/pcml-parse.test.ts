import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parsePcml } from "../src/command/pcml-parse.js";

/**
 * **PCML の解析。**
 *
 * `pcmltst.pcml` は**実機が吐いたそのもの**——実機で
 * `CRTBNDRPG ... PGMINFO(*PCML) INFOSTMF('/…')` を通して得た（`research.md` A）。
 * 手で整えていない。整えると「実機が吐かない形」を通してしまう。
 */
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const REAL = fixture("pcmltst.pcml");
const VAR = fixture("varcount.pcml");

describe("実機が吐いた PCML", () => {
  it("プログラムと項目を読める", () => {
    const doc = parsePcml(REAL);
    expect(doc.version).toBe("6.0");
    const pgm = doc.programs.get("PCMLTST");
    expect(pgm?.path).toBe("/QSYS.LIB/TESTLIB.LIB/PCMLTST.PGM");
    expect(pgm?.fields.map((f) => f.name)).toEqual([
      "INTXT",
      "IONUM",
      "REC",
      "ITEMS",
      "CNT",
      "BIG",
      "AMT"
    ]);
  });

  it("**`const` は input になる**（実機で確かめた対応）", () => {
    const pgm = parsePcml(REAL).programs.get("PCMLTST")!;
    expect(pgm.fields[0]!.usage).toBe("input");
    expect(pgm.fields[1]!.usage).toBe("inputoutput");
  });

  it("**`struct=` は展開される**（参照したまま下流に渡さない）", () => {
    const rec = parsePcml(REAL).programs.get("PCMLTST")!.fields[2]!;
    expect(rec.type).toBe("struct");
    expect(rec.fields?.map((f) => f.name)).toEqual(["ID", "NM", "RATE"]);
    expect(rec.fields?.[1]?.length).toBe(20);
  });

  it("**`usage=inherit` は参照した側から継ぐ**（定義側の親ではない）", () => {
    const rec = parsePcml(REAL).programs.get("PCMLTST")!.fields[2]!;
    // REC は inputoutput。メンバーは inherit なので同じになる
    expect(rec.fields?.map((f) => f.usage)).toEqual([
      "inputoutput",
      "inputoutput",
      "inputoutput"
    ]);
  });

  it("完全名が付く（名前で引くための鍵）", () => {
    const rec = parsePcml(REAL).programs.get("PCMLTST")!.fields[2]!;
    expect(rec.path).toBe("PCMLTST.REC");
    expect(rec.fields?.[1]?.path).toBe("PCMLTST.REC.NM");
  });

  it("整数の件数を読める", () => {
    const items = parsePcml(REAL).programs.get("PCMLTST")!.fields[3]!;
    expect(items.count).toBe(4);
  });
});

describe("手書きの PCML", () => {
  it("XML 宣言と DOCTYPE を飛ばせる", () => {
    expect(parsePcml(VAR).version).toBe("4.0");
  });

  it("**`count` の相対名は完全名に解ける**", () => {
    const entries = parsePcml(VAR).programs.get("LISTER")!.fields[1]!;
    expect(entries.count).toBe("LISTER.COUNT");
  });

  it("`init` / `threadsafe` / `float` / `byte` を読める", () => {
    const pgm = parsePcml(VAR).programs.get("LISTER")!;
    expect(pgm.threadsafe).toBe(true);
    expect(pgm.fields[0]!.init).toBe("2");
    expect(pgm.fields[2]!.type).toBe("float");
    expect(pgm.fields[3]!.type).toBe("byte");
  });

  it("**出力の構造体は usage を継ぐ**", () => {
    const entries = parsePcml(VAR).programs.get("LISTER")!.fields[1]!;
    expect(entries.fields?.map((f) => f.usage)).toEqual(["output", "output"]);
  });
});

describe("壊れた記述は行番号つきで断る", () => {
  const err = (text: string): string => {
    try {
      parsePcml(text);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("通ってしまった");
  };

  it("閉じていないタグ", () => {
    expect(err('<pcml version="1.0">\n<program name="A">\n')).toMatch(/2 行目.*<program> が閉じて/u);
  });

  it("対応しない終了タグ", () => {
    expect(err('<pcml version="1.0">\n<program name="A">\n</struct>\n</pcml>')).toMatch(/3 行目/u);
  });

  it("引用符の無い属性", () => {
    expect(err("<pcml version=1.0>\n</pcml>")).toMatch(/1 行目.*引用符/u);
  });

  it("知らない型", () => {
    const text = '<pcml version="1.0"><program name="A">\n<data name="X" type="blob" length="1" />\n</program></pcml>';
    expect(err(text)).toMatch(/2 行目.*type="blob" は使えません/u);
  });

  it("**まだ扱えない型は名指しで断る**（黙って落とさない）", () => {
    const text = '<pcml version="1.0"><program name="A">\n<data name="X" type="timestamp" />\n</program></pcml>';
    expect(err(text)).toMatch(/2 行目.*type="timestamp" はまだ扱えません/u);
  });

  it("当たらない struct=", () => {
    const text = '<pcml version="1.0"><program name="A">\n<data name="X" type="struct" struct="NOPE" />\n</program></pcml>';
    expect(err(text)).toMatch(/struct="NOPE" に当たる/u);
  });

  it("**自分自身を含む構造体**（無限に展開させない）", () => {
    const text = [
      '<pcml version="1.0">',
      '<struct name="A"><data name="INNER" type="struct" struct="A" /></struct>',
      '<program name="P"><data name="X" type="struct" struct="A" /></program>',
      "</pcml>"
    ].join("\n");
    expect(err(text)).toMatch(/自分自身を含んでいます/u);
  });

  it("当たらない count=", () => {
    const text = '<pcml version="1.0"><program name="A">\n<data name="X" type="char" length="1" count="NOPE" />\n</program></pcml>';
    expect(err(text)).toMatch(/count="NOPE" に当たる項目がありません/u);
  });

  it("件数にならない型を指した count=", () => {
    const text = [
      '<pcml version="1.0"><program name="A">',
      '<data name="N" type="char" length="4" />',
      '<data name="X" type="char" length="1" count="N" />',
      "</program></pcml>"
    ].join("\n");
    expect(err(text)).toMatch(/char で、件数になりません/u);
  });

  it("<program> が無い", () => {
    expect(err('<pcml version="1.0"><struct name="A"><data name="X" type="char" length="1" /></struct></pcml>')).toMatch(
      /<program> がありません/u
    );
  });
});

describe("飛び先（`offset` / `offsetfrom`）", () => {
  const doc = parsePcml(
    [
      '<pcml version="4.0"><program name="P">',
      '<data name="off" type="int" length="4" usage="output" />',
      '<data type="byte" length="0" offset="off" offsetfrom="0" usage="output" />',
      '<data name="tail" type="char" length="4" usage="output" />',
      "</program></pcml>"
    ].join("\n")
  );

  it("**相対名は完全名に解ける**", () => {
    expect(doc.programs.get("P")!.fields[1]!.offset).toBe("P.off");
  });

  it("整数の基点はそのまま（`0` は引数の先頭）", () => {
    expect(doc.programs.get("P")!.fields[1]!.offsetfrom).toBe(0);
  });

  it("整数の飛び先も読める", () => {
    const d = parsePcml('<pcml version="4.0"><program name="P"><data name="X" type="char" length="1" offset="16" /></program></pcml>');
    expect(d.programs.get("P")!.fields[0]!.offset).toBe(16);
  });

  it("**`offsetfrom` は数を指さない**（先祖の開始位置を指すので構造体でよい）", () => {
    const d = parsePcml(
      [
        '<pcml version="4.0"><program name="P">',
        '<struct name="H"><data name="a" type="char" length="2" /></struct>',
        '<data name="X" type="char" length="1" offset="1" offsetfrom="H" />',
        "</program></pcml>"
      ].join("\n")
    );
    expect(d.programs.get("P")!.fields[1]!.offsetfrom).toBe("P.H");
  });
});
