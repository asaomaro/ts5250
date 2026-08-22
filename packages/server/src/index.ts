// @ts5250/server 公開 API
export { SessionManager, type OpenOptions, type SessionEntry } from "./session-manager.js";
export {
  ConfigStore,
  ServerConfigStore,
  PersonalConfigStore,
  type StoreData
} from "./config-store.js";
export { ConfigResolver, type ResolvedTarget, type TargetRef } from "./config-resolver.js";
// 待ち受けの状態はプリンターと監視で共通の語彙。**画面もこれをそのまま描く**
export { type ServiceState, holdsConnection, autoStartOf } from "./service-state.js";
// サービス一覧の行（画面が描くので型を共有する。中身は「持っているか」のフラグまで）
export {
  registerHostPrinterRoutes,
  type HostServicesDeps,
  type PrinterRow,
  type WatchRow
} from "./host-printers.js";
export {
  makeRef,
  parseRef,
  type System,
  type ServerSession,
  type PersonalSession,
  type AnySession,
  type PublicSystem,
  type PublicSession,
  type ServiceDef,
  type PrinterConfig,
  type Watermark,
  type IdleTimeout,
  type SessionType,
  type DtaqWatchSpec,
  type MsgWatchSpec,
  type WatchSpec,
  msgWatchSchema,
  sessionWatch,
  sessionMsgWatch,
  type WebhookConfig,
  type PublicWebhook,
  type ConfigSource
} from "./config-types.js";
export {
  migrateProfiles,
  migrateConnections,
  type LegacyProfile,
  type LegacyConnection
} from "./config-migrate.js";
export { MacroStore, toPublic as macroToPublic } from "./macro-store.js";
export { registerMacroRoutes, type MacroRouteDeps } from "./macro-routes.js";
export type {
  ScreenMatch,
  MacroRecord,
  MacroStepRecord,
  PublicMacro,
  PublicMacroStep,
  MacroSecretRef,
  CreateMacroBody
} from "./macro-types.js";
export { screenToText, screenToAnsi, attributeRuns, type FormatOptions, type AttrRun } from "./format.js";
export { fieldSignon } from "./signon.js";
export { audit, withAudit, setAuditSink, type AuditEvent } from "./audit.js";
// 認証の実体。**組み込み用途と検証スクリプトが認証ありのサーバーを組める**ように公開する
// （認可が効いているかは、認証を有効にしないと一度も測れない）
export {
  UserStore,
  SessionStore,
  type AuthContext,
  type AuthUser,
  type AuthVars,
  type Role,
  type PublicUser
} from "./auth.js";
export { registerTools, type ToolDeps } from "./mcp-tools.js";
export { buildMcpServer } from "./mcp-server.js";
export { buildApp, type AppDeps } from "./app.js";
export { registerSessionRoutes, type SessionRouteDeps } from "./session-routes.js";
export { registerHostProgramRoutes, type HostProgramDeps } from "./host-program.js";
export {
  registerHostMessageRoutes,
  buildListSql,
  buildSendCommand,
  buildReplyCommand,
  type HostMessageDeps
} from "./host-message.js";
// ホストサーバーへの接続（**ポートの解決を含む**。手で組むと telnet の 23 を掴む）
export { openCommand, openDb, openIfs } from "./host-connect.js";
export { WsConnection, type WsHandlerDeps, type WsSender } from "./ws-handler.js";
export {
  WatchRegistry,
  type WatchView,
  type WatchEntryView,
  type WatchEvent,
  type WatchState,
  type WatchSink,
  type WatchRegistryOptions
} from "./watch-registry.js";
// 待ち受けの「待ち方」（種類ごとに違うのはここだけ）
export {
  dtaqSource,
  type WatchKind,
  type WatchItem,
  type WatchLink,
  type WatchSource,
  type WatchMessageInfo
} from "./watch-source.js";
export { msgqSource } from "./host-msgwatch.js";
// 定義の変更を動いているサービスへ反映する
// 待ち行列サービスの転送（**監視は消費するので、失敗はデータの喪失**）
export {
  WebhookSink,
  makeWatchSink,
  invalidWebhookUrl,
  type WebhookStats,
  type UndeliveredEntry
} from "./webhook-sink.js";
export {
  reconcileService,
  type ServiceReconcileDeps,
  type SessionChange,
  type ReconcileResult
} from "./service-reconcile.js";
export type {
  WsClientMessage,
  WsServerMessage,
  WsOpen,
  WsKey,
  WsKeyField,
  WsFieldRef,
  WsCloseReq,
  WsOpened,
  WsScreen,
  WsJobInfoRes,
  WsError,
  WsClosed,
  WsKeyDone,
  SpoolReportMsg,
  // VT（文字モード端末）。web-ui が画面を組み立てるのに要る
  WsVtOpened,
  WsVtFrameMessage,
  WsVtTitle,
  WsVtInput,
  WsVtResize,
  WsVtFrame,
  WsVtLine,
  WsVtRun,
  WsVtStyle
} from "./ws-messages.js";
export { main } from "./main.js";

// CSV 取り込み（DDM）。実機チェックスクリプトが HTTP を介さず同じ経路を叩けるように公開する
export {
  uploadRows,
  uploadCsv,
  registerHostUploadRoutes,
  type UploadArgs,
  type UploadOutcome
} from "./host-upload.js";
