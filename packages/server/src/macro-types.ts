/**
 * マクロ（画面操作の記録・再生）の型。
 *
 * **記録の単位は「打鍵」ではなく「画面」**（spec D1）。5250 の送信はもともと
 * 「AID ＋ そのフォーマットで編集したフィールド値」であり（`WsKey`）、新しい画面が届くと
 * ローカル編集差分が消える（`sessions.ts` の `edits.clear()`）。この画面境界がそのまま
 * ステップの区切りになる。ACS が使う HOD マクロも同じく画面単位で
 * `<description>`（照合）/ `<actions>`（操作）を持つ（research F2）。
 *
 * **型を 3 層に分けているのは秘密のため**（spec D5・D11）:
 *   - `MacroRecord` … サーバーのファイルにだけ在る完全形。`secretEnc`（暗号文）を持つ
 *   - `PublicMacro` … API で返す形。**暗号文も平文も落とす**（`hasSecret` の真偽だけ残す）
 *   - `CreateMacroBody` … 保存要求。`plainSecrets` はここにしか現れず、暗号化したら捨てる
 * この分離が崩れると、既存の自動サインオンで守っている
 * 「パスワードは形式を問わず決して返さない」（`config-types.ts` の `PublicSystem`）が破れる。
 */
import { z } from "zod";
import type { AidKey } from "@as400web/tn5250";

/**
 * AID キー名。`@as400web/tn5250` の `AidKey` と一致させる（値の検証はここで行う）。
 * 一致は下の `_assertAidKeyParity` がコンパイル時に突き合わせる——zod の enum は
 * 値の羅列なので、core 側にキーが増えても**書き足さない限り黙って通ってしまう**。
 */
export const aidKeySchema = z.enum([
  "Enter",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
  "PageUp",
  "PageDown",
  "Clear",
  "Help",
  "Print",
  "SysReq",
  "Attn"
]);

/**
 * `aidKeySchema` と core の `AidKey` が**双方向に**一致することをコンパイル時に確かめる。
 * どちらかにキーが増減すると、この 2 行のいずれかが型エラーになる（実行時コストはゼロ）。
 */
type SchemaAidKey = z.infer<typeof aidKeySchema>;
const _assertAidKeyParity: [SchemaAidKey extends AidKey ? true : never, AidKey extends SchemaAidKey ? true : never] =
  [true, true];
void _assertAidKeyParity;

export const cursorSchema = z
  .object({ row: z.number().int().positive(), col: z.number().int().positive() })
  .strict();

/**
 * 再生前の画面照合（spec D4）。**「打ち込む先が同じ形で在るか」だけを見る**。
 *
 * HOD の `<description>` は本文テキスト・フィールド数・OIA まで照合するが、サブファイルの
 * 行数変動で誤検知しやすく v1 には過剰。逆に無照合だと**違う画面に打ち込む**（＝パスワードを
 * 別画面に流す）事故が起きる。折り合いとして「これから書き込む欄が、記録時と同じ座標・同じ長さで
 * 入力可能に存在するか」だけを厳格に見る。
 */
export const screenMatchSchema = z
  .object({
    rows: z.number().int().positive(),
    cols: z.number().int().positive(),
    /** このステップで書き込む欄（`fields` / `secrets` / `promptFields` の合併） */
    targets: z
      .array(
        z
          .object({
            field: z.number().int().nonnegative(),
            row: z.number().int().positive(),
            col: z.number().int().positive(),
            len: z.number().int().positive()
          })
          .strict()
      )
      .max(256)
  })
  .strict();
export type ScreenMatch = z.infer<typeof screenMatchSchema>;

/** 通常のフィールド入力（値をそのまま保存する） */
export const macroFieldSchema = z
  .object({ field: z.number().int().nonnegative(), value: z.string() })
  .strict();

/**
 * 秘密を持つ欄。**平文は保存せず暗号文だけ**を持つ（`SecretCrypto` の `v1:iv:tag:ct`）。
 * 既存の自動サインオン（`signonSchema.passwordEnc`）と同じ形式・同じ鍵。
 */
export const macroSecretSchema = z
  .object({ field: z.number().int().nonnegative(), secretEnc: z.string().min(1) })
  .strict();

/** ファイル（`macros.json`）に保存する 1 ステップ */
export const macroStepRecordSchema = z
  .object({
    screen: screenMatchSchema,
    fields: z.array(macroFieldSchema).max(256),
    secrets: z.array(macroSecretSchema).max(16).optional(),
    /** 再生時にユーザー入力を待つ欄（「毎回入力する」を選んだ場合。spec D5） */
    promptFields: z.array(z.number().int().nonnegative()).max(16).optional(),
    key: aidKeySchema,
    /** SysReq のときだけ意味を持つ（`WsKey.sysReqText` と同じ扱い） */
    sysReqText: z.string().optional(),
    cursor: cursorSchema
  })
  .strict();
export type MacroStepRecord = z.infer<typeof macroStepRecordSchema>;

/** ファイルに保存するマクロ本体。**この型は API 境界を越えない** */
export const macroRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(120),
    /** 個人資産なので所有者を持つ（認証オフなら undefined）。`assertOwner` で照合する */
    owner: z.string().optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    /** 記録できない操作（拡張5250 の GUI 選択）を含む。再生前に警告する（spec D8） */
    incomplete: z.boolean().optional(),
    steps: z.array(macroStepRecordSchema).max(500)
  })
  .strict();
export type MacroRecord = z.infer<typeof macroRecordSchema>;

/** `macros.json` のファイル全体 */
export const macroFileSchema = z.object({ macros: z.array(macroRecordSchema) }).strict();

// ---- API 露出形（秘密を落とした形） ----

/**
 * API で返す 1 ステップ。**`secretEnc` を持たない**——秘密が入る欄の**位置だけ**を
 * `secretFields` で返し、クライアントはそれを見て `secretRef` を組み立てる（spec D11）。
 */
export interface PublicMacroStep {
  screen: ScreenMatch;
  fields: { field: number; value: string }[];
  /** 秘密が差し込まれる欄の fieldIndex（値は返さない） */
  secretFields?: number[];
  promptFields?: number[];
  key: AidKey;
  sysReqText?: string;
  cursor: { row: number; col: number };
}

/** API で返すマクロ。秘密の**有無**だけを `hasSecret` で示す（`PublicSystem.autoSignon` と同じ考え方） */
export interface PublicMacro {
  id: string;
  name: string;
  owner?: string;
  createdAt: number;
  updatedAt: number;
  incomplete?: boolean;
  hasSecret: boolean;
  steps: PublicMacroStep[];
}

// ---- 入力（保存要求） ----

/** 保存時の平文の秘密。**この型のフィールドはサーバー内で暗号化され、その場で捨てられる** */
export const plainSecretSchema = z
  .object({ field: z.number().int().nonnegative(), value: z.string().min(1) })
  .strict();

export const createMacroStepSchema = z
  .object({
    screen: screenMatchSchema,
    fields: z.array(macroFieldSchema).max(256),
    plainSecrets: z.array(plainSecretSchema).max(16).optional(),
    promptFields: z.array(z.number().int().nonnegative()).max(16).optional(),
    key: aidKeySchema,
    sysReqText: z.string().optional(),
    cursor: cursorSchema
  })
  .strict();

export const createMacroBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    incomplete: z.boolean().optional(),
    /** 空マクロは作らせない（spec のエッジケース「ステップ 0 件で停止」） */
    steps: z.array(createMacroStepSchema).min(1).max(500)
  })
  .strict();
export type CreateMacroBody = z.infer<typeof createMacroBodySchema>;

/** 改名（ステップの部分更新は行わない。差し替えは記録し直す） */
export const renameMacroBodySchema = z.object({ name: z.string().min(1).max(120) }).strict();

// ---- 秘密参照（ws 経路） ----

/**
 * 再生時に「値の代わりに」送る参照（spec D11）。
 * クライアントは平文も暗号文も持たないため、これを送りサーバー側で差し替えてもらう。
 */
export const macroSecretRefSchema = z
  .object({
    macroId: z.string().min(1),
    /** 0-based のステップ番号 */
    step: z.number().int().nonnegative(),
    field: z.number().int().nonnegative()
  })
  .strict();
export type MacroSecretRef = z.infer<typeof macroSecretRefSchema>;
