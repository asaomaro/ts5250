import { reactive } from "vue";
import type { PublicConnection } from "@as400web/server";

/**
 * ユーザー接続設定（サーバー保存・単一の真実）。localStorage 保存は廃止した。
 * サーバーが owner スコープ（認証オフ=全件 / オン=自分のみ）と暗号化（自動サインオンのパスワード）を担う。
 * パスワードはサーバーへ送るだけで、クライアントには hasSecret（有無）しか返らない。
 */
export type SavedConnection = PublicConnection;

/** 作成・更新でサーバーへ送る入力（password は平文で送り、サーバーが暗号化保存する） */
export interface ConnectionForm {
  name: string;
  host: string;
  port?: number;
  ccsid?: number;
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  tls?: boolean;
  sessionType: "display" | "printer";
  autoSignon?: boolean;
  signonUser?: string;
  password?: string;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export const connectionsStore = reactive({
  connections: [] as PublicConnection[],
  loaded: false,

  /** サーバーから一覧を取得（未認証・未配線時は空のまま） */
  async refresh(): Promise<void> {
    try {
      const res = await fetch("/api/connections");
      if (!res.ok) {
        this.connections = [];
        return;
      }
      const body = (await res.json()) as { connections: PublicConnection[] };
      this.connections = body.connections;
      this.loaded = true;
    } catch {
      this.connections = [];
    }
  },

  async create(form: ConnectionForm): Promise<PublicConnection> {
    const res = await fetch("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form)
    });
    if (!res.ok) throw new Error(await readError(res));
    const body = (await res.json()) as { connection: PublicConnection };
    await this.refresh();
    return body.connection;
  },

  async update(id: string, form: ConnectionForm): Promise<PublicConnection> {
    const res = await fetch(`/api/connections/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form)
    });
    if (!res.ok) throw new Error(await readError(res));
    const body = (await res.json()) as { connection: PublicConnection };
    await this.refresh();
    return body.connection;
  },

  async remove(id: string): Promise<void> {
    const res = await fetch(`/api/connections/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await readError(res));
    await this.refresh();
  }
});
