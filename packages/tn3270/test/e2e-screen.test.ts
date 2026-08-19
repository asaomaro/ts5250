import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TcpTransport } from "../src/transport/tcp.js";
import { TelnetLayer } from "../src/telnet/telnet.js";
import { terminalTypeFor } from "../src/telnet/terminal-type.js";
import { Screen3270 } from "../src/screen/buffer.js";
import { applyInbound } from "../src/protocol/inbound.js";
import { snapshot } from "../src/screen/snapshot.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270 } from "./harness/mini3270.js";

/**
 * **自実装と `s3270` が同じ画面を組み立てることの照合**（subtask 02 の受け入れ基準）。
 *
 * ```sh
 * sh packages/tn3270/test/harness/testenv.sh up
 * TN3270_E2E=1 npx vitest run test/e2e-screen.test.ts
 * ```
 *
 * **照合は `mini3270` に同じバイトを流して行う。** 実ホストへ 2 本繋いで比べる方法は
 * 当てにならない——Hercules は装置ごとに状態を持ち、2 本目には別の画面（や空画面）が返る。
 * 実際にそれで落ちた。**同じバイトを両方に食わせる**のが唯一まともな照合になる。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const host = process.env["TN3270_HOST"] ?? "127.0.0.1";
const port = Number(process.env["TN3270_PORT"] ?? 3270);
const here = dirname(fileURLToPath(import.meta.url));

/** 実ホストから 1 画面受け取る */
async function readFromHost(): Promise<ReturnType<typeof snapshot>> {
  const transport = await TcpTransport.connect({ host, port, connectTimeoutMs: 10_000 });
  try {
    const telnet = new TelnetLayer(transport, { terminalType: terminalTypeFor({ model: 2 }) });
    const screen = new Screen3270(2);
    const got = new Promise<void>((resolve) => {
      telnet.onRecord((rec) => {
        applyInbound(screen, rec);
        resolve();
      });
    });
    await Promise.race([
      got,
      new Promise((_, rej) => setTimeout(() => rej(new Error("画面が来ない")), 10_000))
    ]);
    return snapshot(screen);
  } finally {
    transport.close();
  }
}

/** fixture（実ホストから採取した生レコード）を読む */
function loadFixture(name: string): Uint8Array[] {
  const text = readFileSync(join(here, "fixtures", name), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => Uint8Array.from(Buffer.from((JSON.parse(l) as { hex: string }).hex, "hex")));
}

/** 自実装に同じレコードを流して snapshot を得る */
function applyAll(records: Uint8Array[]): ReturnType<typeof snapshot> {
  const screen = new Screen3270(2);
  for (const r of records) applyInbound(screen, r);
  return snapshot(screen);
}

/** 表示テキストを行ごとに（末尾の空白は落とす） */
function linesOf(snap: ReturnType<typeof snapshot>): string[] {
  return snap.cells.map((row) =>
    row
      .map((c) => (c.kind === "dbcs-tail" ? "" : c.char))
      .join("")
      .replace(/\s+$/, "")
  );
}

describe.skipIf(!enabled)("実ホスト（TK4-）から読む", () => {
  it("Hercules のウェルカム画面を組み立てられる", async () => {
    const snap = await readFromHost();
    const text = linesOf(snap).join("\n");
    expect(text).toMatch(/Hercules Version/);
    expect(text).toMatch(/LPAR Name/);
    expect(text).toMatch(/Tur\(n\)key System/);
    expect([snap.rows, snap.cols]).toEqual([24, 80]);
    expect(snap.fields.length).toBeGreaterThan(0);
  }, 40_000);
});

describe.skipIf(!enabled)("s3270 と同じバイトで突き合わせる", () => {
  it("属性桁の位置と表示テキストが一致する（TK4- 実採取の fixture）", async () => {
    expect(await s3270Available(), "s3270 イメージが無い。testenv.sh up を先に").toBe(true);
    const records = loadFixture("tk4-welcome.jsonl");
    expect(records.length).toBeGreaterThan(0);

    const ours = applyAll(records);
    const mini = await startMini3270({ records, port: 3291 });
    const ref = await S3270.start({
      host: "127.0.0.1",
      port: mini.port,
      httpPort: 6112,
      name: "tn3270-cmp"
    });
    try {
      expect(await ref.waitReady(), "s3270 が 3270 モードに入らない").toBe(true);
      // **中身が届くまで待つ**。connected-3270 は BINARY/EOR の合意で立つので、
      // ここを省くと空画面と比べて「一致」してしまう（実際に踏んだ）
      expect(await ref.waitForContent(), "s3270 に画面が届かない").toBe(true);
      expect(mini.terminalType()).toBe("IBM-3279-2-E");

      // 1. 属性桁の位置が一致する（ReadBuffer は属性桁を SF(...) と書く）
      const buf = await ref.readBufferEbcdic();
      expect(buf.length).toBe(24);
      const refAttrs: string[] = [];
      buf.forEach((line, r) => {
        line.split(" ").forEach((tok, c) => {
          if (tok.startsWith("SF(")) refAttrs.push(`${r + 1},${c + 1}`);
        });
      });
      const ourAttrs = ours.cells.flatMap((row, r) =>
        row.map((c, i) => (c.kind === "attr" ? `${r + 1},${i + 1}` : "")).filter(Boolean)
      );
      expect(ourAttrs).toEqual(refAttrs);
      expect(refAttrs.length).toBeGreaterThan(0); // 空振りで緑にならないこと

      // 2. 表示テキストが一致する
      expect(linesOf(ours)).toEqual((await ref.ascii()).map((l) => l.replace(/\s+$/, "")));
    } finally {
      await ref.stop();
      await mini.close();
    }
  }, 90_000);
});
