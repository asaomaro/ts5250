/**
 * マクロ（画面操作の記録・再生）のストア（`macros.json`）。
 *
 * **秘密の置き場所がここに集まっている**（spec D5・D7）。設計は既存の
 * `PersonalConfigStore`（`connections.json`）を踏襲する——所有者付きの個人資産で、
 * パスワードを `SecretCrypto` で暗号化して持ち、**平文も暗号文も API から出さない**。
 *
 * マクロ本体をブラウザ（localStorage）に置かずサーバーに集めたのは、秘密がサーバー管理に
 * なる以上、本体を分けるとマクロ削除で暗号文が孤児化し、二重の真実ができるため（spec D7）。
 *
 * 秘密の流れは 3 か所でしか触れない:
 *   1. `create()` … 平文を受け取り即 `encrypt()` して捨てる（呼び出し側も破棄する）
 *   2. `toPublic()` … `secretEnc` を**落として**返す（位置だけ `secretFields` で残す）
 *   3. `resolveSecret()` … 所有者を検証してから `decrypt()`。ws 経路だけが呼ぶ
 */
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { As400Error } from "@as400web/base";
import { assertOwner, type AuthUser } from "./auth.js";
import type { SecretCrypto } from "./secret-crypto.js";
import {
  createMacroBodySchema,
  macroFileSchema,
  renameMacroBodySchema,
  type MacroRecord,
  type MacroSecretRef,
  type MacroStepRecord,
  type PublicMacro,
  type PublicMacroStep
} from "./macro-types.js";

export class MacroStore {
  private readonly macros = new Map<string, MacroRecord>();
  private path: string | undefined;

  constructor(
    macros: MacroRecord[] = [],
    private readonly crypto?: SecretCrypto
  ) {
    for (const m of macros) this.macros.set(m.id, m);
  }

  /**
   * ファイルから読む。**未作成は空で開始する**（個人資産は起動時に無くて当然。
   * `PersonalConfigStore.fromFile` と同じ扱い）。壊れた JSON は起動を止める——
   * 黙って空で開くと、既存マクロがあるのに「消えた」ように見えたうえで上書きしてしまう。
   */
  static fromFile(path: string, crypto?: SecretCrypto): MacroStore {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const empty = new MacroStore([], crypto);
        empty.path = path;
        return empty;
      }
      throw new As400Error("CONFIG_ERROR", `failed to read macros ${path}: ${(err as Error).message}`);
    }
    const parsed = macroFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new As400Error("CONFIG_ERROR", `invalid macros.json: ${parsed.error.message}`);
    }
    const store = new MacroStore(parsed.data.macros, crypto);
    store.path = path;
    return store;
  }

  /** 保存できるか（ファイル由来のときのみ永続化できる） */
  get persistable(): boolean {
    return this.path !== undefined;
  }

  /** 秘密を保存できるか。鍵が無ければ「毎回入力する」しか選べない（spec D5・エッジケース） */
  get canStoreSecrets(): boolean {
    return this.crypto !== undefined;
  }

  // ---- 参照 ----

  /** 所有者チェック込みで 1 件引く。**ws の秘密解決もこれを通る**（`assertOwner` を迂回させない） */
  get(id: string, user: AuthUser | undefined): MacroRecord {
    const m = this.macros.get(id);
    if (!m) throw new As400Error("SESSION_NOT_FOUND", `macro ${id} not found`);
    assertOwner(m.owner, user);
    return m;
  }

  list(user: AuthUser | undefined): PublicMacro[] {
    return [...this.macros.values()]
      .filter((m) => this.canSee(m.owner, user))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((m) => toPublic(m));
  }

  private canSee(owner: string | undefined, user: AuthUser | undefined): boolean {
    try {
      assertOwner(owner, user);
      return true;
    } catch {
      return false;
    }
  }

  // ---- 更新 ----

  /**
   * 新規作成。`plainSecrets` は**ここで暗号化して捨てる**（平文は保存しない）。
   * 鍵が無いのに秘密を保存しようとしたら拒否する——黙って平文で持つ経路を作らないため
   * （`ConfigStore.encryptPassword` と同じ方針）。
   */
  create(raw: unknown, user: AuthUser | undefined, now: number): PublicMacro {
    const body = createMacroBodySchema.parse(raw);
    const steps: MacroStepRecord[] = body.steps.map((s) => {
      const step: MacroStepRecord = {
        screen: s.screen,
        fields: s.fields,
        key: s.key,
        cursor: s.cursor
      };
      if (s.plainSecrets && s.plainSecrets.length > 0) {
        if (!this.crypto) {
          throw new As400Error(
            "CONFIG_ERROR",
            "secret key not configured; cannot store macro secrets（AS400_SECRET_KEY を設定するか「毎回入力する」を選んでください）"
          );
        }
        const crypto = this.crypto;
        step.secrets = s.plainSecrets.map((p) => ({ field: p.field, secretEnc: crypto.encrypt(p.value) }));
      }
      if (s.promptFields && s.promptFields.length > 0) step.promptFields = s.promptFields;
      if (s.sysReqText !== undefined) step.sysReqText = s.sysReqText;
      return step;
    });

    const macro: MacroRecord = {
      id: `m-${randomUUID()}`,
      name: body.name,
      createdAt: now,
      updatedAt: now,
      steps
    };
    // owner は**入力から採らない**。リクエストの文脈から決める（なりすまし防止）
    if (user) macro.owner = user.username;
    if (body.incomplete === true) macro.incomplete = true;
    this.macros.set(macro.id, macro);
    return toPublic(macro);
  }

  /** 改名のみ。ステップの部分更新は行わない（差し替えは記録し直す＝秘密の入れ替え経路を作らない） */
  rename(id: string, raw: unknown, user: AuthUser | undefined, now: number): PublicMacro {
    const existing = this.get(id, user);
    const { name } = renameMacroBodySchema.parse(raw);
    const updated: MacroRecord = { ...existing, name, updatedAt: now };
    this.macros.set(id, updated);
    return toPublic(updated);
  }

  /** 削除。**秘密も一緒に消える**（孤児を作らないのが本体をサーバーに置いた理由。spec D7） */
  remove(id: string, user: AuthUser | undefined): void {
    this.get(id, user);
    this.macros.delete(id);
  }

  // ---- 秘密の解決（ws 経路だけが呼ぶ） ----

  /**
   * `secretRef` を平文に解決する（spec D11）。所有者を検証してから復号する。
   *
   * **解決できないときは必ず throw する**——空文字にフォールバックすると、ホストには
   * 「パスワード欄が空のまま」送られ、サインオン失敗や無効ユーザー扱いになって
   * 原因が分からなくなる。呼び出し側（ws-handler）はキー送信自体を拒否する。
   */
  resolveSecret(ref: MacroSecretRef, user: AuthUser | undefined): string {
    const macro = this.get(ref.macroId, user);
    const step = macro.steps[ref.step];
    if (!step) {
      throw new As400Error("CONFIG_ERROR", `macro ${ref.macroId}: step ${ref.step} not found`);
    }
    const secret = step.secrets?.find((s) => s.field === ref.field);
    if (!secret) {
      throw new As400Error(
        "CONFIG_ERROR",
        `macro ${ref.macroId}: no secret at step ${ref.step} field ${ref.field}`
      );
    }
    if (!this.crypto) {
      throw new As400Error("CONFIG_ERROR", "secret key not configured; cannot replay macro secrets");
    }
    try {
      return this.crypto.decrypt(secret.secretEnc);
    } catch {
      // 鍵の入れ替え・改ざんで復号できない。**理由は残すが値は残さない**
      throw new As400Error(
        "CONFIG_ERROR",
        `macro ${ref.macroId}: failed to decrypt secret (step ${ref.step} field ${ref.field}); 記録し直してください`
      );
    }
  }

  /** 原子的に保存（tmp→rename）。**CRUD からの明示呼び出しのみ**（`ConfigStore.save` と同じ方針） */
  async save(): Promise<void> {
    if (!this.path) return;
    const json = JSON.stringify({ macros: [...this.macros.values()] }, null, 2);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.path);
  }
}

/**
 * API 露出用に落とし込む。**`secretEnc` を持ち出さない**——暗号文であっても外に出すと
 * オフライン解析の的が増えるうえ、既存の
 * 「パスワードは形式を問わず決して返さない」（`config-types.ts` の `PublicSystem`）が破れる。
 * 秘密が入る欄の**位置だけ**を返し、クライアントはそれで `secretRef` を組み立てる。
 */
export function toPublic(m: MacroRecord): PublicMacro {
  const steps: PublicMacroStep[] = m.steps.map((s) => {
    const step: PublicMacroStep = {
      // **複製して返す**——参照のまま渡すと、応答を受け取った側の書き換えがストアの実体に届く
      // （`config-types.ts` の `publicSession` が watermark を複製しているのと同じ理由）。
      // HTTP 経路は JSON 化されるので出ないが、buildApp を直接呼ぶ組み込み・テスト経路で効く
      screen: { ...s.screen, targets: s.screen.targets.map((t) => ({ ...t })) },
      fields: s.fields.map((f) => ({ ...f })),
      key: s.key,
      cursor: { ...s.cursor }
    };
    if (s.secrets && s.secrets.length > 0) step.secretFields = s.secrets.map((x) => x.field);
    if (s.promptFields && s.promptFields.length > 0) step.promptFields = [...s.promptFields];
    if (s.sysReqText !== undefined) step.sysReqText = s.sysReqText;
    return step;
  });
  const pub: PublicMacro = {
    id: m.id,
    name: m.name,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    hasSecret: m.steps.some((s) => (s.secrets?.length ?? 0) > 0),
    steps
  };
  if (m.owner !== undefined) pub.owner = m.owner;
  if (m.incomplete === true) pub.incomplete = true;
  return pub;
}
