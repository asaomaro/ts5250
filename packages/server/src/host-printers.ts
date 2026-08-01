/**
 * 常駐プリンターの一覧。
 *
 * **なぜ要るか（design D2）**: 自動出力（PDF 保存・印刷）の失敗は
 * `PrinterEntry.outputWarnings` に溜まるが、**ブラウザが居ないと誰も見ない**。
 * 常駐にすると「ブラウザが居ない時間」が普通になるので、
 * **開かずに確かめる手段**がここで要る。
 *
 * 新しい通知基盤は作らない——サーバーのログ（`warn`）は既に出ており、
 * 足りないのは「見える場所に出すこと」だけ。
 *
 * 認可は他のホスト API と揃える（`listPrinters(user)` が所有で絞る）。
 * **他人の常駐は見せない**——出力設定はサーバー上のパス書き込みに直結する情報で、
 * 警告文にはパスが載りうる。
 */
import type { Hono } from "hono";
import type { AuthVars } from "./auth.js";
import type { SessionManager } from "./session-manager.js";

export interface HostPrintersDeps {
  sessions: SessionManager;
}

/** 一覧に出す 1 台 */
export interface PrinterListItem {
  id: string;
  host: string;
  origin: string;
  connectedAt: string;
  /** 常駐（WS が切れても続く）か */
  resident: boolean;
  /** 自動出力が有効か（実行時トグル） */
  outputEnabled: boolean;
  /** 自動出力の設定を持つか。**中身（パス・プリンター名）は出さない** */
  hasOutput: boolean;
  /** 受信済みの帳票数 */
  reports: number;
  /** そのうち画面へ渡した数。差が「まだ読まれていない帳票」 */
  delivered: number;
  /** 直近の出力警告（新しい順）。**これを見せるのが一覧の主目的** */
  warnings: { at: number; message: string }[];
  owner?: string;
}

export function registerHostPrinterRoutes(
  app: Hono<{ Variables: AuthVars }>,
  deps: HostPrintersDeps
): void {
  app.get("/api/printers", (c) => {
    const list: PrinterListItem[] = deps.sessions.listPrinters(c.get("user")).map((e) => ({
      id: e.id,
      host: e.host,
      origin: e.origin,
      connectedAt: e.connectedAt,
      resident: e.resident,
      outputEnabled: e.outputEnabled,
      hasOutput: e.output !== undefined,
      reports: e.reports.length,
      delivered: e.delivered,
      // **新しい順**。溜まった古い失敗より、いま起きていることを先に見せる
      warnings: [...e.outputWarnings].reverse(),
      ...(e.owner !== undefined ? { owner: e.owner } : {})
    }));
    return c.json({ printers: list });
  });
}
