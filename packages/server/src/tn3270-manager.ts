import { randomUUID } from "node:crypto";
import { As400Error } from "@ts5250/base";
import { Tn3270Session } from "@ts5250/tn3270";
import type { ScreenSnapshot } from "@ts5250/tn5250";
import { childLog } from "./log.js";
import { toWireScreen, type Model3270Web } from "./tn3270-adapt.js";

const log = childLog({ component: "tn3270-manager" });

/**
 * **3270 セッションの保持。**
 *
 * `SessionManager`（5250）とは**別に持つ**（spec D5）。あちらの `SessionEntry.session` は
 * `Session5250` 型で、`server` 全体と `ws-handler` がその前提で書かれている。
 * そこへ 3270 を差し込むと影響が全域に及ぶので、**プリンターセッションと同じ形**——
 * 別マネージャを立てて `ws-handler` が入口で振り分ける——に倣う。
 *
 * ここが持たないもの（5250 側にはあるが 3270 では対象外。spec 6）:
 * 予約・watch・PC コマンド・ジョブ情報・永続化。
 */

export interface Tn3270Entry {
  id: string;
  session: Tn3270Session;
  host: string;
  readOnly: boolean;
  owner?: string;
  connectedAt: string;
  /** 画面が変わったときに呼ぶ購読者（ブラウザ 1 枚につき 1 つ） */
  subscribers: Set<(screen: ScreenSnapshot) => void>;
}

export interface Open3270Options {
  host: string;
  port?: number;
  model?: Model3270Web;
  ccsid?: number;
  /** `true` か、証明書の扱いまで指定した形（5250 側の解決結果をそのまま渡せる） */
  tls?: boolean | { rejectUnauthorized?: boolean; ca?: string | string[] };
  readOnly?: boolean;
  owner?: string;
  connectTimeoutMs?: number;
}

export class Tn3270Manager {
  private readonly entries = new Map<string, Tn3270Entry>();

  async open(opts: Open3270Options): Promise<Tn3270Entry> {
    const model = opts.model ?? 2;
    if (model !== 2 && model !== 5) {
      // spec D3——3/4 は 32/43 行で web-ui の型（rows: 24 | 27）に収まらない
      throw new As400Error("CONFIG_ERROR", `3270 model ${String(model)} is not supported on the web UI`);
    }
    const session = new Tn3270Session({
      host: opts.host,
      port: opts.port ?? 23,
      model,
      ccsid: opts.ccsid ?? 37,
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {})
    });
    const entry: Tn3270Entry = {
      id: randomUUID(),
      session,
      host: opts.host,
      readOnly: opts.readOnly ?? false,
      ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
      connectedAt: new Date().toISOString(),
      subscribers: new Set()
    };
    // **購読は接続前に張る**——最初の画面を取りこぼさないため
    session.on("screen", () => {
      const wire = toWireScreen(session, entry.id);
      for (const fn of entry.subscribers) fn(wire);
    });
    await session.connect();
    this.entries.set(entry.id, entry);
    log.info(`3270 session opened ${entry.id} (${opts.host}:${opts.port ?? 23} model ${model})`);
    return entry;
  }

  /** 所有者検査つきの取得。他人のセッションは見せない */
  get(id: string, owner?: string): Tn3270Entry {
    const e = this.entries.get(id);
    if (e === undefined) throw new As400Error("SESSION_NOT_FOUND", `session ${id} not found`);
    if (e.owner !== undefined && owner !== undefined && e.owner !== owner) {
      throw new As400Error("FORBIDDEN", `session ${id} belongs to another user`);
    }
    return e;
  }

  close(id: string): void {
    const e = this.entries.get(id);
    if (e === undefined) return;
    e.session.close();
    e.subscribers.clear();
    this.entries.delete(id);
    log.info(`3270 session closed ${id}`);
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
  }

  get size(): number {
    return this.entries.size;
  }
}
