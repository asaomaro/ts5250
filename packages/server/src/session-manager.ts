import { randomUUID } from "node:crypto";
import { Session5250, Tn5250Error, type ConnectOptions, type AidKey } from "@as400web/core";

export interface OpenOptions extends ConnectOptions {
  /** 閲覧専用セッション（set_fields/signon/run_steps と PageUp/Down 以外の AID を拒否） */
  readOnly?: boolean;
  /** 由来（プロファイル名 or "direct"）。list_sessions 表示用 */
  origin?: string;
}

export interface SessionEntry {
  id: string;
  session: Session5250;
  readOnly: boolean;
  host: string;
  origin: string;
  connectedAt: string;
  lastActivity: number;
}

export interface SessionManagerOptions {
  maxSessions?: number;
  /** アイドルタイムアウト（ms）。無操作でこの時間を超えたら切断。既定 30 分 */
  idleTimeoutMs?: number;
  /** 現在時刻（テスト注入用） */
  now?: () => number;
}

/** ページング系 AID（readOnly セッションでも許可する閲覧操作） */
const READONLY_ALLOWED_KEYS: ReadonlySet<AidKey> = new Set<AidKey>(["PageUp", "PageDown"]);

/**
 * 複数セッションを保持・管理する（spec「セッション管理・並行性」）。
 * MCP と WebSocket が共有する。上限・アイドルタイムアウト・readOnly ゲートを担う。
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: SessionManagerOptions = {}) {
    this.maxSessions = opts.maxSessions ?? 8;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** アイドルセッションの定期掃除を開始（サーバー起動時に呼ぶ）。テストでは呼ばなくてよい */
  startIdleSweep(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), intervalMs);
    this.sweepTimer.unref?.();
  }

  get size(): number {
    return this.sessions.size;
  }

  async open(opts: OpenOptions): Promise<SessionEntry> {
    if (this.sessions.size >= this.maxSessions) {
      throw new Tn5250Error("CONNECT_FAILED", `session limit reached (${this.maxSessions})`);
    }
    const id = opts.id ?? randomUUID();
    const session = await Session5250.connect({ ...opts, id });
    const entry: SessionEntry = {
      id,
      session,
      readOnly: opts.readOnly ?? false,
      host: opts.host ?? "(injected)",
      origin: opts.origin ?? "direct",
      connectedAt: new Date(this.now()).toISOString(),
      lastActivity: this.now()
    };
    this.sessions.set(id, entry);
    session.on("closed", () => this.sessions.delete(id));
    return entry;
  }

  get(id: string): SessionEntry {
    const entry = this.sessions.get(id);
    if (!entry) throw new Tn5250Error("SESSION_NOT_FOUND", `session ${id} not found`);
    entry.lastActivity = this.now();
    return entry;
  }

  list(): SessionEntry[] {
    return [...this.sessions.values()];
  }

  /** 書き込み操作の可否を検査（readOnly なら READ_ONLY_SESSION） */
  assertWritable(id: string): SessionEntry {
    const entry = this.get(id);
    if (entry.readOnly) {
      throw new Tn5250Error("READ_ONLY_SESSION", `session ${id} is read-only`);
    }
    return entry;
  }

  /** AID キーの可否を検査（readOnly は PageUp/PageDown のみ許可） */
  assertKeyAllowed(id: string, key: AidKey): SessionEntry {
    const entry = this.get(id);
    if (entry.readOnly && !READONLY_ALLOWED_KEYS.has(key)) {
      throw new Tn5250Error("READ_ONLY_SESSION", `key ${key} not allowed on read-only session`);
    }
    return entry;
  }

  async close(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) throw new Tn5250Error("SESSION_NOT_FOUND", `session ${id} not found`);
    entry.session.disconnect();
    this.sessions.delete(id);
  }

  closeAll(): void {
    for (const entry of this.sessions.values()) entry.session.disconnect();
    this.sessions.clear();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private sweepIdle(): void {
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const [id, entry] of this.sessions) {
      if (entry.lastActivity < cutoff) {
        entry.session.disconnect();
        this.sessions.delete(id);
      }
    }
  }
}
