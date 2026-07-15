import { reactive } from "vue";

/**
 * ブラウザ保存の接続設定（localStorage）。
 * autoSignon 有効時は RFC 4777 自動サインオンのため user/password を保持する
 * （ローカルツール用途。この端末の localStorage に平文保存される点に留意）。
 */
export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port?: number;
  ccsid?: number;
  deviceName?: string;
  tls?: boolean;
  /** 自動サインオン（RFC 4777）。有効時は user/password を使う */
  autoSignon?: boolean;
  user?: string;
  password?: string;
  lastConnectedAt?: number;
}

const KEY = "as400.connections";

function load(): SavedConnection[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as SavedConnection[]) : [];
  } catch {
    return [];
  }
}

function persist(list: SavedConnection[]): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(list));
}

let seq = 0;
const genId = (): string => `c${Date.now().toString(36)}-${++seq}`;

export const settingsStore = reactive({
  connections: load() as SavedConnection[],

  save(conn: Omit<SavedConnection, "id"> & { id?: string }): SavedConnection {
    if (conn.id) {
      const i = this.connections.findIndex((c) => c.id === conn.id);
      if (i >= 0) {
        this.connections[i] = { ...this.connections[i], ...conn, id: conn.id };
        persist(this.connections);
        return this.connections[i]!;
      }
    }
    const created: SavedConnection = { ...conn, id: genId() };
    this.connections.push(created);
    persist(this.connections);
    return created;
  },

  remove(id: string): void {
    const i = this.connections.findIndex((c) => c.id === id);
    if (i >= 0) {
      this.connections.splice(i, 1);
      persist(this.connections);
    }
  },

  markConnected(id: string, now: number): void {
    const c = this.connections.find((x) => x.id === id);
    if (c) {
      c.lastConnectedAt = now;
      persist(this.connections);
    }
  }
});
