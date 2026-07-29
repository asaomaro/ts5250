import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";
import type { ParsedWindow } from "../src/protocol/wdsf-parser.js";

const codec = codecForCcsid(37);

/**
 * **窓かどうかは描画結果ではなく受信データに出ている。**
 *
 * 罫線からの推測は「左右に `:` が並ぶ帳票」「反転バナー」を窓と誤検出する。判定が見た目しか
 * 見られないのは材料が渡っていないためで、ここで採る `WriteExtent` がその材料になる。
 *
 * 判定の第一級条件が **CLEAR の有無**なのは実測が根拠——リポジトリ同梱の実機採取レコード
 * （`test/fixtures/pub400-*.jsonl`）を再生したところ、**通常の全画面遷移 6/6 すべてに
 * CLEAR が付いていた**（面積比は 96〜100% で揺れるので面積は主条件に使えない）。
 * 一方、窓は SAVE SCREEN の上に CLEAR なしで部分的に描く（実機 GRIDCL5/GRIDCL7。
 * `window-backdrop.test.ts` の冒頭に受信バイトの内訳がある）。
 */
describe("WriteExtent（レコードの書き込み範囲）", () => {
  const ebcdic = (s: string): number[] => Array.from(codec.encode(s).bytes);

  /** 行 row 桁 col から文字列を書く WTD（CLEAR を伴わない＝窓の描き方） */
  function wtdAt(row: number, col: number, text: string): Uint8Array {
    return Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, row, col,
      ...ebcdic(text)
    ]);
  }

  /** CLEAR UNIT のあとに全画面を書く（＝通常画面の描き方） */
  function clearThenFullScreen(): Uint8Array {
    const bytes: number[] = [ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00];
    for (let row = 1; row <= 24; row++) {
      bytes.push(ORDER.SBA, row, 1, ...ebcdic("X".repeat(80)));
    }
    return Uint8Array.from(bytes);
  }

  describe("① 本物の窓: CLEAR なしの部分書き込み", () => {
    it("窓の範囲だけが矩形になり cleared は立たない", () => {
      const buf = new ScreenBuffer();
      // まず背景（通常画面）を描いてから、その上に窓を開く
      applyDataStream(clearThenFullScreen(), buf, codec);
      const res = applyDataStream(wtdAt(10, 30, "HELP WINDOW"), buf, codec);

      expect(res.lastWrite.cleared).toBe(false);
      expect(res.lastWrite.restored).toBe(false);
      expect(res.lastWrite.rect).toEqual({ row1: 10, row2: 10, col1: 30, col2: 40 });
    });

    it("複数行の窓は行・桁ともに外接矩形になる", () => {
      const buf = new ScreenBuffer();
      applyDataStream(clearThenFullScreen(), buf, codec);
      const stream = Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        ORDER.SBA, 8, 20, ...ebcdic("..........".repeat(2)),
        ORDER.SBA, 9, 20, ...ebcdic(":        :"),
        ORDER.SBA, 12, 20, ...ebcdic("..........".repeat(2))
      ]);
      const res = applyDataStream(stream, buf, codec);

      expect(res.lastWrite.cleared).toBe(false);
      expect(res.lastWrite.rect).toEqual({ row1: 8, row2: 12, col1: 20, col2: 39 });
    });
  });

  describe("②③④ 通常画面: CLEAR を伴う全画面書き込み", () => {
    it("CLEAR UNIT を通ると cleared が立つ", () => {
      const buf = new ScreenBuffer();
      const res = applyDataStream(clearThenFullScreen(), buf, codec);

      expect(res.lastWrite.cleared).toBe(true);
      expect(res.lastWrite.rect).toEqual({ row1: 1, row2: 24, col1: 1, col2: 80 });
    });

    it("CLEAR UNIT ALTERNATE でも cleared が立つ", () => {
      const buf = new ScreenBuffer({ alternate: "27x132" });
      const stream = Uint8Array.from([
        ESC, COMMAND.CLEAR_UNIT_ALTERNATE, 0x00,
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        ORDER.SBA, 1, 1, ...ebcdic("WIDE")
      ]);
      const res = applyDataStream(stream, buf, codec);

      expect(res.lastWrite.cleared).toBe(true);
      // **クリア前の座標は残さない**（桁数が 80→132 へ変わるため意味を失う）
      expect(res.lastWrite.rect).toEqual({ row1: 1, row2: 1, col1: 1, col2: 4 });
    });

    it("CLEAR のあと画面の一部しか書かなくても cleared は立つ", () => {
      // 実測の 96% 事例（メッセージ行を書かない全画面遷移）に相当。
      // 面積では通常画面と窓を分けられないことの担保でもある
      const buf = new ScreenBuffer();
      const stream = Uint8Array.from([
        ESC, COMMAND.CLEAR_UNIT,
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        ORDER.SBA, 5, 10, ...ebcdic("PARTIAL")
      ]);
      const res = applyDataStream(stream, buf, codec);

      expect(res.lastWrite.cleared).toBe(true);
      expect(res.lastWrite.rect).toEqual({ row1: 5, row2: 5, col1: 10, col2: 16 });
    });
  });

  describe("書き込みが無いレコード", () => {
    it("直前の確定値を残す（窓を描くレコードと入力待ちレコードが分かれても消えない）", () => {
      const buf = new ScreenBuffer();
      applyDataStream(clearThenFullScreen(), buf, codec);
      const win = applyDataStream(wtdAt(10, 30, "HELP WINDOW"), buf, codec);
      expect(win.lastWrite.rect).toEqual({ row1: 10, row2: 10, col1: 30, col2: 40 });

      // 入力を待つだけのレコード（READ MDT FIELDS のみ。1 セルも書かない）
      const read = applyDataStream(
        Uint8Array.from([ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00]),
        buf,
        codec
      );

      expect(read.lastWrite.rect).toEqual({ row1: 10, row2: 10, col1: 30, col2: 40 });
      expect(read.lastWrite.cleared).toBe(false);
      expect(buf.snapshot("s", false).lastWrite?.rect).toEqual({
        row1: 10, row2: 10, col1: 30, col2: 40
      });
    });
  });

  describe("lastWrite の読み取りは純粋（記録を壊さない）", () => {
    it("レコードの途中で読んでも、その後の書き込みが同じ矩形へ積み上がる", () => {
      // 読み取りで確定してしまうと、途中読み以降の分だけが最終の矩形になり前半が消える
      const buf = new ScreenBuffer();
      buf.beginRecord();
      buf.setChar(buf.addrOf(5, 10), "A");
      expect(buf.lastWrite.rect).toEqual({ row1: 5, row2: 5, col1: 10, col2: 10 });

      buf.setChar(buf.addrOf(9, 40), "B");
      expect(buf.lastWrite.rect).toEqual({ row1: 5, row2: 9, col1: 10, col2: 40 });
    });
  });

  describe("eraseRange の畳み込み", () => {
    it("同じ行に収まる範囲はその桁だけ", () => {
      const buf = new ScreenBuffer();
      buf.beginRecord();
      buf.eraseRange(buf.addrOf(3, 10), buf.addrOf(3, 20));
      expect(buf.lastWrite.rect).toEqual({ row1: 3, row2: 3, col1: 10, col2: 20 });
    });

    it("行をまたぐ範囲は全幅に触れたものとして扱う", () => {
      const buf = new ScreenBuffer();
      buf.beginRecord();
      buf.eraseRange(buf.addrOf(3, 70), buf.addrOf(5, 10));
      expect(buf.lastWrite.rect).toEqual({ row1: 3, row2: 5, col1: 1, col2: 80 });
    });
  });

  describe("RESTORE SCREEN", () => {
    it("restored が立ち全画面が矩形になる（窓を閉じた＝窓ではない）", () => {
      const buf = new ScreenBuffer();
      applyDataStream(clearThenFullScreen(), buf, codec);
      applyDataStream(Uint8Array.from([ESC, COMMAND.SAVE_SCREEN]), buf, codec);
      applyDataStream(wtdAt(10, 30, "HELP WINDOW"), buf, codec);

      const res = applyDataStream(Uint8Array.from([ESC, COMMAND.RESTORE_SCREEN]), buf, codec);

      expect(res.lastWrite.restored).toBe(true);
      expect(res.lastWrite.rect).toEqual({ row1: 1, row2: 24, col1: 1, col2: 80 });
    });

    it("退避が空なら画面が変わらないので restored は立たない", () => {
      const buf = new ScreenBuffer();
      applyDataStream(clearThenFullScreen(), buf, codec);
      const res = applyDataStream(Uint8Array.from([ESC, COMMAND.RESTORE_SCREEN]), buf, codec);

      expect(res.lastWrite.restored).toBe(false);
    });
  });

  describe("CC1 のフィールド null 化は数えない", () => {
    it("欄が画面中に散っていても矩形が膨らまない", () => {
      const buf = new ScreenBuffer();
      // 画面の端と端に入力欄を置く
      applyDataStream(
        Uint8Array.from([
          ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
          ORDER.SBA, 2, 2, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 5,
          ORDER.SBA, 22, 70, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 5
        ]),
        buf,
        codec
      );
      // CC1 = 0x40（非 bypass 欄を null 化）を伴う、窓相当の部分書き込み
      const res = applyDataStream(
        Uint8Array.from([
          ESC, COMMAND.WRITE_TO_DISPLAY, 0x40, 0x00,
          ORDER.SBA, 10, 30, ...ebcdic("HELP")
        ]),
        buf,
        codec
      );

      // 欄の null 化を数えていたら矩形は r2-22 / c2-74 へ膨らむ
      expect(res.lastWrite.rect).toEqual({ row1: 10, row2: 10, col1: 30, col2: 33 });
    });
  });

  describe("CREATE WINDOW の下地消し", () => {
    it("消した矩形が書き込み範囲に入る", () => {
      const parsed: ParsedWindow = { width: 30, height: 8, restrictCursor: true, pulldown: false };
      const buf = new ScreenBuffer();
      buf.beginRecord();
      buf.addWindow(parsed, 8, 24);
      // 枠の矩形（行 8〜17 / 桁 24〜58）
      expect(buf.lastWrite.rect).toEqual({ row1: 8, row2: 17, col1: 24, col2: 58 });
    });
  });

  describe("snapshot への露出", () => {
    it("snapshot が lastWrite を持ち、buffer の内部と別実体である", () => {
      const buf = new ScreenBuffer();
      applyDataStream(clearThenFullScreen(), buf, codec);
      applyDataStream(wtdAt(10, 30, "HELP"), buf, codec);

      const snap = buf.snapshot("s", false);
      expect(snap.lastWrite?.rect).toEqual({ row1: 10, row2: 10, col1: 30, col2: 33 });

      // 後続レコードが過去の snapshot を書き換えないこと
      applyDataStream(clearThenFullScreen(), buf, codec);
      expect(snap.lastWrite?.rect).toEqual({ row1: 10, row2: 10, col1: 30, col2: 33 });
      expect(snap.lastWrite?.cleared).toBe(false);
    });
  });
});
