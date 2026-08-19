import { createServer, type Server, type Socket } from "node:net";

/**
 * 検証用の最小 TN3270 **サーバ**。指定した 3270 データストリームを 1 回流す。
 *
 * **テスト専用**（`src/` ではないので層規約の対象外）。
 *
 * ## なぜ要るか
 *
 * `s3270` と自実装を突き合わせるには**同じバイトを両方に食わせる**必要がある。
 * 実ホスト（TK4-）へ 2 本繋いで比べる方法は**当てにならない**——Hercules は装置ごとに
 * 状態を持ち、2 本目の接続には別の画面（または空画面）が返る。実際に踏んだ。
 *
 * さらに **DBCS は実ホストから出てこない**（TK4- は英語 SBCS 専用）ので、
 * DBCS の回帰はここでしか作れない。
 *
 * ## 交渉
 *
 * research F2 で Hercules から実測した並びをそのまま再現する:
 * `DO TERMINAL-TYPE` → `SB SEND` → （型名を受け取る）→ `DO/WILL EOR` + `DO/WILL BINARY` → データ。
 */

const IAC = 0xff;
const DO = 0xfd;
const WILL = 0xfb;
const SB = 0xfa;
const SE = 0xf0;
const EOR = 0xef;
const OPT_TT = 0x18;
const OPT_EOR = 0x19;
const OPT_BIN = 0x00;

export interface Mini3270 {
  readonly port: number;
  /** 接続してきたクライアントが申告した端末タイプ（1 本目） */
  terminalType(): string | undefined;
  close(): Promise<void>;
}

export interface Mini3270Options {
  /** 交渉完了後に流すレコード（各要素が 1 レコード。IAC EOR は自動で付く） */
  records: Uint8Array[];
  port?: number;
  /** 交渉完了からデータ送出までの間（既定 300ms） */
  delayMs?: number;
}

export function startMini3270(opts: Mini3270Options): Promise<Mini3270> {
  const port = opts.port ?? 3290;
  const delayMs = opts.delayMs ?? 300;
  let announced: string | undefined;
  const sockets = new Set<Socket>();

  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {
      /* 切断は無視（テスト側が close する） */
    });

    let phase = 0;
    sock.write(Uint8Array.from([IAC, DO, OPT_TT]));

    sock.on("data", (chunk) => {
      const b = [...chunk];
      if (phase === 0 && b.includes(OPT_TT) && b.includes(WILL)) {
        sock.write(Uint8Array.from([IAC, SB, OPT_TT, 0x01, IAC, SE]));
        phase = 1;
        return;
      }
      if (phase === 1 && b[0] === IAC && b[1] === SB) {
        const end = b.indexOf(IAC, 2);
        announced = Buffer.from(b.slice(4, end < 0 ? undefined : end)).toString("ascii");
        sock.write(
          Uint8Array.from([
            IAC, DO, OPT_EOR, IAC, WILL, OPT_EOR,
            IAC, DO, OPT_BIN, IAC, WILL, OPT_BIN
          ])
        );
        phase = 2;
        setTimeout(() => {
          for (const rec of opts.records) {
            sock.write(escapeIac(rec));
            sock.write(Uint8Array.from([IAC, EOR]));
          }
        }, delayMs);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () =>
      resolve({
        port,
        terminalType: () => announced,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          })
      })
    );
  });
}

/** 本文中の IAC(FF) は二重化して送る（telnet の作法） */
function escapeIac(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const b of data) {
    out.push(b);
    if (b === IAC) out.push(IAC);
  }
  return Uint8Array.from(out);
}
