import { Session5250, Tn5250Error, type SendAidResult } from "@as400web/core";

export interface FieldSignonOptions {
  /** ユーザー欄の明示指定（省略時は最初の非 hidden 入力フィールド） */
  userField?: { row: number; col: number };
  /** パスワード欄の明示指定（省略時は最初の hidden 入力フィールド） */
  passField?: { row: number; col: number };
  timeoutMs?: number;
}

/**
 * 画面フィールド検出ベースのサインオン（decisions.md D3 のフォールバック経路）。
 * 接続済みセッションの現在画面で、最初の非 hidden 入力欄=ユーザー、最初の hidden 入力欄=パスワードとして
 * 入力し Enter を送る。認証情報は引数で受け取りサーバー内に留める（D13: MCP 境界を越えさせない）。
 *
 * 注意: PUB400（IBM i 7.5）はこの方式を受け付けない。auto-signon（open_session {profile}）を推奨（D3）。
 */
export async function fieldSignon(
  session: Session5250,
  user: string,
  password: string,
  opts: FieldSignonOptions = {}
): Promise<SendAidResult> {
  const snap = session.snapshot();
  const inputs = snap.fields.filter((f) => !f.protected);

  const userTarget = opts.userField ?? pick(inputs.find((f) => !f.hidden));
  const passTarget = opts.passField ?? pick(inputs.find((f) => f.hidden));
  if (!userTarget || !passTarget) {
    throw new Tn5250Error("FIELD_NOT_FOUND", "signon fields (user/password) not detected on current screen");
  }

  session.setField(userTarget, user);
  session.setField(passTarget, password);
  return session.sendAid("Enter", opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {});
}

function pick(f: { row: number; col: number } | undefined): { row: number; col: number } | undefined {
  return f ? { row: f.row, col: f.col } : undefined;
}
