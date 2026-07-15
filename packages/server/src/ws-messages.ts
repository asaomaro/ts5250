import type { ScreenSnapshot, JobInfo } from "@as400web/core";

/** WebSocket メッセージ型（server が定義し web-ui が type-only import で共有。spec「Web 向けプロトコル」） */

// ---- client → server ----
export interface WsOpen {
  type: "open";
  profile?: string;
  host?: string;
  port?: number;
  ccsid?: number;
  deviceName?: string;
  enhanced?: boolean;
  tls?: boolean;
  /** RFC 4777 自動サインオン（host 直指定時。profile 指定時は profile 側の signon を使う） */
  user?: string;
  password?: string;
  readOnly?: boolean;
}
export interface WsKey {
  type: "key";
  key: string;
  cursor?: { row: number; col: number };
  fields?: { field: number | { row: number; col: number }; value: string }[];
}
export interface WsJobInfoReq {
  type: "jobinfo";
  refresh?: boolean;
}
export interface WsCloseReq {
  type: "close";
}
/** GUI 選択フィールドの選択状態変更（ローカル・ホスト送信なし） */
export interface WsGuiSelect {
  type: "gui-select";
  fieldId: number;
  choiceIndex: number;
  selected?: boolean;
}
/** GUI 選択フィールドの確定送信（AID/Enter を Read 応答として送る） */
export interface WsGuiSubmit {
  type: "gui-submit";
  fieldId: number;
  key?: string;
  cursor?: { row: number; col: number };
}
export type WsClientMessage =
  | WsOpen
  | WsKey
  | WsJobInfoReq
  | WsCloseReq
  | WsGuiSelect
  | WsGuiSubmit;

// ---- server → client ----
export interface WsOpened {
  type: "opened";
  sessionId: string;
  screen: ScreenSnapshot;
}
export interface WsScreen {
  type: "screen";
  screen: ScreenSnapshot;
}
export interface WsJobInfoRes {
  type: "jobinfo";
  job: JobInfo;
  cached: boolean;
}
export interface WsError {
  type: "error";
  code: string;
  message: string;
  fatal: boolean;
}
export interface WsClosed {
  type: "closed";
  reason: string;
}
export type WsServerMessage = WsOpened | WsScreen | WsJobInfoRes | WsError | WsClosed;
