import { describe, it, expect } from "vitest";
import { createServer, type Socket } from "node:net";
import { Tn3270Session } from "../src/session/session.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC } from "../src/protocol/constants.js";

/**
 * **自実装と `s3270` の送信バイトが一致することの照合**（subtask 03 の受け入れ基準）。
 *
 * ```sh
 * sh packages/tn3270/test/harness/testenv.sh up
 * TN3270_E2E=1 npx vitest run test/e2e-input.test.ts
 * ```
 *
 * 受信側（ホスト役）を自前で立て、**同じ画面を出し・同じ入力をして・送ってきたバイトを比べる**。
 * 実ホスト（TK4-）は入力を受け付ける画面を持たない（TSO も Hercules コンソールも
 * キーボードがロックされたまま）ので、照合はこの形でしかできない。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

/** 行1 と 行10 に非保護欄を持つ画面 */
const SCREEN = Uint8Array.from([
  CMD3270.ERASE_WRITE, WCC.RESTORE | WCC.RESET_MDT | 0xc0,
  ...sba(0), ORDER.SF, 0x00,
  ...sba(20), ORDER.SF, 0x20,
  ...sba(730), ORDER.SF, 0x00,
  ...sba(760), ORDER.SF, 0x20,
  ...sba(1), ORDER.IC
]);

/** ホスト役。交渉して画面を出し、受け取ったレコードを溜める */
function hostServer(port: number) {
  const inbound: string[] = [];
  let live: Socket | undefined;
  const srv = createServer((sock) => {
    live = sock;
    let phase = 0;
    let buf: number[] = [];
    sock.write(Uint8Array.from([0xff, 0xfd, 0x18]));
    sock.on("data", (c) => {
      const b = [...c];
      if (phase === 0 && b.includes(0x18) && b.includes(0xfb)) {
        sock.write(Uint8Array.from([0xff, 0xfa, 0x18, 0x01, 0xff, 0xf0]));
        phase = 1;
        return;
      }
      if (phase === 1 && b[0] === 0xff && b[1] === 0xfa) {
        sock.write(
          Uint8Array.from([0xff, 0xfd, 0x19, 0xff, 0xfb, 0x19, 0xff, 0xfd, 0x00, 0xff, 0xfb, 0x00])
        );
        setTimeout(() => {
          sock.write(SCREEN);
          sock.write(Uint8Array.from([0xff, 0xef]));
          buf = [];
          phase = 2;
        }, 200);
        return;
      }
      if (phase === 2) {
        for (let i = 0; i < b.length; i++) {
          if (b[i] === 0xff && b[i + 1] === 0xef) {
            inbound.push(Buffer.from(buf).toString("hex"));
            buf = [];
            i++;
            // 応答を返さないと s3270 はロックされたまま次に進まない
            sock.write(Uint8Array.from([0xf1, WCC.RESTORE, 0xff, 0xef]));
          } else if (b[i] === 0xff && b[i + 1] === 0xff) {
            buf.push(0xff);
            i++;
          } else {
            buf.push(b[i]!);
          }
        }
      }
    });
    sock.on("error", () => undefined);
  });
  return {
    srv,
    inbound,
    listen: (): Promise<void> => new Promise((r) => srv.listen(port, "0.0.0.0", () => r())),
    close: (): Promise<void> =>
      new Promise((r) => {
        live?.destroy();
        srv.close(() => r());
      })
  };
}

async function waitFor(get: () => number, want: number, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (get() >= want) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!enabled)("送信バイトが s3270 と一致する", () => {
  it("入力なしの各キーと、2 欄に入力した Enter", async () => {
    expect(await s3270Available()).toBe(true);

    // --- s3270 側 ---
    const refHost = hostServer(3294);
    await refHost.listen();
    const ref = await S3270.start({
      host: "127.0.0.1",
      port: 3294,
      httpPort: 6140,
      name: "tn3270-in-ref"
    });
    const refBytes: Record<string, string> = {};
    try {
      expect(await ref.waitReady()).toBe(true);
      for (const [setup, action, label] of [
        [null, "Enter()", "enter"],
        [null, "PF(1)", "pf1"],
        [null, "PA(1)", "pa1"],
        // **入力を伴う往復**（変更欄の内容が乗る形）。行1 と 行10 の 2 欄に打つ
        ['MoveCursor1(1,2)|String("AB")|MoveCursor1(10,12)|String("ZZ")', "Enter()", "typed"]
      ] as [string | null, string, string][]) {
        if (setup) for (const a of setup.split("|")) await ref.action(a);
        const n = refHost.inbound.length;
        await ref.action(action);
        await waitFor(() => refHost.inbound.length, n + 1);
        refBytes[label] = refHost.inbound[n] ?? "";
      }
      await ref.stop();
    } finally {
      await refHost.close();
    }

    // --- 自実装側（同じホスト役・同じ手順）---
    const ourHost = hostServer(3295);
    await ourHost.listen();
    const s = new Tn3270Session({ host: "127.0.0.1", port: 3295, model: 2 });
    const ourBytes: Record<string, string> = {};
    try {
      await s.connect();
      await waitFor(() => (s.snapshot().fields.length > 0 ? 1 : 0), 1);
      for (const key of ["enter", "pf1", "pa1"] as const) {
        const n = ourHost.inbound.length;
        s.send(key);
        await waitFor(() => ourHost.inbound.length, n + 1);
        ourBytes[key] = ourHost.inbound[n] ?? "";
      }
      // s3270 と同じ入力をしてから Enter
      s.setCursor(1, 2);
      s.type("AB");
      s.setCursor(10, 12);
      s.type("ZZ");
      const n2 = ourHost.inbound.length;
      s.send("enter");
      await waitFor(() => ourHost.inbound.length, n2 + 1);
      ourBytes["typed"] = ourHost.inbound[n2] ?? "";
    } finally {
      s.close();
      await ourHost.close();
    }

    // **空振りで緑にならないこと**——両方が空文字なら一致してしまう
    expect(Object.keys(refBytes).length).toBe(4);
    for (const [k, v] of Object.entries(refBytes)) {
      expect(v.length, `s3270 の ${k} が空`).toBeGreaterThan(0);
    }
    // 実測済みの既知値とも突き合わせる（探針 aid.trc と一致するはず）
    expect(refBytes["pa1"]).toBe("6c");
    // 実測: AID + カーソル + (SBA + 欄の先頭 + データ) × 2
    expect(refBytes["typed"]).toMatch(/^7d.{4}11.{4}c1c211.{4}e9e9$/);

    expect(ourBytes).toEqual(refBytes);
  }, 120_000);
});

describe.skipIf(!enabled)("実ホスト（TK4-）と往復する", () => {
  it("接続して画面を受け取り、Enter を送るとホストが応答する", async () => {
    const s = new Tn3270Session({
      host: process.env["TN3270_HOST"] ?? "127.0.0.1",
      port: Number(process.env["TN3270_PORT"] ?? 3270),
      model: 2
    });
    let screens = 0;
    s.on("screen", () => screens++);
    try {
      await s.connect();
      await waitFor(() => screens, 1, 8000);
      expect(screens).toBeGreaterThan(0);
      const before = screens;

      s.send("enter");
      expect(s.status).toBe("locked");
      // ホストが応答すれば WCC restore でロックが解ける
      await waitFor(() => screens, before + 1, 8000);
      expect(screens).toBeGreaterThan(before);
      expect(s.status).toBe("ready");

      const text = s
        .snapshot()
        .cells.map((r) => r.map((c) => c.char).join(""))
        .join("\n");
      expect(text.length).toBeGreaterThan(0);
    } finally {
      s.close();
    }
  }, 60_000);
});
