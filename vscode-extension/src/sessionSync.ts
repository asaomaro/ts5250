import { syncConfigRecord, syncSystem, type SystemSyncInput, type SystemSyncOptions } from "./systemSync.js";
import type { EmbedConnectionOptions } from "./protocol.js";
import { createHash } from "node:crypto";

/** 直接接続の WS 入力では扱わない詳細設定・信頼設定を持つ端末／プリンター。 */
export interface SessionSyncInput extends SystemSyncInput, EmbedConnectionOptions {
  app?: "emulator" | "printer";
  terminal?: "5250" | "3270";
  deviceName?: string;
  screenSize?: "24x80" | "27x132";
  katakanaVariant?: "katakana" | "katakana-ex";
}

export interface SessionSyncOptions extends SystemSyncOptions {
  /** 個人設定のシステム参照とは分け、保存先の異なる参照を再利用しない */
  systemMappingFilePath: string;
}

/** 拡張ホストがファイルから読んだ設定を、既存のサーバー設定 API・認可・検証を通して同期する。 */
export async function syncSession(input: SessionSyncInput, opts: SessionSyncOptions): Promise<string> {
  // srv: の ID は名前から作られる。同名ファイルを別フォルダー・別ウィンドウで開いても、
  // 設定と資格情報が衝突しないよう URI で識別する（画面の名前はファイル名のまま）。
  const name = `${input.name}-${createHash("sha256").update(input.documentUri).digest("hex").slice(0, 12)}`;
  const system = await syncSystem({ ...input, name, source: "server" }, { ...opts, mappingFilePath: opts.systemMappingFilePath });
  const printer = input.app === "printer";
  const body: Record<string, unknown> = {
    source: "server", name, system, sessionType: printer ? "printer" : "display"
  };
  if (input.deviceName !== undefined) body.deviceName = input.deviceName;
  if (input.keepAlive !== undefined) body.keepAlive = input.keepAlive;
  if (input.keepAliveOptions !== undefined) body.keepAliveOptions = input.keepAliveOptions;
  if (!printer && input.terminal !== "3270" && input.connectionHold !== undefined) body.connectionHold = input.connectionHold;
  if (input.deviceNameRetry !== undefined) body.deviceNameRetry = input.deviceNameRetry;
  if (printer) {
    if (input.printer !== undefined) body.printer = input.printer;
  } else {
    body.terminal = input.terminal ?? "5250";
    if (input.terminal !== "3270") {
      // false と空オブジェクトも反映する。以前の許可・許可パターンを残さない。
      body.pcCommand = { ...input.pcCommand, enabled: input.allowPcCommand === true };
      if (input.screenSize !== undefined) body.screenSize = input.screenSize;
      if (input.katakanaVariant !== undefined) body.katakanaVariant = input.katakanaVariant;
      if (input.enhanced !== undefined) body.enhanced = input.enhanced;
      if (input.associatedPrinter) body.associatedPrinter = input.associatedPrinter;
    }
  }
  return syncConfigRecord(input.documentUri, "sessions-config", body, opts);
}
