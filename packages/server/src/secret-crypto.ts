import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { As400Error } from "@as400web/core";

/**
 * 接続設定の自動サインオン用パスワードを暗号化するモジュール（Node 標準 crypto のみ）。
 * - AES-256-GCM。master key は環境変数（既定 AS400_SECRET_KEY）から読む。コード・レコードに鍵を持たない。
 * - 暗号文フォーマット: `v1:<ivB64>:<tagB64>:<ctB64>`（v1 は鍵/方式バージョン。将来の鍵ローテーションに備える）。
 * - 平文パスワードは接続レコードに保存しない（この暗号文のみを保存する）。
 */

const VERSION = "v1";
const IV_LEN = 12; // GCM 推奨 96bit
const KEY_LEN = 32; // AES-256

/** master key 文字列（hex64 or base64）を 32byte にデコードする。不正なら throw */
function decodeKey(raw: string): Buffer {
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    try {
      key = Buffer.from(raw, "base64");
    } catch {
      throw new As400Error("CONFIG_ERROR", "AS400_SECRET_KEY must be 32-byte hex or base64");
    }
  }
  if (key.length !== KEY_LEN) {
    throw new As400Error(
      "CONFIG_ERROR",
      `AS400_SECRET_KEY must decode to ${KEY_LEN} bytes (got ${key.length})`
    );
  }
  return key;
}

export class SecretCrypto {
  private constructor(private readonly key: Buffer) {}

  /**
   * 環境変数から master key を読む。未設定なら undefined（＝暗号化機能オフ）。
   * 設定はあるが長さ不正なら throw（黙って弱い鍵にしない）。
   */
  static fromEnv(envName = "AS400_SECRET_KEY", env: NodeJS.ProcessEnv = process.env): SecretCrypto | undefined {
    const raw = env[envName];
    if (raw === undefined || raw === "") return undefined;
    return new SecretCrypto(decodeKey(raw));
  }

  /**
   * 単一利用者（Electron 等・非マルチユーザー）向け: master key が無ければ生成して keyFile（既定 .env）に
   * 保存し、その場でも使えるよう process.env にも載せる。既に env / keyFile にあればそれを使う。
   * generated=true のとき新規生成した（呼び出し側でログ・注意喚起に使う）。
   */
  static fromEnvOrCreate(
    envName = "AS400_SECRET_KEY",
    keyFile = ".env",
    env: NodeJS.ProcessEnv = process.env
  ): { crypto: SecretCrypto; generated: boolean } {
    const existing = env[envName];
    if (existing !== undefined && existing !== "") {
      return { crypto: new SecretCrypto(decodeKey(existing)), generated: false };
    }
    // env に無くても keyFile に在れば使う（--env-file 未使用で起動した場合など。重複生成を防ぐ）
    const fromFile = readKeyFromFile(keyFile, envName);
    if (fromFile) {
      env[envName] = fromFile;
      return { crypto: new SecretCrypto(decodeKey(fromFile)), generated: false };
    }
    const key = randomBytes(KEY_LEN);
    const hex = key.toString("hex");
    persistKey(keyFile, envName, hex);
    env[envName] = hex; // 今回の起動でも使えるように
    return { crypto: new SecretCrypto(key), generated: true };
  }

  /** 平文 → `v1:iv:tag:ct`（base64 連結） */
  encrypt(plain: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
  }

  /** `v1:iv:tag:ct` → 平文。バージョン不一致・改ざん・鍵不一致は throw */
  decrypt(blob: string): string {
    const parts = blob.split(":");
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new As400Error("CONFIG_ERROR", "unsupported secret blob format");
    }
    const iv = Buffer.from(parts[1]!, "base64");
    const tag = Buffer.from(parts[2]!, "base64");
    const ct = Buffer.from(parts[3]!, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}

/** dotenv 形式のファイルから `NAME=VALUE` を 1 件読む（クォートは剥がす）。無ければ undefined */
function readKeyFromFile(path: string, name: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && m[1] === name) return m[2]!.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* 読めなければ未設定扱い */
  }
  return undefined;
}

/** dotenv 形式のファイルへ `NAME=VALUE` を追記する（新規作成時は 0600）。 */
function persistKey(path: string, name: string, value: string): void {
  const line = `${name}=${value}\n`;
  if (existsSync(path)) {
    const cur = readFileSync(path, "utf8");
    const sep = cur.length === 0 || cur.endsWith("\n") ? "" : "\n";
    appendFileSync(path, sep + line);
  } else {
    writeFileSync(path, line, { mode: 0o600 });
  }
}
