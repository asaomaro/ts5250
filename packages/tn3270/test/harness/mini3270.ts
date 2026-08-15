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
const OPT_TN3270E = 0x28;
const WONT = 0xfc;
/** RFC 2355 §3 */
const E_CONNECT = 0x01;
const E_DEVICE_TYPE = 0x02;
const E_FUNCTIONS = 0x03;
const E_IS = 0x04;
const E_REASON = 0x05;
const E_REJECT = 0x06;
const E_REQUEST = 0x07;
const E_SEND = 0x08;
const ascii = (t: string): number[] => [...t].map((c) => c.charCodeAt(0));
const fromAscii = (b: readonly number[]): string => String.fromCharCode(...b);

export interface Mini3270 {
  readonly port: number;
  /** 接続してきたクライアントが申告した端末タイプ（1 本目） */
  terminalType(): string | undefined;
  /** TN3270E で受け取った device-type / device-name（照合に使う） */
  deviceType(): string | undefined;
  requestedName(): string | undefined;
  /** クライアントから受け取ったサブネゴシエーション本文の記録（交渉列の突き合わせ用） */
  negotiation(): string[];
  /**
   * **クライアントが送ってきたアプリのレコード**（IAC EOR で切り出し・二重化を解除済み）を hex で。
   * AID 応答や Read Buffer の応答を突き合わせるのに使う。
   */
  inbound(): string[];
  /** 交渉後に追加のレコードを送る（`Read Buffer` コマンド等を後から撃つ） */
  send(record: Uint8Array): void;
  close(): Promise<void>;
}

export interface Mini3270Options {
  /** 交渉完了後に流すレコード（各要素が 1 レコード。IAC EOR は自動で付く） */
  records: Uint8Array[];
  port?: number;
  /** 交渉完了からデータ送出までの間（既定 300ms） */
  delayMs?: number;
  /**
   * **TN3270E サーバとして振る舞う**（RFC 2355）。既定 false（基本 TN3270）。
   *
   * 有効にすると `DO TN3270E` から始め、DEVICE-TYPE / FUNCTIONS を交渉し、
   * データに 5 バイトヘッダを付ける。
   *
   * **RFC §7.2.1 に厳密に従う**——機能を減らすときは `IS` ではなく `REQUEST`（対案）を返す。
   * プロトタイプで `IS` に部分集合を載せる違反をやり、s3270 が寛容に受理したため
   * 気づけなかった。**ハーネスが違反していると誤検証になる。**
   */
  tn3270e?: boolean;
  /** TN3270E で `DEVICE-TYPE IS … CONNECT <名前>` として返す名前（既定 "TSTTERM"） */
  assignName?: string;
  /** TN3270E の要求を拒否する（理由コード）。設定すると REJECT を返す */
  rejectReason?: number;
}

export function startMini3270(opts: Mini3270Options): Promise<Mini3270> {
  const port = opts.port ?? 3290;
  const sockets = new Set<Socket>();

  let announcedType: string | undefined;
  const inboundRecs: string[] = [];
  let live: Socket | undefined;
  let eDeviceType: string | undefined;
  let eRequestedName: string | undefined;
  const negLog: string[] = [];
  const useE = opts.tn3270e === true;

  const server: Server = createServer((sock) => {
    sockets.add(sock);
    live = sock;
    /** アプリのレコードを切り出すための持ち越しバッファ */
    let appBuf: number[] = [];
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {
      /* 切断は無視（テスト側が close する） */
    });

    let phase = 0;
    let eReady = false;
    let binEor = false;
    /** クライアントが TN3270E を断った＝基本 TN3270 へ後退した */
    let fellBack = false;

    const sb = (body: readonly number[]): void => {
      const out: number[] = [IAC, SB];
      for (const b of body) {
        out.push(b);
        if (b === IAC) out.push(IAC);
      }
      out.push(IAC, SE);
      sock.write(Uint8Array.from(out));
    };
    const sendData = (): void => {
      setTimeout(() => {
        for (const rec of opts.records) {
          // **TN3270E なら 5 バイトヘッダを前置**（§8.1。基本 TN3270E はフラグ未使用）
          const framed =
            useE && !fellBack ? Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x00, ...rec]) : rec;
          sock.write(escapeIac(framed));
          sock.write(Uint8Array.from([IAC, EOR]));
        }
      }, opts.delayMs ?? 300);
    };
    const startBinEor = (): void => {
      if (binEor) return;
      binEor = true;
      sock.write(
        Uint8Array.from([IAC, DO, OPT_EOR, IAC, WILL, OPT_EOR, IAC, DO, OPT_BIN, IAC, WILL, OPT_BIN])
      );
    };

    // **TN3270E なら DO TN3270E から始める**（RFC §13.2: サーバが提示する）
    sock.write(Uint8Array.from(useE ? [IAC, DO, OPT_TN3270E] : [IAC, DO, OPT_TT]));

    sock.on("data", (chunk) => {
      const b = [...chunk];

      // クライアントが TN3270E を断った → 基本 TN3270 へ後退
      if (useE && b[0] === IAC && b[1] === WONT && b[2] === OPT_TN3270E) {
        // **後退経路**。以降は基本 TN3270 として振る舞う（データ送出の条件も基本側に倒す）
        fellBack = true;
        sock.write(Uint8Array.from([IAC, DO, OPT_TT]));
        return;
      }
      if (useE && b[0] === IAC && b[1] === WILL && b[2] === OPT_TN3270E) {
        sb([OPT_TN3270E, E_SEND, E_DEVICE_TYPE]);
        return;
      }
      // TN3270E のサブネゴシエーション
      if (b[0] === IAC && b[1] === SB && b[2] === OPT_TN3270E) {
        const end = b.indexOf(IAC, 3);
        const body = b.slice(3, end < 0 ? undefined : end);
        negLog.push(Buffer.from(body).toString("hex"));
        if (body[0] === E_DEVICE_TYPE && body[1] === E_REQUEST) {
          const rest = body.slice(2);
          const ci = rest.indexOf(E_CONNECT);
          eDeviceType = fromAscii(ci < 0 ? rest : rest.slice(0, ci));
          if (ci >= 0) eRequestedName = fromAscii(rest.slice(ci + 1));
          if (opts.rejectReason !== undefined) {
            sb([OPT_TN3270E, E_DEVICE_TYPE, E_REJECT, E_REASON, opts.rejectReason]);
            return;
          }
          const name = opts.assignName ?? "TSTTERM";
          sb([OPT_TN3270E, E_DEVICE_TYPE, E_IS, ...ascii(eDeviceType), E_CONNECT, ...ascii(name)]);
          return;
        }
        if (body[0] === E_FUNCTIONS && body[1] === E_REQUEST) {
          const list = body.slice(2);
          // **RFC §7.2.1**: 受け入れるなら `IS` に**受け取ったリストをそのまま**載せる。
          // 減らしたいときは `IS` ではなく **`REQUEST` で対案**を返す。
          //
          // このハーネスは基本 TN3270E だけを提供するので **BIND-IMAGE(0x00) を外す**。
          // 合意してしまうと BIND を送るまでクライアントが `unbound` のままになり、
          // 画面を描かない（s3270 で実際に踏んだ）。
          const withoutBind = list.filter((f) => f !== 0x00);
          if (withoutBind.length !== list.length) {
            sb([OPT_TN3270E, E_FUNCTIONS, E_REQUEST, ...withoutBind]);
            return; // クライアントの返事（IS か再対案）を待つ
          }
          sb([OPT_TN3270E, E_FUNCTIONS, E_IS, ...list]);
          eReady = true;
          startBinEor();
          sendData();
          return;
        }
        // クライアントが対案を `IS` で確定してきた
        if (body[0] === E_FUNCTIONS && body[1] === E_IS) {
          eReady = true;
          startBinEor();
          sendData();
          return;
        }
        return;
      }

      if (phase === 0 && b.includes(OPT_TT) && b.includes(WILL)) {
        sb([OPT_TT, 0x01]);
        phase = 1;
        return;
      }
      if (phase === 1 && b[0] === IAC && b[1] === SB && b[2] === OPT_TT) {
        const end = b.indexOf(IAC, 4);
        announcedType = Buffer.from(b.slice(4, end < 0 ? undefined : end)).toString("ascii");
        phase = 2;
        startBinEor();
        if (!useE || eReady || fellBack) sendData();
        return;
      }

      // **クライアントのアプリレコードを切り出す**。
      //
      // telnet の制御列を正しく飛ばす必要がある——`IAC` の次の 1 バイトだけ飛ばす作りだと
      // `IAC WILL EOR`(fffb19) の `19` が本文に紛れ込む（実際に踏んだ。応答の比較が
      // 先頭 `1919…` で汚れた）。コマンド長は種類で違うので分けて数える。
      if (phase >= 2 || eReady) {
        for (let i = 0; i < b.length; i++) {
          const c = b[i]!;
          if (c !== IAC) {
            appBuf.push(c);
            continue;
          }
          const next = b[i + 1];
          if (next === undefined) break;
          if (next === IAC) {
            appBuf.push(IAC); // 二重化の解除
            i++;
          } else if (next === EOR) {
            if (appBuf.length > 0) {
              // TN3270E ならクライアントも 5 バイトヘッダを付けてくる
              const rec = useE && !fellBack ? appBuf.slice(5) : appBuf;
              inboundRecs.push(Buffer.from(rec).toString("hex"));
            }
            appBuf = [];
            i++;
          } else if (next === 0xfb || next === 0xfc || next === 0xfd || next === 0xfe) {
            i += 2; // WILL / WONT / DO / DONT はオプション番号まで 3 バイト
          } else if (next === SB) {
            const se = b.indexOf(SE, i + 2);
            i = se < 0 ? b.length : se;
          } else {
            i++; // 2 バイトの制御
          }
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () =>
      resolve({
        port,
        terminalType: () => announcedType,
        deviceType: () => eDeviceType,
        requestedName: () => eRequestedName,
        negotiation: () => [...negLog],
        inbound: () => [...inboundRecs],
        send: (record: Uint8Array): void => {
          const framed = useE && !fellBack
            ? Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x00, ...record])
            : record;
          live?.write(escapeIac(framed));
          live?.write(Uint8Array.from([IAC, EOR]));
        },
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
