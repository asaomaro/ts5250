import { describe, it, expect } from "vitest";
import {
  canDecodeCcsid,
  canEncodeCcsid,
  decodeCcsidText,
  encodeCcsidText,
  TEXT_CCSIDS
} from "../src/ccsid-text.js";
import { CP850_HIGH, CP437_HIGH, reverseOem } from "../src/oem-tables.js";

/**
 * **CCSID 850 / 437**（PC 系の単バイト。backlog `hostserver.md`）。
 *
 * `TextDecoder` はこの 2 つを持たない（WHATWG の一覧に無い）ので、同梱の表で読む。
 *
 * ## 表の出どころ
 *
 * **2 つの独立した実装から起こして全 256 バイトが一致することを確かめた**——
 * CPython の `codecs`（Unicode Consortium の対応表由来）と `iconv-lite`。
 * 片方だけだと写し間違いに気づけない。ここでは**両者が一致した値**を固定する。
 *
 * ⚠ 実機で 850 タグが付くのはたいてい「中身は UTF-8 / ASCII なのにサーバー既定の
 * タグが付いた」ケース（research F4）。決定表では**中身の推定が先に当たる**ので、
 * この経路は「本当に CP850 の内容だった」ときの受け皿にとどまる。
 */

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

describe("復号できる", () => {
  it("850 / 437 を読めると答える", () => {
    expect(canDecodeCcsid(850)).toBe(true);
    expect(canDecodeCcsid(437)).toBe(true);
  });

  it("**単バイトなので書ける**（逆引きで戻せる）", () => {
    expect(canEncodeCcsid(850)).toBe(true);
    expect(canEncodeCcsid(437)).toBe(true);
  });

  it("下位 128 は ASCII と同じ", () => {
    expect(decodeCcsidText(850, bytes(0x41, 0x42, 0x43)).text).toBe("ABC");
    expect(decodeCcsidText(437, bytes(0x7e, 0x20, 0x30)).text).toBe("~ 0");
  });

  it("**850 の上位**（西欧のアクセント付き）", () => {
    // 0x80=Ç 0x81=ü 0x82=é 0xa4=ñ
    expect(decodeCcsidText(850, bytes(0x80, 0x81, 0x82, 0xa4)).text).toBe("Çüéñ");
  });

  it("**437 の上位**（罫線・ギリシャ文字）", () => {
    // 0xc4=─ 0xb3=│ 0xe3=π
    expect(decodeCcsidText(437, bytes(0xc4, 0xb3, 0xe3)).text).toBe("─│π");
  });

  it("**850 と 437 は上位が違う**（同じバイトが別の文字になる）", () => {
    // 0xb5: 850 は Á、437 は ╡
    expect(decodeCcsidText(850, bytes(0xb5)).text).toBe("Á");
    expect(decodeCcsidText(437, bytes(0xb5)).text).toBe("╡");
  });

  it("NEL の正規化はしない（ASCII 系の 0x85 は改行ではない）", () => {
    expect(decodeCcsidText(850, bytes(0x85)).newline).toBe("lf");
    expect(decodeCcsidText(850, bytes(0x85)).text).toBe("à");
  });
});

describe("符号化して往復する", () => {
  it.each([850, 437])("CCSID %i で往復しても変わらない", (ccsid) => {
    const src = ccsid === 850 ? "Çüéñ ABC ~" : "─│π ABC ~";
    const { bytes: b, substituted } = encodeCcsidText(ccsid, src);
    expect(substituted).toBe(0);
    expect(decodeCcsidText(ccsid, b).text).toBe(src);
  });

  it("**表に無い文字は SUB に落として数える**（黙って消さない）", () => {
    const { bytes: b, substituted } = encodeCcsidText(850, "日本語");
    expect(substituted).toBe(3);
    expect([...b]).toEqual([0x1a, 0x1a, 0x1a]);
  });
});

describe("表そのもの", () => {
  it.each([
    ["CP850", CP850_HIGH],
    ["CP437", CP437_HIGH]
  ])("%s は上位 128 ぶん持つ", (_n, table) => {
    expect(table).toHaveLength(128);
  });

  it("**逆引きは最初に現れたバイトを採る**（同じ文字が 2 か所に出る表がある）", () => {
    const rev = reverseOem(CP850_HIGH);
    // 下位はそのまま
    expect(rev.get(0x41)).toBe(0x41);
    // Ç は 0x80
    expect(rev.get(0x00c7)).toBe(0x80);
  });

  it("逆引き表は作り直さない（同じ実体が返る）", () => {
    expect(reverseOem(CP437_HIGH)).toBe(reverseOem(CP437_HIGH));
  });
});

describe("手動選択の候補", () => {
  it("**850 / 437 が候補に出る**（読めるようになったので選ばせる）", () => {
    const ccsids = TEXT_CCSIDS.map((c) => c.ccsid);
    expect(ccsids).toContain(850);
    expect(ccsids).toContain(437);
  });

  it("どちらも保存に使える", () => {
    for (const c of TEXT_CCSIDS.filter((x) => x.ccsid === 850 || x.ccsid === 437)) {
      expect(c.writable, `${c.ccsid}`).toBe(true);
    }
  });
});
