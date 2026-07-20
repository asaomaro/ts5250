/** 共通エラーコード（spec「エラー処理 / 異常系」。server が MCP/WS 形式へ変換する） */
export type ErrorCode =
  | "CONNECT_FAILED"
  | "NEGOTIATION_TIMEOUT"
  | "TLS_CERT_INVALID"
  | "SESSION_CLOSED"
  | "SESSION_NOT_FOUND"
  | "SESSION_REJECTED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "CONFIG_ERROR"
  | "FIELD_PROTECTED"
  | "FIELD_OVERFLOW"
  | "FIELD_TYPE"
  | "FIELD_NOT_FOUND"
  | "KEYBOARD_LOCKED"
  | "READ_ONLY_SESSION"
  | "JOB_INFO_BUSY"
  | "JOB_INFO_UNAVAILABLE"
  | "PROTOCOL_ERROR"
  /** ホストサーバーが要求する機能が未実装（例: DES ベースのパスワードレベル） */
  | "HOST_SERVER_UNSUPPORTED"
  /**
   * **利用者が指定したデータ**（表の列型・CCSID など）が対応範囲外。
   *
   * `HOST_SERVER_UNSUPPORTED` と分けている理由: あちらは「ホストが要求する機能を
   * こちらが実装していない」（利用者には直せない）。こちらは**対象を変えれば直る**。
   * 同じコードにすると、直せない問題を直せるかのように案内してしまう。
   */
  | "UNSUPPORTED_TYPE"
  /** SQL の実行エラー（構文誤り・存在しない表・権限不足など） */
  | "SQL_ERROR"
  /** CL コマンドの実行失敗（メッセージ付き） */
  | "COMMAND_FAILED";

/**
 * このライブラリが投げる共通エラー。
 *
 * 名前が `As400Error` なのは、**TN5250 だけを扱う層ではなくなったため**。
 * ホストサーバー（SQL・コマンド・スプール・IFS）は 5250 の端末プロトコルとは別物で、
 * それらが `Tn5250Error` を投げるのは名が体を表していなかった。
 */
export class As400Error extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "As400Error";
  }
}

/**
 * 旧名の互換シム。**外部利用者のコードを壊さないためだけに残している**——
 * 同一クラスなので `instanceof` は新旧どちらでも通る。
 * このリポジトリ内の新しいコードでは `As400Error` を使うこと（新旧の混在を意図していない）。
 */
export { As400Error as Tn5250Error };

/**
 * OS のソケットエラーコードを、原因の見当がつく日本語にする。
 *
 * `EHOSTUNREACH` のような文字列だけでは、利用者は「自分の設定が悪いのか、
 * 相手が落ちているのか」を判断できない。**次に何を確かめればよいか**まで書く。
 *
 * 未知のコードは undefined を返す（元のメッセージだけを見せる。嘘の説明を足さない）。
 */
export function describeSocketError(code: string | undefined): string | undefined {
  switch (code) {
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "接続先へ到達できません。ホストが停止しているか、経路が遮断されています";
    case "ETIMEDOUT":
      return "応答がありません。ホスト名・ポート番号と、ファイアウォールの許可を確認してください";
    case "ECONNREFUSED":
      return "接続を拒否されました。そのポートでサーバーが動いていない可能性があります";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "ホスト名を解決できません。名前の綴りと DNS の設定を確認してください";
    case "ECONNRESET":
      return "接続が切断されました。TLS の要否（平文ポートに TLS で繋いでいないか）を確認してください";
    case "EPIPE":
      return "接続が閉じられました";
    default:
      return undefined;
  }
}

/** ソケットエラーに説明を添える。未知のコードなら元の文言のまま */
export function withSocketHint(message: string, code: string | undefined): string {
  const hint = describeSocketError(code);
  return hint ? `${message} — ${hint}` : message;
}
