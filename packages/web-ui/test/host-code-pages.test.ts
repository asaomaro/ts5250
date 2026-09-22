import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import {
  HOST_CODE_PAGE_OPTIONS,
  SPOOL_CODE_PAGES,
  DEFAULT_CCSID,
  hostCodePageOptionId,
  hostCodePageOptionOf,
  isKatakanaCcsid
} from "../src/hostCodePages.js";

describe("ホストコードページ一覧（ACS の「ホスト・コード・ページ」と同じ 1 本の選択肢）", () => {
  it("すべての選択肢が core の codecForCcsid で解決できる", () => {
    for (const o of HOST_CODE_PAGE_OPTIONS) {
      expect(() => codecForCcsid(o.ccsid), `CCSID ${o.ccsid}`).not.toThrow();
    }
  });

  it("既定 CCSID（37）が一覧に含まれ、SBCS として解決される", () => {
    expect(HOST_CODE_PAGE_OPTIONS.some((o) => o.ccsid === DEFAULT_CCSID)).toBe(true);
    expect(codecForCcsid(DEFAULT_CCSID).isDbcs).toBe(false);
  });

  it("id の重複がない（930 は ccsid が同じ 2 エントリを持つので、一意性は id で見る）", () => {
    const ids = HOST_CODE_PAGE_OPTIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ACS の接続設定画面が実際に選ばせる CCSID だけを載せている（5026・5035 は載せない）", () => {
    // ACS のデコンパイル済みコア（com/ibm/eNetwork/HOD/common/CodePage#codePagesMap32705250、
    // 5250 表示・印刷セッションの「ホスト・コード・ページ」一覧の実体）は日本語で
    // 930・939・1399 の 3 つしか選ばせず、クラス全体にも "5026"・"5035" は一度も現れない。
    const ccsids = HOST_CODE_PAGE_OPTIONS.map((o) => o.ccsid);
    expect(ccsids).not.toContain(5026);
    expect(ccsids).not.toContain(5035);
    expect(Math.max(...ccsids)).toBe(1399);
  });

  it("930 は Katakana／Katakana Extended の 2 エントリで並ぶ（ACS の一覧と同じ形。独立した項目には分けない）", () => {
    const entries930 = HOST_CODE_PAGE_OPTIONS.filter((o) => o.ccsid === 930);
    expect(entries930.map((o) => o.katakanaVariant).sort()).toEqual(["katakana", "katakana-ex"]);
  });

  it("930 以外は katakanaVariant を持たない", () => {
    for (const o of HOST_CODE_PAGE_OPTIONS) {
      if (o.ccsid !== 930) expect(o.katakanaVariant, `CCSID ${o.ccsid}`).toBeUndefined();
    }
  });
});

describe("hostCodePageOptionId（保存値 → 選択中の id）", () => {
  it("930 + \"katakana\" は \"930-katakana\"", () => {
    expect(hostCodePageOptionId(930, "katakana")).toBe("930-katakana");
  });

  it("930 + \"katakana-ex\" は \"930-katakana-ex\"", () => {
    expect(hostCodePageOptionId(930, "katakana-ex")).toBe("930-katakana-ex");
  });

  it("**930 + 未指定は \"930-katakana-ex\" に寄せる**（ACS の一覧に中間状態は無い。20260922-katakana-selector-merge D2）", () => {
    expect(hostCodePageOptionId(930, undefined)).toBe("930-katakana-ex");
  });

  it("930 以外は katakanaVariant を無視する", () => {
    expect(hostCodePageOptionId(939, "katakana")).toBe("939");
    expect(hostCodePageOptionId(1399, "katakana-ex")).toBe("1399");
  });

  it("一覧に無い CCSID（5026・5035・未知の値）は undefined", () => {
    expect(hostCodePageOptionId(5026, "katakana")).toBeUndefined();
    expect(hostCodePageOptionId(5035, undefined)).toBeUndefined();
    expect(hostCodePageOptionId(99999, undefined)).toBeUndefined();
    expect(hostCodePageOptionId(undefined, undefined)).toBeUndefined();
  });

  it("一覧の全エントリで round-trip する（id → 値 → id が元に戻る）", () => {
    for (const o of HOST_CODE_PAGE_OPTIONS) {
      expect(hostCodePageOptionId(o.ccsid, o.katakanaVariant), o.id).toBe(o.id);
    }
  });
});

describe("hostCodePageOptionOf（id → 選択肢）", () => {
  it("既知の id を引く", () => {
    expect(hostCodePageOptionOf("930-katakana")).toEqual({
      id: "930-katakana",
      ccsid: 930,
      katakanaVariant: "katakana",
      label: "930 — 日本語（カタカナ）"
    });
  });

  it("未知の id・未設定は undefined", () => {
    expect(hostCodePageOptionOf("no-such-id")).toBeUndefined();
    expect(hostCodePageOptionOf(undefined)).toBeUndefined();
  });
});

describe("スプール CCSID 一覧", () => {
  it("5250 画面用の CCSID を含み、5026・5035 も選べる（ホストが実際に申告する値。実機: hostserver.md 20260718-hostserver-spool）", () => {
    const ids = SPOOL_CODE_PAGES.map((p) => p.ccsid);
    for (const ccsid of [37, 273, 930, 939, 1399]) expect(ids).toContain(ccsid);
    expect(ids).toContain(5026);
    expect(ids).toContain(5035);
  });

  it("930 の Katakana / Katakana Extended のような 2 択は無い（SCS の解読に CHARSET 申告は関わらない）", () => {
    const entries930 = SPOOL_CODE_PAGES.filter((p) => p.ccsid === 930);
    expect(entries930).toHaveLength(1);
  });

  it("すべての選択肢が core の codecForCcsid で解決できる", () => {
    for (const p of SPOOL_CODE_PAGES) {
      expect(() => codecForCcsid(p.ccsid), `CCSID ${p.ccsid}`).not.toThrow();
    }
  });

  it("CCSID の重複がない", () => {
    const ids = SPOOL_CODE_PAGES.map((p) => p.ccsid);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("カタカナ系コードページ判定（SBCS の字形。930 の Katakana/Katakana Extended の 2 択とは別軸）", () => {
  it("930・5026 はカタカナ系（英小文字なし）", () => {
    expect(isKatakanaCcsid(930)).toBe(true);
    expect(isKatakanaCcsid(5026)).toBe(true);
  });

  it("37・939・1399・5035 はカタカナ系ではない", () => {
    for (const ccsid of [37, 939, 1399, 5035]) {
      expect(isKatakanaCcsid(ccsid), `CCSID ${ccsid}`).toBe(false);
    }
  });

  it("未知・未設定は false", () => {
    expect(isKatakanaCcsid(undefined)).toBe(false);
    expect(isKatakanaCcsid(99999)).toBe(false);
  });

  it("カタカナ系は SBCS のバイト配置が英小文字系と異なる（同じ文字が別バイトになる）", () => {
    // 930（カナ配列）と 939（英小文字配列）で 'a' の EBCDIC バイトが異なる。
    // ＝ ホストのコードページに合わせて選ぶ必要がある、という選択機能の意義そのもの。
    const a930 = codecForCcsid(930).encode("a").bytes;
    const a939 = codecForCcsid(939).encode("a").bytes;
    expect(a930).toHaveLength(1);
    expect(a939).toHaveLength(1);
    expect(a930[0]).not.toBe(a939[0]);
  });
});
