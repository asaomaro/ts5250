// **交渉の前にテキストを送る偽の telnet サーバー**（台帳「telnet の交渉前のテキスト」。ACS `NVT.NVT_process_outbound` の測定用）。
// IBM i は交渉前にテキストを送らないので（tap の記録）、ACS のコアと当 PJ に同じ入力を当てるために手元で立てる。
// 接続されたら、`CHUNKS` の各断片を `STEP_MS` おきに 1 つずつ送る（IAC は一切送らない＝BINARY も EOR も交渉しない）。接続は開けたままにする。
// 断片は 1 回の write ＝ 1 回の受信になる（ACS は受信ごとに処理する。`Telnet.receive`）。
//
// `CHUNKS_JSON`（文字列の配列の JSON。各文字は 0x00〜0xFF のバイト）で断片を差し替えられる。
// 実行: PORT=23999 node scripts/fake-nvt-server.mjs   （手順は `scripts/acs-probe/nvt-text.txt`・`scripts/verify-nvt-text.mjs`）
import { createServer } from "node:net";

const STEP_MS = Number(process.env.STEP_MS ?? 2000);
const FIRST_MS = Number(process.env.FIRST_MS ?? 8000);
/** 断片（バイト列。`\x` はそのまま入る） */
export const CHUNKS = process.env.CHUNKS_JSON !== undefined ? JSON.parse(process.env.CHUNKS_JSON) : [
  "Hello, world\r\n", // c1: 文字と CR LF
  "Line2\n", // c2: LF だけ（桁は動かない・次の行を空白で埋める）
  "ab\bX\r", // c3: BS で戻って上書き・CR で行頭へ
  "\tT", // c4: HT（0x09）
  "\x05Z", // c5: ENQ（0x05）
  "\x01\x02\x07\x0e\x1b\x7fq", // c6: 表示できない制御文字と DEL（無視か）
  "\xc3\xa9\xe3\x81\x82r", // c7: 0x7f より上のバイト（UTF-8 の é・あ）
  "\r\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n", // c8: 何行も送って下端を越える（回り込み・空白で埋める）
  "x".repeat(100) + "\r\n" // c9: 1 行 80 桁を越える
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 23999);
  const srv = createServer((sock) => {
    sock.setNoDelay(true);
    sock.on("error", () => {});
    CHUNKS.forEach((c, i) => setTimeout(() => sock.write(Buffer.from(c, "latin1")), FIRST_MS + STEP_MS * i));
  });
  srv.listen(port, "127.0.0.1", () => process.stderr.write(`fake-nvt-server: 127.0.0.1:${port}\n`));
}
