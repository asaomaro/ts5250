import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@as400web/core";
import {
  HOST_CODE_PAGES,
  DEFAULT_CCSID,
  hostCodePageOf,
  isKatakanaCcsid
} from "../src/hostCodePages.js";

describe("ホストコードページ一覧", () => {
  it("すべての選択肢が core の codecForCcsid で解決できる", () => {
    for (const p of HOST_CODE_PAGES) {
      expect(() => codecForCcsid(p.ccsid), `CCSID ${p.ccsid}`).not.toThrow();
    }
  });

  it("既定 CCSID（37）が一覧に含まれ、SBCS として解決される", () => {
    expect(HOST_CODE_PAGES.some((p) => p.ccsid === DEFAULT_CCSID)).toBe(true);
    expect(codecForCcsid(DEFAULT_CCSID).isDbcs).toBe(false);
  });

  it("CCSID の重複がない", () => {
    const ids = HOST_CODE_PAGES.map((p) => p.ccsid);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("hostCodePageOf は既知の CCSID を引き、未知なら undefined", () => {
    expect(hostCodePageOf(930)?.ccsid).toBe(930);
    expect(hostCodePageOf(99999)).toBeUndefined();
    expect(hostCodePageOf(undefined)).toBeUndefined();
  });
});

describe("カタカナ系コードページ判定", () => {
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
