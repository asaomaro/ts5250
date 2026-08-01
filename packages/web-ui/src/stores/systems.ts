import { reactive } from "vue";
import type { PublicSystem, PublicSession, Watermark, IdleTimeout, SessionType, DtaqWatchSpec } from "@as400web/server";

/**
 * システムとセッション設定（サーバー保存・単一の真実）。
 *
 * **システムが親、セッション設定が子。** 接続先と資格情報はシステムだけが持ち、
 * セッション設定は装置名・画面サイズなど「どう使うか」だけを持つ。
 * パスワードはサーバーへ送るだけで、返ってくるのは `autoSignon`（有無）と
 * `signonUser`（プレフィル用のユーザー名）まで。
 *
 * **選択中システムがこの UI の軸**——タブに並ぶもの、ランチャーに出るもの、
 * 一覧機能の実行対象は、すべてここで決まる。
 */

/** 作成・更新でサーバーへ送るシステムの入力（password は平文で送り、サーバーが暗号化する） */
export interface SystemForm {
  /** 保管場所。サーバー設定は admin のみ。省略時は個人設定 */
  source?: "server" | "personal";
  name: string;
  host: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  /** スプール（SCS）用 CCSID。5250 画面用の ccsid とは別物（spec 方針2） */
  spoolCcsid?: number;
  autoSignon?: boolean;
  signonUser?: string;
  /**
   * 平文パスワード。**空文字や未指定で送ると既存が保たれる**
   * （一覧はパスワードを返さないので、編集フォームは空で送られてくる）。
   */
  password?: string;
}

/** セッション設定の入力。`system` は親システムの参照（`srv:` / `own:`） */
export interface SessionConfigForm {
  source?: "server" | "personal";
  name: string;
  system: string;
  sessionType: SessionType;
  deviceName?: string;
  screenSize?: "24x80" | "27x132";
  ccsid?: number;
  enhanced?: boolean;
  /**
   * display のみ。画面に重ねる透かし（表示だけの設定。ホストへは送らない）。
   * **省略して送ると消える**——更新はオブジェクトごと置き換えるため、
   * フォームは編集しない場合でも読み込んだ値を送り返す。
   */
  watermark?: Watermark;
  /**
   * printer のみ。書き出しできないスプールを取得したあとの扱い。
   * `hold`（既定）＝保留にして残す / `delete`＝削除する
   */
  rescueAction?: "hold" | "delete";
  /**
   * printer のみ。ホスト変換の機種（HPT。"*HP4" 等）。
   * 指定すると本来の印刷経路になる代わりに、画面表示と PDF が使えない。
   */
  transformTo?: string;
  /**
   * 無操作で切るまでの時間。`"never"`＝切らない / 数値＝分（1〜1440）。
   * **省略はサーバー既定に従う**（既定は切らない）。`0` は受け付けない
   */
  idleTimeout?: IdleTimeout;
  /**
   * `dtaqwatch` のみ。常駐監視するデータ待ち行列。
   * **種別との整合はサーバーが parse で強制する**（片方だけ送ると 400）。
   */
  dtaqWatch?: DtaqWatchSpec;
  /**
   * サーバー設定の表示セッションのみ。個人設定に送るとサーバーが 400 を返す（信頼境界）。
   * ホストの `STRPCCMD` が届いたときにサーバー機でコマンドを実行する設定
   */
  pcCommand?: {
    enabled?: boolean;
    timeoutMs?: number;
    cwd?: string;
    allow?: string[];
  };
  /**
   * 開いた直後／サーバー起動直後に**待ち受けを開始するか**（既定 true）。
   * `printer` と `dtaqwatch` にだけ意味がある（`display` は画面なので常に開く）。
   * **信頼設定ではない**ので個人設定にも置ける。
   */
  autoStart?: boolean;
  /**
   * サーバー設定の待ち行列監視のみ。**信頼設定**（サーバーから外へ出ていくデータ経路）。
   * `secret` は**平文で送る**——サーバーが暗号化して保存する。
   * **空で送れば既存を保つ**（`SystemForm.password` と同じ約束）。
   */
  webhook?: {
    url: string;
    secret?: string;
    secretEnv?: string;
    secretHeader?: string;
    timeoutMs?: number;
    maxAttempts?: number;
  };
  /** サーバー設定のプリンターセッションのみ。個人設定に送るとサーバーが 400 を返す（信頼境界） */
  printer?: {
    /**
     * **サービスとして常駐するか。** 意図であって能力ではない——
     * 出力設定の有無から導出しない（「開いている間だけ PDF に落とす」と
     * 「常駐して溜めるだけ」は別物）。
     */
    service?: boolean;
    autoPdfDir?: string;
    autoPrint?: string;
    pdfFontPath?: string;
    pdfFontName?: string;
    pageSize?: string;
    fontSize?: number;
  };
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function send(url: string, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export const systemsStore = reactive({
  systems: [] as PublicSystem[],
  sessions: [] as PublicSession[],
  /** 選択中システムの ref。未選択なら undefined */
  selected: undefined as string | undefined,
  /** サーバー設定を編集できるか（認証オフ or admin かつ永続化可） */
  editable: false,
  loaded: false,

  /** 選択中システムの実体 */
  get current(): PublicSystem | undefined {
    return this.systems.find((s) => s.ref === this.selected);
  },

  /** 選択中システムに属するセッション設定 */
  get currentSessions(): PublicSession[] {
    return this.selected ? this.sessions.filter((s) => s.system === this.selected) : [];
  },

  /** 指定システムに属するセッション設定の数（カードの表示用） */
  sessionCount(ref: string): number {
    return this.sessions.filter((s) => s.system === ref).length;
  },

  select(ref: string | undefined): void {
    this.selected = ref;
  },

  async refresh(): Promise<void> {
    try {
      const [sysRes, sesRes] = await Promise.all([
        fetch("/api/systems"),
        fetch("/api/sessions-config")
      ]);
      if (!sysRes.ok || !sesRes.ok) {
        this.systems = [];
        this.sessions = [];
        return;
      }
      const sysBody = (await sysRes.json()) as { systems: PublicSystem[]; editable: boolean };
      const sesBody = (await sesRes.json()) as { sessions: PublicSession[] };
      this.systems = sysBody.systems;
      this.sessions = sesBody.sessions;
      this.editable = sysBody.editable;
      this.loaded = true;
      // 選択が消えていたら外す（削除・権限変更のあと）
      if (this.selected && !this.systems.some((s) => s.ref === this.selected)) {
        this.selected = undefined;
      }
      // 1 つしか無いなら選ぶ手間を省く
      if (!this.selected && this.systems.length === 1) this.selected = this.systems[0]!.ref;
    } catch {
      this.systems = [];
      this.sessions = [];
    }
  },

  async createSystem(form: SystemForm): Promise<PublicSystem> {
    const body = (await send("/api/systems", "POST", form)) as { system: PublicSystem };
    await this.refresh();
    return body.system;
  },

  async updateSystem(ref: string, form: SystemForm): Promise<PublicSystem> {
    const body = (await send(`/api/systems/${encodeURIComponent(ref)}`, "PUT", form)) as {
      system: PublicSystem;
    };
    await this.refresh();
    return body.system;
  },

  async removeSystem(ref: string): Promise<void> {
    const res = await fetch(`/api/systems/${encodeURIComponent(ref)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await readError(res));
    if (this.selected === ref) this.selected = undefined;
    await this.refresh();
  },

  async createSession(form: SessionConfigForm): Promise<PublicSession> {
    const body = (await send("/api/sessions-config", "POST", form)) as { session: PublicSession };
    await this.refresh();
    return body.session;
  },

  async updateSession(ref: string, form: SessionConfigForm): Promise<PublicSession> {
    const body = (await send(`/api/sessions-config/${encodeURIComponent(ref)}`, "PUT", form)) as {
      session: PublicSession;
    };
    await this.refresh();
    return body.session;
  },

  async removeSession(ref: string): Promise<void> {
    const res = await fetch(`/api/sessions-config/${encodeURIComponent(ref)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await readError(res));
    await this.refresh();
  }
});
