import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { isKnownStartupCode } from "../src/telnet/startup-record.js";
import type { Transport } from "../src/transport/types.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

const codec = codecForCcsid(37);

/**
 * **失敗の起動応答を表示セッションでも受け止める**（`20260802-device-busy-record`）。
 *
 * 起動応答（RFC 4777 §10）は成功でも失敗でも返る。ところが表示セッションは
 * 「**装置名が入っているか**」だけで起動応答を見分けていた。
 * **失敗のときは装置名が入らない**——割り当てられていないのだから当然——ので、
 * 失敗応答を取りこぼして 5250 のデータストリームとして解析しに行き、
 * `expected ESC, got 0x…` という**こちらの解析器が壊れたように見える警告**だけが残って、
 * 本当の理由（`8902 Device not available.`）はどこにも出なかった。
 *
 * プリンター（`PrinterSession.handleStartup`）は元からコードで見ていた。**同じ判断へ揃える。**
 *
 * ~~⚠ 実機では**装置名の重複でこの経路に入らない**——ホストは理由を返さずソケットを閉じる（`scripts/research-device-busy.mjs`）~~
 * → 実機（PUB400・社内機）とも 8902 を返し、同じ接続の中で NEW-ENVIRON SEND を送り直してきた（`20260921-device-name-acs` の実測）。
 * レコードは合成する。
 * 形式は実機 PUB400 で捕えた 1 レコード目に合わせてある（`startup-record.test.ts`）。
 */
const IAC_EOR = [0xff, 0xef];

/** 起動応答レコードを組む。`code` は 4 文字。`device` を省くと**失敗応答の形**（短い） */
function startupRecord(code: string, system?: string, device?: string): number[] {
  // **符号化は本物の codec に任せる。** 手書きの対応表を持つと、表に無い文字が
  // 空白に化けて「未知コード」の検査が別物になる（実際 `Z` が抜けて test が空振りした）
  const ebcdic = (s: string, len: number): number[] => [...codec.encode(s.padEnd(len, " ")).bytes].slice(0, len);
  // ヘッダーは実機と同じ形（`at = 6 + data[6]` で読み位置が決まる）
  const head = [0x00, 0x00, 0x12, 0xa0, 0x90, 0x00, 0x05, 0x60, 0x06, 0x00, 0x20, 0xc0, 0x00, 0x3d, 0x00, 0x00];
  const body =
    device === undefined
      ? ebcdic(code, 4)
      : [...ebcdic(code, 4), ...ebcdic(system ?? "SYS", 8), ...ebcdic(device, 10)];
  const rec = [...head, ...body];
  rec[1] = rec.length; // LL（実装は読まないが実物に合わせる）
  return rec;
}

function fakeTransport(): { transport: Transport; feed: (b: number[]) => void } {
  let onData: ((d: Uint8Array) => void) | undefined;
  const transport = {
    onData: (cb: (d: Uint8Array) => void) => {
      onData = cb;
    },
    onClose: () => {},
    onError: () => {},
    send: () => {},
    close: () => {}
  } as unknown as Transport;
  return { transport, feed: (b) => onData?.(Uint8Array.from(b)) };
}

/** 1 レコード目として `rec` を流し、`connect` の結末と警告を返す */
async function connectWith(rec: number[], deviceName?: string) {
  const { transport, feed } = fakeTransport();
  const warnings: string[] = [];
  const p = Session5250.connect({
    id: "t",
    transport,
    negotiationTimeoutMs: 400,
    warn: (m) => warnings.push(m),
    ...(deviceName !== undefined ? { deviceName } : {})
  });
  const settled = p.then(
    (s) => ({ ok: true as const, session: s }),
    (e: Error & { code?: string }) => ({ ok: false as const, code: e.code, message: e.message })
  );
  await new Promise((r) => setTimeout(r, 30));
  feed([...rec, ...IAC_EOR]);
  const out = await settled;
  if (out.ok) out.session.disconnect();
  return { ...out, warnings };
}

describe("isKnownStartupCode", () => {
  it("成功コードも失敗コードも既知", () => {
    expect(isKnownStartupCode("I902")).toBe(true);
    expect(isKnownStartupCode("8902")).toBe(true);
    expect(isKnownStartupCode("2702")).toBe(true);
  });

  it("表に無いものは未知（**通常のデータストリームを食べないための門番**）", () => {
    expect(isKnownStartupCode("9999")).toBe(false);
    expect(isKnownStartupCode("")).toBe(false);
  });
});

describe("表示セッションの起動応答", () => {
  it("**失敗コードは理由つきで断られる**（装置名が入っていなくても取りこぼさない）", async () => {
    const r = await connectWith(startupRecord("8902"), "DEV1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("SESSION_REJECTED");
    expect(r.message).toContain("8902");
    expect(r.message).toContain("Device not available.");
  });

  it("**要求した装置名を文言に添える**（失敗応答には入っていないので利用者が直せない）", async () => {
    const r = await connectWith(startupRecord("8902"), "DEV1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("DEV1");
  });

  it("**解析器の警告を出さない**（壊れたように見せない）", async () => {
    const r = await connectWith(startupRecord("8902"), "DEV1");
    expect(r.warnings.some((w) => w.includes("expected ESC"))).toBe(false);
    expect(r.warnings.some((w) => w.includes("session rejected 8902"))).toBe(true);
  });

  it("成功コードは従来どおり（起動応答として控えて先へ）", async () => {
    const r = await connectWith(startupRecord("I902", "S1234567", "DEV1"), "DEV1");
    // 画面がまだ来ていないので接続は完了しない（タイムアウト）が、**断られてはいない**
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NEGOTIATION_TIMEOUT");
    expect(r.warnings.some((w) => w.includes("startup response I902"))).toBe(true);
  });

  it("未知コード ＋ 装置名あり は従来どおり食べる（今まで通っていたものを落とさない）", async () => {
    const r = await connectWith(startupRecord("Z123", "SYS", "DEV1"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NEGOTIATION_TIMEOUT");
    expect(r.warnings.some((w) => w.includes("startup response Z123"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("session rejected"))).toBe(false);
  });

  it("未知コード ＋ 装置名なし はデータストリーム扱い（誤って食べない）", async () => {
    const r = await connectWith(startupRecord("Z123"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // 起動応答として扱わないので、5250 として解析される＝従来の経路
    expect(r.warnings.some((w) => w.includes("startup response"))).toBe(false);
  });

  /**
   * **ACS が個別に扱う 4 つ**（`20260921-startup-codes-unknown`）。
   *
   * `DS5250.processStartUpConfirmation` の lookupswitch に個別の分岐があり、
   * それぞれ別の通信状態へ落ちる（2703→12 / 2777→13 / 8936→33 / 8937→34）。
   * **表に無いと起動応答と認識されず**、`expected ESC` の警告だけが残って
   * **自動サインオン失敗の本当の理由が消える**。
   */
  for (const code of ["2703", "2777", "8936", "8937"]) {
    it(`${code} を起動応答として認識し、断られたと分かる（装置名が無くても）`, async () => {
      const r = await connectWith(startupRecord(code));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      // 失敗コードは `session rejected <code>` を出す（成功側が `startup response <code>`）
      expect(
        r.warnings.some((w) => w.includes(`session rejected ${code}`)),
        "起動応答として扱われていない＝5250 データに流れ込んでいる"
      ).toBe(true);
      // **解析器が壊れたように見える警告が出ない**——この項目が直したかったのはここ
      expect(r.warnings.some((w) => w.includes("expected ESC"))).toBe(false);
    });
  }
});

/**
 * **閉じた通信路へ交渉の返事を送らない**（`20260802-device-busy-record`）。
 *
 * 交渉の返事は**受信データの処理中**に送られる。ホストが交渉の途中でソケットを閉じると、
 * 既に届いていたバイトの処理が続き、閉じた通信路へ送りに行く。`TcpTransport.send` は
 * そこで投げるが、その例外は**ソケットのコールバックから飛び出して捕まえる相手がいない**
 * ——**プロセスが落ちる**。実機で装置名が使用中のときに踏んだ。
 */
describe("交渉中にホストが閉じたとき", () => {
  it("**閉じた後の送信で落ちない**（例外がコールバックから飛び出さない）", async () => {
    let onData: ((d: Uint8Array) => void) | undefined;
    let onClose: ((r: string) => void) | undefined;
    let closed = false;
    const transport = {
      onData: (cb: (d: Uint8Array) => void) => { onData = cb; },
      onClose: (cb: (r: string) => void) => { onClose = cb; },
      onError: () => {},
      // **本物の TcpTransport と同じく、閉じた後の送信は投げる**
      send: () => { if (closed) throw new Error("transport is closed"); },
      close: () => { closed = true; }
    } as unknown as Transport;

    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 200 }).catch(
      (e: Error & { code?: string }) => e.code
    );
    await new Promise((r) => setTimeout(r, 20));
    // ホストが閉じ、その直後に届いていたバイトが処理される（実機で起きる順序）
    closed = true;
    onClose?.("socket closed");
    // IAC DO NEW-ENVIRON（0xff 0xfd 0x27）＝返事を送りたくなるサブネゴシエーション
    expect(() => onData?.(Uint8Array.from([0xff, 0xfd, 0x27]))).not.toThrow();
    expect(await p).toBe("SESSION_CLOSED");
  });
});

/**
 * **装置が使用中（8902）なら、同じ接続の中で次の名前で答え直す**（ACS と同じ。`20260921-device-name-acs`）。
 * 実測（ACS のコア・PUB400）: `TSC=` → `TSC0`（8902）→ ホストが SEND を送り直す → `TSC1` → I902。
 */
describe("装置名の答え直し", () => {
  const SEND = [0xff, 0xfa, 0x27, 0x01, 0xff, 0xf0];
  function capturing(): { transport: Transport; feed: (b: number[]) => void; devnames: () => string[] } {
    let onData: ((d: Uint8Array) => void) | undefined;
    const sent: number[] = [];
    const transport = {
      onData: (cb: (d: Uint8Array) => void) => {
        onData = cb;
      },
      onClose: () => {},
      onError: () => {},
      send: (d: Uint8Array) => void sent.push(...d),
      close: () => {}
    } as unknown as Transport;
    const devnames = (): string[] => {
      const text = String.fromCharCode(...sent);
      return [...text.matchAll(/DEVNAME\x01([A-Z0-9=&%*+]*)/g)].map((m) => m[1]!);
    };
    return { transport, feed: (b) => onData?.(Uint8Array.from(b)), devnames };
  }
  async function run(deviceName: string, opts: { retry?: boolean } = {}) {
    const { transport, feed, devnames } = capturing();
    const warnings: string[] = [];
    const settled = Session5250.connect({
      id: "t",
      transport,
      negotiationTimeoutMs: 400,
      warn: (m) => warnings.push(m),
      deviceName,
      ...(opts.retry ? { deviceNameRetry: true } : {})
    }).then(
      (s) => ({ ok: true as const, session: s }),
      (e: Error & { code?: string }) => ({ ok: false as const, code: e.code, message: e.message })
    );
    await new Promise((r) => setTimeout(r, 20));
    feed(SEND);
    feed([...startupRecord("8902"), ...IAC_EOR]);
    feed(SEND); // ホストが聞き直す
    return { settled, feed, devnames, warnings };
  }

  it("**`=` を含む名前は、使用中なら次の番号で答え直し、次の起動応答を待つ**", async () => {
    const r = await run("DEV=");
    r.feed([...startupRecord("I902", "S1234567", "DEV1"), ...IAC_EOR]);
    const out = await r.settled;
    expect(r.devnames()).toEqual(["DEV0", "DEV1"]);
    // 画面がまだ来ていないので完了はしない（時間切れ）が、**8902 で断られてはいない**
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("NEGOTIATION_TIMEOUT");
    expect(r.warnings.some((w) => w.includes("in use (8902)"))).toBe(true);
    // 2 回目の起動応答も起動応答として受け取った（データとして解析しに行かない）
    expect(r.warnings.some((w) => w.includes("startup response I902") && w.includes("device=DEV1"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("expected ESC"))).toBe(false);
  });

  it("記号の無い名前は従来どおり 8902 で断る（ACS は同じ名前を送り直すだけで繋がらない）", async () => {
    const r = await run("DEV1");
    const out = await r.settled;
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("SESSION_REJECTED");
  });

  it("当 PJ の `deviceNameRetry` は、記号の無い名前でも末尾の数字を繰り上げて答え直す（繋ぎ直さない）", async () => {
    const r = await run("DEV1", { retry: true });
    r.feed([...startupRecord("I902", "S1234567", "DEV2"), ...IAC_EOR]);
    const out = await r.settled;
    expect(r.devnames()).toEqual(["DEV1", "DEV2"]);
    if (out.ok) return;
    expect(out.code).toBe("NEGOTIATION_TIMEOUT");
  });

  it("**答え直したのにホストが聞き直してこなければ、8902 の理由を残して断る**（一般的な時間切れにしない。節目の点検の懸念）", async () => {
    const { transport, feed } = capturing();
    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 200, deviceName: "DEV=" });
    await new Promise((r) => setTimeout(r, 20));
    feed(SEND);
    feed([...startupRecord("8902"), ...IAC_EOR]); // この後ホストは何も言わない
    await expect(p).rejects.toMatchObject({ code: "SESSION_REJECTED", message: expect.stringMatching(/8902.*DEV0.*did not ask/) });
  });

  it("時間切れのときは接続を閉じる（理由を先に決めてから閉じる）", async () => {
    const { transport, feed } = capturing();
    let closed = 0;
    (transport as unknown as { close: () => void }).close = () => void closed++;
    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 100, deviceName: "DEV=" });
    await new Promise((r) => setTimeout(r, 20));
    feed(SEND);
    await expect(p).rejects.toMatchObject({ code: "NEGOTIATION_TIMEOUT" });
    expect(closed).toBeGreaterThan(0);
  });

  it("答え直しの途中で切られても 8902 の理由を残す", async () => {
    let onClose: ((r: string) => void) | undefined;
    const { transport, feed } = capturing();
    (transport as unknown as { onClose: (cb: (r: string) => void) => void }).onClose = (cb) => void (onClose = cb);
    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 400, deviceName: "DEV=" });
    await new Promise((r) => setTimeout(r, 20));
    feed(SEND);
    feed([...startupRecord("8902"), ...IAC_EOR]);
    onClose?.("socket closed");
    await expect(p).rejects.toMatchObject({ code: "SESSION_REJECTED", message: expect.stringMatching(/8902.*socket closed/) });
  });

  it("**8902 以外の失敗は答え直さない**（誤ったパスワードで何度も試して QMAXSIGN を使い切らない）", async () => {
    const { transport, feed } = capturing();
    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 400, deviceName: "DEV=" });
    await new Promise((r) => setTimeout(r, 20));
    feed(SEND);
    feed([...startupRecord("8906"), ...IAC_EOR]);
    await expect(p).rejects.toMatchObject({ code: "SESSION_REJECTED" });
  });
});
