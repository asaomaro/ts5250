// @as400web/server 公開 API
export { SessionManager, type OpenOptions, type SessionEntry } from "./session-manager.js";
export {
  ConfigStore,
  ServerConfigStore,
  PersonalConfigStore,
  type StoreData
} from "./config-store.js";
export { ConfigResolver, type ResolvedTarget, type TargetRef } from "./config-resolver.js";
export {
  makeRef,
  parseRef,
  type System,
  type ServerSession,
  type PersonalSession,
  type AnySession,
  type PublicSystem,
  type PublicSession,
  type PrinterConfig,
  type Watermark,
  type IdleTimeout,
  type SessionType,
  type DtaqWatchSpec,
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
export { registerTools, type ToolDeps } from "./mcp-tools.js";
export { buildMcpServer } from "./mcp-server.js";
export { buildApp, type AppDeps } from "./app.js";
export { WsConnection, type WsHandlerDeps, type WsSender } from "./ws-handler.js";
export {
  WatchRegistry,
  type WatchView,
  type WatchEntryView,
  type WatchEvent,
  type WatchState,
  type WatchRegistryOptions
} from "./watch-registry.js";
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
  WsKeyDone
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
