import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretStorage } from "vscode";

/**
 * 設定ファイル（`.ts5250emu`等）の`signon.passwordEnc`を暗号化・復号する（AES-256-GCM）。
 *
 * `packages/server/src/secret-crypto.ts`の`SecretCrypto`と**同じワイヤ形式**
 * （`v1:iv:tag:ct`）だが**独立実装**——`SecretCrypto`は`@ts5250/server`の公開API
 * （`src/index.ts`）から再輸出されておらず、外部パッケージが直接importすることを
 * 想定した実装ではない。master keyも別物（こちらは`vscode.SecretStorage`が持つ、
 * この拡張機能専用の鍵）。design.md「設計方針2」参照
 */

const VERSION = "v1";
const IV_LEN = 12; // GCM 推奨 96bit
const KEY_LEN = 32; // AES-256
const SECRET_KEY_NAME = "ts5250.masterKey";

export class ExtensionSecretCrypto {
  private constructor(private readonly key: Buffer) {}

  /**
   * SecretStorageから既存のmaster keyを読む。無ければ32byte乱数を生成して保存する
   * （初回起動時の1回だけ）。
   */
  static async fromSecretStorage(secrets: SecretStorage): Promise<ExtensionSecretCrypto> {
    const existing = await secrets.get(SECRET_KEY_NAME);
    if (existing !== undefined) return new ExtensionSecretCrypto(Buffer.from(existing, "hex"));
    const key = randomBytes(KEY_LEN);
    await secrets.store(SECRET_KEY_NAME, key.toString("hex"));
    return new ExtensionSecretCrypto(key);
  }

  /** 平文 → `v1:iv:tag:ct`（base64連結） */
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
      throw new Error("unsupported secret blob format");
    }
    const iv = Buffer.from(parts[1]!, "base64");
    const tag = Buffer.from(parts[2]!, "base64");
    const ct = Buffer.from(parts[3]!, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}
