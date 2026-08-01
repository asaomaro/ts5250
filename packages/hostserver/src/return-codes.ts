/**
 * ホストサーバーの戻りコードの分類。
 *
 * 「認証に失敗した」だけでは切り分けができないので、原因を区別できる形にする。
 * 上位 16 ビットがカテゴリを表すレンジもあるため、個別コード → レンジの順で判定する。
 *
 * 参照: JTOpen(jtopenlite) の HostServerConnection.getReturnCodeMessage に対応する
 *       （コードの移植ではなく、戻りコードの意味に基づく実装）。
 */

/** 成功 */
export const RC_OK = 0;

/**
 * 原因の分類。呼び出し側が文言ではなくこの値で分岐できるようにする。
 *
 * - `retryable`: 資格情報を直せば通る見込み
 * - `blocked`: プロファイル側の状態が原因で、資格情報を直しても通らない
 */
export type SignonFailureKind =
  | "user-unknown"
  | "user-revoked"
  | "password-incorrect"
  | "password-last-attempt"
  | "password-expired"
  | "password-none"
  | "request-error"
  | "security-error"
  | "token-error"
  | "unknown";

export interface SignonFailure {
  rc: number;
  kind: SignonFailureKind;
  message: string;
  /** 資格情報を直せば通る見込みがあるか */
  retryable: boolean;
}

const BY_CODE = new Map<number, { kind: SignonFailureKind; message: string; retryable: boolean }>([
  // 実機(IBM i 7.5)では存在しないユーザー ID でも 0x0003000B(パスワード誤り) が返り、
  // このコードは観測されなかった。ユーザーの存在有無を漏らさないための挙動と思われる。
  // 他バージョン・他構成では返りうるため分類自体は残す。
  [0x00020001, { kind: "user-unknown", message: "ユーザー ID が不明です", retryable: true }],
  [
    0x00020002,
    { kind: "user-revoked", message: "ユーザー ID は有効ですが無効化されています", retryable: false }
  ],
  [
    0x00020003,
    {
      kind: "token-error",
      message: "ユーザー ID が認証トークンと一致しません",
      retryable: false
    }
  ],
  [0x0003000b, { kind: "password-incorrect", message: "パスワードが誤っています", retryable: true }],
  [
    // 注意: 0x0C は「次に誤ると無効化」、0x0D は「期限切れ」。取り違えやすい
    0x0003000c,
    {
      kind: "password-last-attempt",
      message: "パスワードが誤っています（次に誤るとプロファイルが無効化されます）",
      retryable: true
    }
  ],
  [
    0x0003000d,
    {
      kind: "password-expired",
      message: "パスワードは正しいですが期限切れです",
      retryable: false
    }
  ],
  [
    0x0003000e,
    {
      kind: "password-incorrect",
      message: "V2R2 より前の形式で暗号化されたパスワードです",
      retryable: false
    }
  ],
  [
    0x00030010,
    { kind: "password-none", message: "パスワードが *NONE に設定されています", retryable: false }
  ]
]);

/** 上位 16 ビットで表されるカテゴリ */
const BY_RANGE: ReadonlyArray<{
  prefix: number;
  kind: SignonFailureKind;
  message: string;
}> = [
  { prefix: 0x0001, kind: "request-error", message: "要求データのエラーです" },
  { prefix: 0x0004, kind: "security-error", message: "一般的なセキュリティエラーです" },
  { prefix: 0x0006, kind: "token-error", message: "認証トークンのエラーです" }
];

/**
 * 戻りコードを分類する。成功（0）の場合は undefined を返す。
 * 個別コードを優先し、該当がなければ上位 16 ビットのレンジで判定する。
 */
export function classifySignonReturnCode(rc: number): SignonFailure | undefined {
  if (rc === RC_OK) return undefined;

  const exact = BY_CODE.get(rc);
  if (exact) return { rc, ...exact };

  const prefix = (rc >>> 16) & 0xffff;
  const range = BY_RANGE.find((r) => r.prefix === prefix);
  if (range) {
    return { rc, kind: range.kind, message: range.message, retryable: false };
  }

  return {
    rc,
    kind: "unknown",
    message: `不明な戻りコードです (0x${rc.toString(16).padStart(8, "0")})`,
    retryable: false
  };
}

/** 表示・ログ用の要約（戻りコードを 16 進で併記する） */
export function describeSignonFailure(f: SignonFailure): string {
  return `${f.message} (rc=0x${f.rc.toString(16).padStart(8, "0")})`;
}
