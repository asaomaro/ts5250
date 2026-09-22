import { describe, it, expect } from "vitest";
import { hostServerPasswordSubstitute } from "../src/credentials.js";
import { encryptionTypeOf } from "../src/password.js";
import { startHostServer } from "../src/server-connect.js";
import type { HostConnection } from "../src/transport/host-connection.js";

/**
 * **ホストサーバーの認証の置換値をパスワードレベルごとに**（`20260921-hostserver-password-levels`）。
 * 期待値は ACS に同梱の jt400（`AS400ImplRemote` の `encryptPassword` / `generateShaSubstitute` / `generatePwdTokenForPasswordLevel4` +
 * `generateSha512Substitute`）を Java から、認証の分岐と同じ前処理（0/1 は数字始まりに `Q`、2/3 は末尾の空白を落とす、4 は落とさない）で
 * 呼んだ出力。シードはクライアント 01..08・サーバー A1 B2 C3 D4 E5 F6 07 18。
 * 以前は 4 を SHA-1 で計算し、数字で始まるパスワードに `Q` を付けていなかった（telnet の自動サインオンは `bypass-signon.ts` で揃えていた）。
 */
const C = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const S = Uint8Array.from([0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18]);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sub = async (level: number, user: string, pw: string) => hex(await hostServerPasswordSubstitute(level, user, pw, C, S));

describe("jt400 と同じ置換値", () => {
  it("レベル 0: 英字で始まるパスワード", async () => {
    expect(await sub(0, "usera", "pass1")).toBe("38583080039251be");
  });
  it("**レベル 0: 数字で始まるパスワードは頭に Q**", async () => {
    expect(await sub(0, "usera", "1pass")).toBe("bdf1b3ce8f83fe25");
  });
  it("レベル 2 / 3: SHA-1。末尾の空白は落とす", async () => {
    expect(await sub(2, "usera", "Secret")).toBe("00e117418d24fbeced107c62a46ed895b442f267");
    expect(await sub(3, "usera", "Secret  ")).toBe("00e117418d24fbeced107c62a46ed895b442f267");
  });
  it("**レベル 4: PBKDF2＋SHA-512（64 バイト）。末尾の空白は落とさない**", async () => {
    expect(await sub(4, "usera", "Secret")).toBe(
      "12951be37d7addd41c7ec53019187546725549ccb4a5f99c4bb0bbe344e5ecd03d2aa8cd2fe2239032c4e319d34ab82594ad0465ea06ade8598d6491108e2996"
    );
    expect(await sub(4, "usera", "Secret  ")).toBe(
      "fd1d668c543e50b33e08a4754c18380723cdc64e9ff43344123685ccc4d267742ed42594ac02794fca06231a173349fe231364f1d2089d8366be3f7a290ee159"
    );
    // パスワードが 4 文字未満（塩の末尾 4 文字を空白で詰める）
    expect(await sub(4, "usera", "ab")).toBe(
      "f918d07eff131e0a8120ecca13ad856405c99b40181cab295b5f14c51709c9faa489aaf29247fe230a16a34854191e0d9ac1f69f39489c9a4d1333d91a677879"
    );
  });
  it("レベル 2 以上は空と `*` で始まるパスワードを送らない（jt400 は AS400SecurityException）", async () => {
    await expect(sub(2, "usera", "*abc")).rejects.toThrow(/'\*'/);
    await expect(sub(4, "usera", "")).rejects.toThrow(/empty/);
  });
  it("レベル 0 は Q を付けて 10 文字を超えれば送らない", async () => {
    await expect(sub(0, "usera", "123456789A")).rejects.toThrow(/too long/);
  });
});

describe("要求の暗号化種別は置換値の長さで決まる（jt400 `SignonInfoReq` / `AS400StrSvrDS`）", () => {
  it("8 → 1、20 → 3、64 → 7", () => {
    expect(encryptionTypeOf(new Uint8Array(8))).toBe(1);
    expect(encryptionTypeOf(new Uint8Array(20))).toBe(3);
    expect(encryptionTypeOf(new Uint8Array(64))).toBe(7);
  });

  it("**レベル 4 のサーバー開始の要求は種別 7・置換値 64 バイト**", async () => {
    const frames: Uint8Array[] = [];
    const reply = (extra: number[]) => {
      const b = Uint8Array.from([...new Array(20).fill(0), 0, 0, 0, 0, ...extra]);
      new DataView(b.buffer).setUint32(0, b.length);
      return b;
    };
    const conn = {
      request: async (f: Uint8Array) => {
        frames.push(f);
        return frames.length === 1 ? reply([...S]) : reply([]);
      }
    } as unknown as HostConnection;
    await startHostServer(conn, 0xe004, { user: "usera", password: "Secret", passwordLevel: 4 });
    expect(frames[0]![4], "シード交換のクライアント属性（jt400 `AS400XChgRandSeedDS` と同じ 3）").toBe(3);
    const start = frames[1]!;
    expect(start[20], "暗号化種別").toBe(7);
    expect(new DataView(start.buffer, start.byteOffset).getUint32(22), "置換値の LL（6 + 64）").toBe(70);
  });
});

describe("サインオン・サーバーの要求も種別 7（レベル 4）", () => {
  it("**偽のサインオン・サーバーがレベル 4 を返すと、signon 情報要求は種別 7・置換値 64 バイト**", async () => {
    const { createServer } = await import("node:net");
    const { buildRequest, uintParam, CP, REQREP, SERVER_ID } = await import("../src/datastream.js");
    const { signon } = await import("../src/signon.js");
    const rc0 = new Uint8Array(4);
    const attrs = buildRequest({
      serverId: SERVER_ID.signon,
      reqRep: REQREP.signonExchangeAttributes,
      template: rc0,
      params: [uintParam(CP.version, 0x00070500, 4), uintParam(CP.datastreamLevel, 2, 2), uintParam(CP.passwordLevel, 4, 1), { cp: CP.seed, value: S }]
    });
    const info = buildRequest({ serverId: SERVER_ID.signon, reqRep: REQREP.signonInfo, template: rc0, params: [] });
    const got: Buffer[] = [];
    const server = createServer((sock) => {
      sock.on("error", () => undefined);
      sock.on("data", (d) => {
        got.push(d);
        sock.write(got.length === 1 ? attrs : info);
      });
    });
    const port = await new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
    try {
      const res = await signon({ host: "127.0.0.1", port, user: "usera", password: "Secret", timeoutMs: 3000 });
      expect(res.info.passwordLevel).toBe(4);
      // 属性交換のデータストリーム・レベルは jt400 `SignonExchangeAttributeReq` と同じ 10（CP 0x1102）
      const x = got[0]!;
      const at = x.indexOf(Buffer.from([0x11, 0x02]));
      expect(at, "CP 0x1102 が無い").toBeGreaterThan(0);
      expect(x.readUInt16BE(at + 2)).toBe(10);
      const req = got[1]!;
      expect(req[20], "暗号化種別").toBe(7);
      // 置換値の CP（0x1105）の LL は 6 + 64
      expect(req.readUInt32BE(21 + 10)).toBe(70);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("DDM の SECMEC（jt400 `DDMACCSECRequestDataStream` / `DDMSECCHKRequestDataStream`）", () => {
  // SECMEC は CP 0x11A2 の値。ACCSEC はレベル 2 以上で 8（SHA）・0/1 で 6（DES）、SECCHK は置換値が 20 / 64 バイトなら 8・8 バイトなら 6
  const secmecOf = (frame: Uint8Array) => {
    const b = Buffer.from(frame);
    const at = b.indexOf(Buffer.from([0x11, 0xa2]));
    return b.readUInt16BE(at + 2);
  };
  it("ACCSEC: レベル 0・1 は 6、2 以上は 8", async () => {
    const { buildAccsec } = await import("../src/ddm/ddm-connection.js");
    expect(secmecOf(buildAccsec(C, 0))).toBe(6);
    expect(secmecOf(buildAccsec(C, 1))).toBe(6);
    expect(secmecOf(buildAccsec(C, 2))).toBe(8);
    expect(secmecOf(buildAccsec(C, 4))).toBe(8);
  });
  it("SECCHK: DES（8 バイト）は 6、SHA-1（20）・SHA-512（64）は 8", async () => {
    const { buildSecchk } = await import("../src/ddm/ddm-connection.js");
    const user = new Uint8Array(10).fill(0x40);
    expect(secmecOf(buildSecchk(user, new Uint8Array(8)))).toBe(6);
    expect(secmecOf(buildSecchk(user, new Uint8Array(20)))).toBe(8);
    expect(secmecOf(buildSecchk(user, new Uint8Array(64)))).toBe(8);
  });
});
