import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * 参照クライアント `s3270` を docker で起動し、HTTP REST で問い合わせる補助。
 *
 * **テスト専用**（`src/` ではないので層規約の対象外）。
 *
 * ## すべて非同期にしてある（重要）
 *
 * 最初は `execFileSync` で書いたが、**`mini3270` が同じプロセスで動く**ため
 * 同期呼び出しがイベントループを止め、**サーバが接続を受け付けられなくなる**。
 * 「s3270 が 3270 モードに入らない」という形で実際に踏んだ。
 * 照合ハーネスは in-process サーバと同居する前提なので、**非同期であることが要件**。
 *
 * ## なぜ REST なのか
 *
 * s3270 の stdin スクリプトは動かなかった（`Wait()` が固まり stdout に何も出ない。
 * research で 3 通り試して再現）。`-httpd` の REST は完全に機能し、
 * `ReadBuffer(Ebcdic)` が**属性マーカー付きの生 EBCDIC バッファ**を返す。
 */

const IMAGE = "ts5250-s3270:latest";

export interface S3270Options {
  host: string;
  port: number;
  model?: 2 | 3 | 4 | 5;
  /** 装置指定（端末タイプ文字列に `@<値>` が付く） */
  device?: string;
  codePage?: string;
  /** コンテナ内のトレース出力先（`/tr` にホストの scratch を mount する） */
  trace?: string;
  httpPort?: number;
  name?: string;
}

export class S3270 {
  private constructor(
    private readonly container: string,
    private readonly httpPort: number
  ) {}

  static async start(opts: S3270Options): Promise<S3270> {
    const httpPort = opts.httpPort ?? 6100;
    const name = opts.name ?? `tn3270-s3270-${httpPort}`;
    await run("docker", ["rm", "-f", name]).catch(() => undefined);
    const target = opts.device
      ? `${opts.device}@${opts.host}:${opts.port}`
      : `${opts.host}:${opts.port}`;
    const cmd = [
      "s3270",
      "-httpd",
      `127.0.0.1:${httpPort}`,
      "-model",
      String(opts.model ?? 2),
      ...(opts.codePage ? ["-codepage", opts.codePage] : []),
      ...(opts.trace ? ["-trace", "-tracefile", opts.trace] : []),
      target
    ].join(" ");
    const mounts = opts.trace ? ["-v", `${process.env["TN3270_TRACE_DIR"] ?? "/tmp"}:/tr`] : [];
    await run("docker", ["run", "-d", "--name", name, "--network", "host", ...mounts, IMAGE, cmd]);
    return new S3270(name, httpPort);
  }

  /** アクションを 1 つ実行して `result` を返す */
  async action(expr: string): Promise<string[]> {
    const url = `http://127.0.0.1:${this.httpPort}/3270/rest/json/${encodeURIComponent(expr)}`;
    const { stdout } = await run("curl", ["-sS", "--max-time", "20", url]);
    const parsed = JSON.parse(stdout) as { result?: string[] | null };
    return parsed.result ?? [];
  }

  /** 画面を行ごとのテキストで */
  ascii(): Promise<string[]> {
    return this.action("Ascii()");
  }

  /** 属性マーカー付きの生 EBCDIC バッファ（1 行 1 要素） */
  readBufferEbcdic(): Promise<string[]> {
    return this.action("ReadBuffer(Ebcdic)");
  }

  async connectionState(): Promise<string> {
    return (await this.action("Query(ConnectionState)"))[0] ?? "";
  }

  /** 3270 モードに入るまで待つ */
  async waitReady(tries = 40, sleepMs = 250): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      try {
        if ((await this.connectionState()) === "connected-3270") return true;
      } catch {
        /* 起動直後は繋がらないことがある */
      }
      await new Promise((r) => setTimeout(r, sleepMs));
    }
    return false;
  }

  /**
   * 画面に中身が届くまで待つ。
   *
   * **`waitReady` だけでは足りない**——`connected-3270` は BINARY/EOR の合意で立つので、
   * ホストがデータを送る前に返ってくる。そこで読むと**空画面を掴む**（実際に踏んだ:
   * 自実装は中身を持っているのに s3270 側だけ真っ白で、比較が意味を成さなかった）。
   */
  async waitForContent(tries = 40, sleepMs = 250): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      try {
        if ((await this.ascii()).some((l) => l.trim().length > 0)) return true;
      } catch {
        /* まだ応答しない */
      }
      await new Promise((r) => setTimeout(r, sleepMs));
    }
    return false;
  }

  async stop(): Promise<void> {
    await run("docker", ["rm", "-f", this.container]).catch(() => undefined);
  }
}

/** docker と s3270 イメージが使えるか */
export async function s3270Available(): Promise<boolean> {
  try {
    await run("docker", ["image", "inspect", IMAGE]);
    return true;
  } catch {
    return false;
  }
}
