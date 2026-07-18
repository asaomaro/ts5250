import { reactive } from "vue";

export interface AuthUser {
  username: string;
  role: "admin" | "user";
}

/** 認証状態。enabled=false（ローカル無認証）なら常に許可扱い。 */
export const authStore = reactive({
  loaded: false,
  enabled: false,
  user: undefined as AuthUser | undefined,
  /** API トークンを発行済みか（値は保持しない。UI の状態表示用） */
  hasToken: false,

  /** サーバーに認証要否と現在ユーザーを問い合わせる */
  async refresh(): Promise<void> {
    try {
      const res = await fetch("/api/me");
      const body = (await res.json()) as { enabled: boolean; user?: AuthUser | null; hasToken?: boolean };
      this.enabled = body.enabled;
      this.user = body.user ?? undefined;
      this.hasToken = body.hasToken ?? false;
    } catch {
      this.enabled = false;
      this.user = undefined;
    }
    this.loaded = true;
  },

  /** ログイン。成功で user を設定し true を返す */
  async login(username: string, password: string): Promise<boolean> {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { user: AuthUser };
    this.user = body.user;
    return true;
  },

  async logout(): Promise<void> {
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    this.user = undefined;
  },

  /** ログイン画面を出すべきか（認証有効かつ未ログイン） */
  get needsLogin(): boolean {
    return this.enabled && !this.user;
  },

  get isAdmin(): boolean {
    return this.user?.role === "admin";
  }
});
