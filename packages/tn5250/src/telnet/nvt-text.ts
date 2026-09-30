/**
 * **交渉の前に届いたテキスト（NVT）を画面へ書く**（ACS `NVT.NVT_process_outbound` と `NVT5250.NVT_initialize_outbound` / `NVT_terminate_outbound`。
 * `20260930-telnet-nvt-text`）。
 *
 * IBM i は BINARY・EOR を交渉する前にテキストを送らない（tap の記録）。ゲートウェイ・プロキシが返すバナーやエラーの文言、5250 でないサービスへ
 * 繋いだときの応答は、これが無いと画面に出ず「時間切れ」としか分からない。ACS は交渉が済むまでに届いた通常データ（IAC でないバイト）を、
 * **合成した Write To Display にして 5250 の画面へ流す**——当 PJ も同じく WTD を組んで既存の適用の道へ渡す。
 *
 * 規則（実機ではなく偽のサーバー〔`scripts/fake-nvt-server.mjs`〕を ACS のコアに当てて確かめた。`scripts/acs-probe/nvt-text.txt`）:
 * - 表示できる ASCII（0x20〜0x7E）は EBCDIC の固定の表で 1 字書き、桁が 1 進む。**画面の右端で折り返す**（次の行の頭へ）
 * - CR は行頭へ。LF・VT・FF は**桁を変えずに 1 行下**へ移り、**下の行を全桁空白にして**からその桁へ戻る（スクロールしない。最下行の次は 1 行目へ回り込む）
 * - BS は 1 桁戻る。0x05（ENQ）は次の 8 桁の境目まで空白を書く。**HT（0x09）は無視**——0x05 とは別扱い（ACS のコードがそう分けている）
 * - NUL・上記以外の制御文字・0x7F 以上のバイトは無視
 * - 1 回の受信ごとに WTD を 1 つ作り、書き終えたらカーソルを置く。桁の位置は次の受信へ持ち越す（5250 のレコードが届いたら 0 へ戻す）
 * 画面の終わりを越えて書くと ACS は入力禁止のまま以降を捨てる（データストリームの位置の検査）。当 PJ も同じ道を通るので同じ扱いになる
 */
import { ESC, COMMAND, ORDER } from "../protocol/constants.js";

/**
 * 0x20〜0x7E の EBCDIC（ACS `NVT.AtoEData` の 95 バイト）。米国の EBCDIC（037）と `! [ ] ^ |` の 5 字だけ違う（`!`＝4F・`[`＝4A・`]`＝5A・`^`＝5F・`|`＝BB）
 */
const A_TO_E = Uint8Array.from(
  "404f7f7b5b6c507d4d5d5c4e6b604b61f0f1f2f3f4f5f6f7f8f97a5e4c7e6e6f7cc1c2c3c4c5c6c7c8c9d1d2d3d4d5d6d7d8d9e2e3e4e5e6e7e8e94ae05a5f6d79818283848586878889919293949596979899a2a3a4a5a6a7a8a9c0bbd0a1"
    .match(/../g)!
    .map((h) => parseInt(h, 16))
);

/** 桁の位置（0 起点の画面の通し番号）。受信をまたいで持つ */
export interface NvtCursor {
  pos: number;
}

/**
 * 受信 1 回ぶんのテキストを WTD のデータストリーム（`ESC 0x11 …`）にする。`cursor.pos` は書いた後の位置へ進める。
 * 位置は Java の整数と同じ扱い（負の剰余を保つ）——BS が先頭で 1 つ戻ると 1 行目の 0 桁（SBA 1,0）になり、ACS と同じバイトを出す
 */
export function nvtTextToWtd(input: Uint8Array, cursor: NvtCursor, cols: number, rows: number): Uint8Array {
  const size = cols * rows;
  const out: number[] = [];
  const addr = (): [number, number] => {
    cursor.pos %= size;
    return [(Math.trunc(cursor.pos / cols) + 1) & 0xff, ((cursor.pos % cols) + 1) & 0xff];
  };
  const sba = (): void => {
    out.push(ORDER.SBA, ...addr());
  };
  // WTD の頭: CC1=0・CC2=0x08（キーボードの解錠）。書き始めの位置へ SBA。位置が先頭のときは空白を 1 字書いて置き直す（ACS はそうする）
  out.push(ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x08);
  sba();
  if (cursor.pos === 0) {
    out.push(0x40);
    sba();
  }
  for (const b of input) {
    if (b > 31 && b < 127) {
      out.push(A_TO_E[b - 32]!);
      cursor.pos++;
    } else if (b === 8) {
      cursor.pos--;
      sba();
    } else if (b === 5) {
      // 空白を 1 つ書き、次の 8 桁の境目（通しの位置が 8 の倍数）まで続ける
      do {
        out.push(0x40);
        cursor.pos++;
      } while (cursor.pos % 8 !== 0);
    } else if (b === 10 || b === 11 || b === 12) {
      cursor.pos = (cursor.pos + cols) % size;
      const kept = cursor.pos;
      cursor.pos -= cursor.pos % cols; // 下の行の頭
      sba();
      for (let i = 0; i < cols; i++) out.push(0x40); // その行を空白で埋める
      cursor.pos = kept;
      sba(); // 桁は元のまま
    } else if (b === 13) {
      cursor.pos -= cursor.pos % cols;
      sba();
    }
    // NUL・ほかの制御文字・0x7F 以上は無視
  }
  out.push(ORDER.IC, ...addr());
  cursor.pos %= size;
  return Uint8Array.from(out);
}
