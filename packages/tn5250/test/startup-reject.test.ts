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
 * ⚠ 実機では**装置名の重複でこの経路に入らない**——ホストは理由を返さず
 * ソケットを閉じる（`scripts/research-device-busy.mjs`）。よってレコードは合成する。
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
