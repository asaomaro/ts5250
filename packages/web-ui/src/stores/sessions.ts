import { reactive, markRaw } from "vue";
import {
  nextLink,
  type LinkEvent,
  type LostCause,
  type Resumability,
  type SessionLink
} from "../session-link.js";
import type { ScreenSnapshot } from "@ts5250/tn5250";
import type { ServiceState } from "@ts5250/server";
import type { WsClient } from "../ws-client.js";

/** プリンターセッションが受信した 1 スプール（等幅ページ列） */
export interface SpoolReportView {
  id: string;
  pages: { rows: number; cols: number; lines: string[] }[];
  /** 受信時刻（クライアントでスタンプ） */
  receivedAt?: number;
}

/** 接続時に判明している接続設定のメタ情報（情報表示用。資格情報の平文は持たない） */
export interface SessionMeta {
  host?: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  sessionType?: "display" | "printer";
  /** 端末の種類（既定 5250）。**使えるキーが変わる**ので送信側が見る。`vt` は専用ペイン */
  terminal?: "5250" | "3270" | "vt";
  /** VT の文字符号化（`terminal: "vt"` のみ） */
  vtEncoding?: string;
  autoSignon?: boolean;
  signonUser?: string;
}

/** 1 スプールに対する自動出力の結果（設定が無い側はキーごと省略＝「設定なし」） */
export interface SpoolOutputStatusView {
  spoolId: string;
  at: number;
  skipped?: boolean;
  pdf?: { ok: boolean; path?: string; error?: string };
  print?: { ok: boolean; printer?: string; error?: string };
}

/**
 * PC コマンド（STRPCCMD）1 件の表示用。開始時は `outcome` が無く、完了時に埋まる。
 * `hostname` は**実行された機械**（サーバープロセスが動いている側）。
 */
export interface PcCommandView {
  at: number;
  command: string;
  wait: boolean;
  hostname: string;
  outcome?:
    | { status: "ran"; exitCode: number | null; durationMs: number }
    | { status: "started" }
    | { status: "disabled" }
    | { status: "denied" }
    | { status: "failed"; error: string; durationMs: number };
}

/** マクロの実行状態（spec「マクロエンジンの実行時状態」）。記録と再生は排他 */
export type MacroMode = "idle" | "recording" | "recordPaused" | "playing" | "playPaused";

/** 再生が終わった理由。OIA に出して「なぜ止まったか」を分かるようにする */
export type MacroStopReason =
  | "completed"
  | "user"
  | "mismatch"
  | "timeout"
  | "disconnected"
  | "readonly"
  | "secret";

/**
 * 記録中に積む 1 ステップ。**秘密の平文はここにしか置かない**（spec D5）。
 *
 * 保存時にユーザーが欄ごとの扱いを選び、`plainSecrets` としてサーバーへ 1 回だけ送ったら
 * この draft ごと破棄する。localStorage には**いかなる形でも書かない**。
 */
export interface DraftStep {
  screen: { rows: number; cols: number; targets: { field: number; row: number; col: number; len: number }[] };
  /** 非表示欄でない通常の入力 */
  fields: { field: number; value: string }[];
  /** 非表示（パスワード）欄に打たれた値。保存の可否はユーザーが決める */
  secrets: { field: number; value: string }[];
  key: string;
  sysReqText?: string;
  cursor: { row: number; col: number };
}

export interface MacroRuntime {
  mode: MacroMode;
  /** 再生中のマクロ id（記録中は undefined） */
  macroId?: string;
  /** 記録中に積んだステップ */
  steps: DraftStep[];
  /** 再生の進捗（0-based。次に送るステップ） */
  index: number;
  /** 記録できない操作（拡張5250 の GUI 選択）に当たったか（spec D8） */
  incomplete?: boolean;
  stopReason?: MacroStopReason;
  /** 停止・警告の付随メッセージ（OIA に出す） */
  message?: string;
}

export interface SessionState {
  sessionId: string;
  label: string;
  /**
   * 元になった接続設定（セッション設定）の ref。
   * ランチャーが「この設定は既に開いている」を判定し、新規接続ではなくそのタブへ戻すために持つ。
   * 直接指定（設定を経ない接続）では undefined。
   */
  configRef?: string;
  /** どのシステムのセッションか（システム一覧に接続数を出すために持つ） */
  systemRef?: string;
  /** セッション種別（既定 display）。printer は帳票ビュー（PrinterPane）で表示する */
  kind?: "display" | "printer";
  /** 接続設定のメタ情報（セッション情報パネルで表示） */
  meta?: SessionMeta;
  snapshot: ScreenSnapshot | undefined;
  /** ローカル編集差分（fieldIndex → value）。AID 送信時に載せる */
  edits: Map<number, string>;
  cursor: { row: number; col: number };
  /**
   * **サーバーとの結びつき**（`20260908-session-lifetime-rules-fold`。規則は `session-link.ts`）。
   *
   * 畳み込み前は `connected` / `reconnect` / `reconnectFailed` / `endedByHost` の 4 つを
   * 12 箇所から個別に書いていた。**書き込みは下の遷移関数だけ**にしてある。
   */
  link: SessionLink;
  /** 繋ぎ直しの適性。**開いた時点で決まり、以後変わらない**（旧 kind / meta.terminal / attachedOnly） */
  resumability: Resumability;
  /**
   * サーバーと繋がっているか。**`link` からの導出**（読み取り専用）。
   *
   * 表示側の読み手（`StatusBar` / `App` / `EmulatorPane` ほか）を変えずに済むよう
   * 同じ名前で残してある。**代入は型で塞がる**——書くなら遷移関数を通すこと。
   */
  readonly connected: boolean;
  readOnly: boolean;
  /**
   * 予約（HLLAPI の `Reserve`）している主体の表示名。**予約中は入力を止める。**
   *
   * `readOnly` と別に持つ理由: あちらはセッションの性質で変わらない。
   * こちらは自動操作の間だけで、解ければ元に戻る。表示も「閲覧のみ」ではなく
   * 「誰が触っているか」を出す必要がある。
   */
  reservedBy?: string;
  client: WsClient;
  /**
   * ジョブ識別子。**接続と同時に `name`（＝装置名）だけ入ることがある**——
   * ユーザーと番号はサーバーが背後で引けたときに遅れて届く（画面には触れない）
   */
  job?: { name: string; system?: string; user?: string; number?: string };
  /** セッションの実効ホストコードページ（CCSID）。930/5026 は入力時に英小文字を大文字化する */
  ccsid?: number;
  /** ホスト応答待ち（通信中）。入力をプロテクトする */
  busy?: boolean;
  /** ローディング表示（通信が 0.5 秒以上かかったとき） */
  loading?: boolean;
  /**
   * **ブラウザ ↔ サーバーの繋ぎ直しを試している最中**（未設定＝試していない。
   * `20260908-session-survives-disconnect` design「2. 復帰」）。
   *
   * `busy`（ホスト応答待ち）と分けるのは、**待っている相手が違う**ため。busy は
   * ホストの返事待ちで画面を覆ってよいが、こちらはサーバーとの間が切れている状態で、
   * 覆うと復帰後に押せるはずのキーまで塞ぐ。OIA に出すだけにする。
   *
   * **`connected` とは重なる**——立つのは `connected === false` の間だけで、
   * 表示は再接続中を優先する（`StatusBar` の `inputState` は「切断」より先にこちらを返す）。
   *
   * **プリンターの `state: "reconnecting"` とは層が違う**。あちらはサーバー ↔ ホストの
   * 待ち受けの張り直しで、こちらはブラウザ ↔ サーバーの転送。
   *
   * `attempt` は**いま何回目か**（1 始まり）、`max` は試行の総数
   * （`session-controller` の再接続間隔表の長さ）。OIA に「再接続中 (2/5)」と直に出す。
   * **`link` からの導出**——`link.state === "reconnecting"` のときだけ値を返す。
   * 誰も直接は書かない（型で塞がっている）。
   */
  readonly reconnect?: { attempt: number; max: number };
  /**
   * **繋ぎ直しを諦めた理由**（design「2. 復帰」）。
   *
   * - `"retry"`: 転送が繋がらないまま試行が尽きた。時間が経てば直りうるので
   *   **手動の繋ぎ直しを出す**。
   * - `"gone"`: サーバーが「そのセッションはもう無い」と答えた（猶予切れ・他人のもの）。
   *   押しても同じ理由で失敗するので**ボタンは出さず、やり直しもしない**。
   *
   * **真偽値ではなく理由で持つ。** 「諦めた」と「まだ試していない」を区別できないと、
   * 諦めたはずのセッションに対して再試行のはしごを丸ごと回し直せてしまう。
   *
   * **`link` からの導出**——`lost` の理由が `gaveUp` なら `"retry"`、`gone` なら `"gone"`、
   * それ以外は未設定。誰も直接は書かない（型で塞がっている）。
   */
  readonly reconnectFailed?: "retry" | "gone";
  // 旧 `attachedOnly`（見に来ただけのタブ）は `resumability` へ、
  // 旧 `endedByHost`（ホスト側が終わった）は `link` の `lost/hostEnded` へ畳んだ。
  // どちらも読み手は繋ぎ直しの門と送信可否だけで、表示側には無かった。
  /**
   * 在席の合図（`activity`）を最後に送った時刻。間引きの基準
   * （`session-controller.ts` の `noteActivity`）。
   *
   * **モジュール側の Map ではなくここに持つ**——セッションと一緒に生まれて消えるので、
   * 閉じた id の記憶が残らない。
   */
  activitySentAt?: number;
  /**
   * サーバー応答由来の操作員メッセージ（ホスト無応答の通知等）。
   * ScreenGrid/EmulatorPane が出すローカル通知とは出所が違うのでここに持ち、次の送信で消す。
   */
  notice?: string;
  /**
   * マクロの実行状態（記録中 / 再生中 / 休止中）。未設定＝ `idle` と同義。
   * セッションごとに持つのは、ペインを分けて別セッションを触りながら
   * 片方だけ記録する、という使い方を壊さないため。
   */
  macro?: MacroRuntime;
  /**
   * PC コマンド（STRPCCMD）の実行が有効か。**無効でもホストへの応答は返る**ので、
   * 「実行しない理由」を利用者に示すために持つ（`WsOpened.pcCommand`）。
   */
  pcCommandEnabled?: boolean;
  /** PC コマンドの実行履歴（受信順・上限はサーバー側で 20 件） */
  pcCommands?: PcCommandView[];
  // ---- プリンターセッション（kind==="printer"）----
  /** 受信したスプール（帳票）一覧 */
  reports?: SpoolReportView[];
  /**
   * **累計受信数**（`20260802-printer-report-history`）。
   *
   * サーバー側の上限（`REPORT_LIMIT` 50 件）で**落ちた分も含む**ので、
   * `reports.length` と一致しないことがある。差が「落ちた数」。
   * 古いサーバー（送ってこない）では未設定＝`reports.length` に落とす。
   */
  receivedTotal?: number;
  /** ビューで選択中のスプール */
  selectedReportId?: string;
  /** 起動応答コード（I902 等）。**待ち受けていなければ無い**（接続していないため） */
  startupCode?: string;
  /**
   * 待ち受けの状態（`20260801-service-lifecycle-model`）。
   *
   * **「開く（登録する）」と「待ち受ける」は別**——`自動で待ち受け開始 ☐` の定義は
   * 開いても `stopped` のまま、利用者の開始操作を待つ。
   */
  state?: ServiceState;
  /** `state === "error"` の理由。`printerWarnings`（自動出力の失敗）とは別物 */
  serviceError?: string;
  /**
   * 状態の**通知が届いた回数**。値ではなく到着を数える。
   *
   * `state` を見張るだけでは足りない——`error` のまま開始をやり直して**また同じ理由で失敗**
   * すると値が変わらず、押した側は「返事が来ていない」と区別できない
   * （ボタンが押せないまま固まる）。
   */
  stateSeq?: number;
  /** 未読スプール数（プリンター。受信で++、タブ表示でクリア） */
  unread?: number;
  /** サーバー側の自動出力（PDF 保存/自動印刷）設定があるか＝トグル表示条件 */
  outputConfigured?: boolean;
  /** 自動出力の実行時 有効/無効 */
  outputEnabled?: boolean;
  /** 自動出力の警告（失敗）履歴。画面に表示して気づけるようにする */
  printerWarnings?: { at: number; message: string }[];
  /** スプールごとの自動出力の結果（PDF 作成・印刷の成否）。spoolId で引く */
  outputStatuses?: Record<string, SpoolOutputStatusView>;
}

/**
 * **構築時に渡す分**（導出の 3 つを除いたもの）。`sessionsStore.add()` が受け取る。
 *
 * `connected` / `reconnect` / `reconnectFailed` は `link` から生やすので、
 * **呼び出し側が値を持たない**（持てないようにしてある）。
 */
export type SessionStateInit = Omit<SessionState, "connected" | "reconnect" | "reconnectFailed">;

/**
 * **導出つきの `SessionState` を作る。** `sessionsStore.add()` を通さずに
 * 状態を組み立てたい場合（主にテスト）の入口。
 *
 * 直接オブジェクトリテラルで `connected` を書くと、`link` と食い違った値を持てて
 * しまう——**導出は 1 か所から生やす**ためにここを通す。
 */
export function createSessionState(init: SessionStateInit): SessionState {
  return defineDerivedLink(init);
}

/**
 * `link` からの導出 3 つをアクセサとして生やす。
 *
 * **読み取り専用にするのが要点**——畳み込み前は 9 箇所が `connected` へ直接書いており
 * （4 フィールド全部の書き込みを数えると 12 箇所）、「どこで切断が記録されたか」を追うのに
 * 全箇所を読む必要があった。getter にすると**代入が型で塞がる**ので、書き込みは
 * 下の遷移関数だけになる。web-ui はテストまで型検査される
 * （`vue-tsc -b tsconfig.json tsconfig.test.json`）ので、この防壁はテストにも効く。
 */
function defineDerivedLink(init: SessionStateInit): SessionState {
  // **二度掛けても壊れない。** `createSessionState()` で組んだものを `add()` に渡す経路が
  // あるので、既に生えていれば何もしない（`configurable: true` なので再定義自体は通るが、
  // 通す意味が無いうえ「1 度だけ生やす」が読み手に伝わらない）
  if (Object.getOwnPropertyDescriptor(init, "connected")?.get !== undefined) return init as SessionState;
  return Object.defineProperties(init, {
    connected: {
      enumerable: true,
      configurable: true,
      get(this: SessionStateInit) {
        return this.link.state === "connected";
      }
    },
    reconnect: {
      enumerable: true,
      configurable: true,
      get(this: SessionStateInit) {
        return this.link.state === "reconnecting"
          ? { attempt: this.link.attempt, max: this.link.max }
          : undefined;
      }
    },
    reconnectFailed: {
      enumerable: true,
      configurable: true,
      get(this: SessionStateInit) {
        if (this.link.state !== "lost") return undefined;
        if (this.link.cause === "gaveUp") return "retry";
        return this.link.cause === "gone" ? "gone" : undefined;
      }
    }
  }) as SessionState;
}

/** 遷移を 1 か所に通す。**`link` へ直接代入しない**（規則は `nextLink`） */
function applyLink(s: SessionState, ev: LinkEvent): void {
  s.link = nextLink(s.link, ev);
}

export const sessionsStore = reactive({
  byId: new Map<string, SessionState>(),
  order: [] as string[],

  /**
   * セッションを登録する。**導出の 3 つ（`connected` / `reconnect` / `reconnectFailed`）は
   * ここで `link` からのアクセサとして生やす**ので、呼び出し側は渡さない。
   *
   * **渡されたオブジェクトをそのまま使う**（新しく作り直さない）——呼び出し側が
   * 参照を握ったまま `notice` などを書く経路があるため
   * （`busy` は `setBusy` が `get()` 経由で書くので該当しない）。
   */
  add(init: SessionStateInit): SessionState {
    const state = defineDerivedLink(init);
    // client は Vue のリアクティブ化から除外（外部オブジェクト）
    state.client = markRaw(state.client);
    this.byId.set(state.sessionId, state);
    if (!this.order.includes(state.sessionId)) this.order.push(state.sessionId);
    return state;
  },

  get(id: string): SessionState | undefined {
    return this.byId.get(id);
  },

  /**
   * **口を差し替える**（繋ぎ直しの成功）。無い id では何もしない。
   *
   * **`markRaw` は store に閉じる**（生成は `add`・差し替えはここ）。同じ不変条件——外部オブジェクトを
   * Vue のリアクティブ化から外す——を呼ぶ側にも書くと片方だけ忘れる。**実際に忘れられていた**:
   * 繋ぎ直しの差し替えが素のまま入るため読み戻すとプロキシになり、**口の同一性で答える判定**
   * （`session-link.ts` の `isSessionClient`）が**成功後は必ず偽**になり、繋ぎ直しに成功したあと
   * 再び切れてもはしごが回らなかった（`20260910-session-reconnect-freeze` の `decisions.md` D7）。
   */
  setClient(id: string, client: WsClient): void {
    const s = this.byId.get(id);
    if (s) s.client = markRaw(client);
  },

  /**
   * **繋がった**（繋ぎ直しの成功・新画面の到着）。無い id では何もしない。
   */
  markConnected(id: string): void {
    const s = this.byId.get(id);
    if (s) applyLink(s, { to: "connected" });
  },

  /**
   * **切断として記録する。** 確定した理由（`hostEnded` / `gone` / `gaveUp`）と
   * 走っている繋ぎ直しは `transport` では上書きしない（規則は `nextLink`）。
   */
  markLost(id: string, cause: LostCause): void {
    const s = this.byId.get(id);
    if (s) applyLink(s, { to: "lost", cause });
  },

  /**
   * **繋ぎ直しを始める / 次の段へ進む。**
   *
   * 諦めの印（`gaveUp` / `gone`）を解く経路は 2 つ——ここと `requestRetry`（利用者が押した）。
   * `markConnected` も理由を消すが、あれは「繋がった」ので当然。
   */
  beginReconnect(id: string, attempt: number, max: number): void {
    const s = this.byId.get(id);
    if (s) applyLink(s, { to: "reconnecting", attempt, max });
  },

  /**
   * **利用者が「繋ぎ直す」を押した。** 諦めの印を解くが、まだ走り始めてはいない
   * （現行 `retryReconnect` が門の前に打つ 2 つの `delete` に対応）。
   */
  requestRetry(id: string): void {
    const s = this.byId.get(id);
    if (s) applyLink(s, { to: "retryRequested" });
  },

  /** そのシステムで接続中のセッション数（システムカードに出す） */
  connectedCount(systemRef: string): number {
    return this.all.filter((s) => s.systemRef === systemRef && s.connected).length;
  },

  /** 開いているセッション一覧（登録順） */
  get all(): SessionState[] {
    return this.order.map((id) => this.byId.get(id)).filter((s): s is SessionState => s !== undefined);
  },

  remove(id: string): void {
    this.byId.delete(id);
    this.order = this.order.filter((x) => x !== id);
  },

  /**
   * 予約の開始・解除を反映する。
   *
   * **開始時にローカル編集差分を捨てる。** 打ちかけを抱えたまま自動操作に画面を
   * 変えられると、次の AID でその値が別の画面の欄に載る。
   * （画面更新でも `updateScreen` が捨てるが、**予約は画面を変えずに始まる**ので
   * ここでも捨てる必要がある）
   */
  setReserved(id: string, by: string | undefined): void {
    const s = this.byId.get(id);
    if (!s) return;
    if (by !== undefined) {
      s.reservedBy = by;
      s.edits.clear();
    } else {
      delete s.reservedBy;
    }
  },

  updateScreen(id: string, snapshot: ScreenSnapshot): void {
    const s = this.byId.get(id);
    if (!s) return;
    s.snapshot = snapshot;
    s.cursor = snapshot.cursor;
    // **新画面が来た＝繋がっている。** 遷移は `nextLink` に通す（`link` を直に書かない）。
    //
    // **旧より広い遷移になっている**——旧は `connected = true` だけで `reconnect` /
    // `reconnectFailed` を残したが、union では `connected` になると理由も消える。
    // 差が出るのは「はしごが走っている最中に画面が来る」場合だけ。そこを塞ぐのは
    // `session-controller` の `tryResume` の共通ガード（`session-link.ts` の `acceptsFrame`）で、
    // **打ち切った試行からの更新は弾かれ続ける**——代表の試行でも、セッションが抱えている口でも
    // ないため（`s.client` への代入は `add` と `setClient` の 2 か所だけで、`setClient` は
    // 繋ぎ直しが成功したときにしか呼ばれない）。
    //
    // **`acceptsFrame` の第 2 項は `connected` の門を持つ**ので、はしごが回っている間は
    // セッションの口からのフレームも通らない（`20260910-session-reconnect-freeze` の
    // `decisions.md` D12）。門が無いと、`SessionState.client` は成功まで差し替わらないため
    // **はしごの最中ずっと第 2 項が真**になり、死にかけの口からの `screen` がここへ届いて
    // 「繋がっている」へ戻していた（**配送が実在する仕組み**は `session-link.ts` の
    // `acceptsFrame` の注記に 1 か所だけ置いてある）。
    //
    // **残るのは 1 つだけ**: **代表の試行**（第 1 項）から `opened` より前に、ここへ入る枝
    // （`screen` と `key-done` の 2 つ）が来る場合。畳み込み前のガード（`pendingResumes` との
    // 突き合わせ。`20260908-session-lifetime-rules-fold` の `decisions.md` D13 が現物を引く）でも
    // 同じだったので、本 work で空いた穴ではない。
    //
    // **初回接続の口も同じ門を通る**（`applyFromSessionClient`）。以前はここが素通しで、
    // **1 回目のはしごだけ無防備**だった（`20260910-session-reconnect-freeze` の `decisions.md` D13）。
    //
    // 到達しない組合せを型で表現できなくした、という `20260908-session-lifetime-rules-fold` の
    // `decisions.md` D10 と同じ性質。
    applyLink(s, { to: "connected" });
    // ホスト発の新画面が来たらローカル編集差分はクリア（新フォーマット）
    s.edits.clear();
  },

  /** プリンターセッションに受信スプールを追加する（最初の 1 件は自動選択・未読++） */
  addReport(id: string, report: SpoolReportView): void {
    const s = this.byId.get(id);
    if (!s) return;
    if (!s.reports) s.reports = [];
    if (report.receivedAt === undefined) report.receivedAt = Date.now();
    s.reports.push(report);
    if (!s.selectedReportId) s.selectedReportId = report.id;
    s.unread = (s.unread ?? 0) + 1;
    // **累計はサーバー値から始めて増やす**（`20260802-printer-report-history`）。
    // 開いた時点の `receivedTotal` は落ちた分を含んでいるので、そこに足せば含み続ける。
    // `reports.length` で数え直すと、落ちた分がここで消える
    if (s.receivedTotal !== undefined) s.receivedTotal++;
  },

  /** プリンタータブを表示したら未読をクリアする */
  markSpoolRead(id: string): void {
    const s = this.byId.get(id);
    if (s) s.unread = 0;
  }
});
