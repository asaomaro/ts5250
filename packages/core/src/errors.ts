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
  | "FIELD_PROTECTED"
  | "FIELD_OVERFLOW"
  | "FIELD_TYPE"
  | "FIELD_NOT_FOUND"
  | "KEYBOARD_LOCKED"
  | "READ_ONLY_SESSION"
  | "JOB_INFO_BUSY"
  | "JOB_INFO_UNAVAILABLE"
  | "PROTOCOL_ERROR";

export class Tn5250Error extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "Tn5250Error";
  }
}
