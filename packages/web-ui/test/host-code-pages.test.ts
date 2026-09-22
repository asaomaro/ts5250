import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import {
  HOST_CODE_PAGES,
  SPOOL_CODE_PAGES,
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

  it("ACS の接続設定画面が実際に選ばせる CCSID だけを載せている（5026・5035 は載せない）", () => {
    // ACS のデコンパイル済みコア（com/ibm/eNetwork/HOD/common/CodePage#codePagesMap32705250、
    // 5250 表示・印刷セッションの「ホスト・コード・ページ」一覧の実体）は日本語で
    // 930・939・1399 の 3 つしか選ばせず、クラス全体にも "5026"・"5035" は一度も現れない。
    const ids = HOST_CODE_PAGES.map((p) => p.ccsid);
    expect(ids).not.toContain(5026);
    expect(ids).not.toContain(5035);
    expect(Math.max(...ids)).toBe(1399);
  });
});

describe("スプール CCSID 一覧", () => {
  it("5250 画面用の一覧を包含し、5026・5035 も選べる（ホストが実際に申告する値。実機: hostserver.md 20260718-hostserver-spool）", () => {
    for (const p of HOST_CODE_PAGES) {
      expect(SPOOL_CODE_PAGES.some((q) => q.ccsid === p.ccsid)).toBe(true);
    }
    expect(SPOOL_CODE_PAGES.some((p) => p.ccsid === 5026)).toBe(true);
    expect(SPOOL_CODE_PAGES.some((p) => p.ccsid === 5035)).toBe(true);
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
