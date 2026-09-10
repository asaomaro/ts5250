/**
 * **セッション寿命の 4 規則のうち、クライアント側の 2 つ**（R3 繋ぎ直しの対象か・
 * R4 この試行はまだ有効か）の定義と純粋な判定（`20260908-session-lifetime-rules-fold`）。
 *
 * ## なぜ別ファイルなのか
 *
 * 前身の `20260908-session-survives-disconnect` では、4 規則を独立フラグの暗黙の連言として
 * 書いた結果、判定が両側の 12〜15 か所へ散った（デバッグ D1。うちクライアント側が
 * この 2 規則にあたる）。
 * review が 3 ラウンド続けて「直した項の隣が壊れる」を出した原因で、原因究明（同 work の
 * デバッグ D1）の診断は**個別の欠陥ではなく規則の置き場所**だった。
 *
 * ここは**状態も副作用も持たない**——引数と戻り値だけで規則を答える。状態を保持するのは
 * `stores/sessions.ts`、試行を駆動して WS を配線するのは `session-controller.ts`
 * （どちらもこの型を使うように順次差し替える）。
 *
 * **表示文言を知らない。** `MSG_SESSION_ENDED` 等は `composables/opMessages.ts` にあり、
 * ここから引くと規則が表示に依存する。理由の区分だけを返し、文言への写像は
 * `session-controller` が持つ。
 */
import type { WsClient } from "./ws-client.js";

/**
 * **繋ぎ直しの適性**。開いた時点で決まり、以後変わらない（状態ではなく識別情報）。
 *
 * 畳み込み前は `kind === "printer"` / `meta.terminal === "3270"` / `attachedOnly` の
 * 3 つを門で並べていた。**どれも「開いたときに決まる性質」**なので 1 つに畳んである。
 *
 * `not-resumable` になるのは 3 通り: プリンター（自前の `onClose` を持つ）/
 * 3270（サーバー側に共有・再取得の経路が無い。`20260908-session-survives-disconnect` の D3）/
 * **見に来ただけのタブ**（座を引き取らない約束なので繋ぎ直せない。
 * `20260908-session-survives-disconnect` の D4 / D13）。
 */
export type Resumability = "resumable" | "not-resumable";

/**
 * 切断の理由。**上書きの強さが違う**（`nextLink` 参照）。
 *
 * - `transport`: 転送が落ちた。繋ぎ直せば戻る
 * - `hostEnded`: ホスト側が終わった（`WsClosed.ended`）。待っても戻らない
 * - `gaveUp`: 繋ぎ直しのはしごを使い切った。押し直せる
 * - `gone`: サーバーに「そのセッションはもう無い」と言われた。押しても同じ理由で失敗する
 */
export type LostCause = "transport" | "hostEnded" | "gaveUp" | "gone";

/**
 * **サーバーとの結びつき**（R3 の定義）。この 3 状態は排他で、
 * 呼び出し側が真偽値を組み立て直せない。
 *
 * 畳み込み前は `connected` / `reconnect` / `reconnectFailed` / `endedByHost` の
 * 4 フィールドの組み合わせで表しており、**「再接続中なのに connected」**のような
 * 到達しない組合せが型の上で作れた。
 */
export type SessionLink =
  | { readonly state: "connected" }
  | { readonly state: "reconnecting"; readonly attempt: number; readonly max: number }
  | { readonly state: "lost"; readonly cause: LostCause };

/** `nextLink` に渡す遷移。**`link` を書き換えてよい唯一の入口** */
export type LinkEvent =
  | { readonly to: "connected" }
  | { readonly to: "lost"; readonly cause: LostCause }
  | { readonly to: "reconnecting"; readonly attempt: number; readonly max: number }
  /**
   * **利用者が「繋ぎ直す」を押した。** 諦めの印を解くが、まだ走り始めてはいない。
   *
   * 畳み込み前の `retryReconnect` が門を通す**前**に `delete s.reconnect` と
   * `delete s.reconnectFailed` を打っていたのに対応する（HEAD `90f5636f` の
   * `session-controller.ts:482-483`。**この 2 行は本 work で `requestRetry` に畳まれて消える**
   * ので、現在の行番号では指せない）。
   * この 2 行のおかげで「既に走っている」と「もう無いと言われた」を素通りできる
   * ——**押しても動かない**を防ぐための現行の振る舞いで、`research.md` F17-(5) が
   * そう記録している。`endedByHost` には削除経路が無いので、そこだけは解かない。
   */
  | { readonly to: "retryRequested" };

/**
 * **遷移の規則。弱いのは `transport` だけ**——既に `hostEnded` / `gone` / `gaveUp` が
 * 立っているとき、`transport` は上書きしない。
 *
 * 畳み込み前は `connected = false` と `endedByHost = true` が**別フィールド**だったため、
 * 切断を記録しても理由が消えなかった。1 つの union に畳むと素直には消えてしまうので、
 * **同じ結果になるよう優先度を明示する**（`session-controller` の `startReconnect` 冒頭が
 * 門より前に `connected = false` を打つのと同値）。
 *
 * それ以外の遷移は前の状態に関わらず置き換える——`hostEnded` / `gaveUp` / `gone` は
 * 既存の `lost` を上書きし（旧 `endedByHost = true` が `connected` の値に関わらず立つのと同値）、
 * `connected` / `reconnecting` も無条件。
 *
 * **1 点だけ現行と表現力が違う。** 現行の `endedByHost` には削除経路が無い（`grep` で 0 件）ので
 * 「繋がっているのにホスト終了の印が残る」組合せが型の上で作れたが、union では作れない
 * ——`connected` / `reconnecting` へ遷移すると理由は消える。**この組合せは到達しない**
 * （ホスト終了ではサーバーがエントリごと削除するので、以後 `opened` も `screen` も来ない）ため
 * 振る舞いは変わらないが、**到達しない状態を型で排除した**という差はある
 * （`20260908-session-lifetime-rules-fold` の `decisions.md` D10）。
 */
export function nextLink(prev: SessionLink, ev: LinkEvent): SessionLink {
  if (ev.to === "connected") return { state: "connected" };
  if (ev.to === "reconnecting") return { state: "reconnecting", attempt: ev.attempt, max: ev.max };
  if (ev.to === "retryRequested") {
    // ホストが終わった印だけは解かない（現行に `delete s.endedByHost` が無い）
    if (prev.state === "lost" && prev.cause === "hostEnded") return prev;
    return { state: "lost", cause: "transport" };
  }
  if (ev.cause === "transport") {
    // **走っている繋ぎ直しを潰さない。** 現行の `connected = false` は `s.reconnect` を
    // 消さないので、門4（二重起動防止）がその後も効く——ここで `lost` に落とすと
    // **はしごが 1 段目から二重に回る**（`research.md` F17-(4) の未テストの穴に当たる経路）
    if (prev.state === "reconnecting") return prev;
    // 確定した理由も上書きしない
    if (prev.state === "lost" && prev.cause !== "transport") return prev;
  }
  return { state: "lost", cause: ev.cause };
}

/**
 * **繋ぎ直せない理由**（`resumeVerdict` が返す）。畳み込み前の `startReconnect` の門と 1:1。
 *
 * `notResumable` = 門1（対象外の端末・見に来ただけ）、`running` = 門4（既に走っている）、
 * `hostEnded` = 門2、`gone` = 門3。
 */
export type NoResumeReason = "notResumable" | "running" | "hostEnded" | "gone";

/** 繋ぎ直してよいか、駄目ならなぜか（R3 の唯一の答え） */
export type ResumeVerdict = { readonly resume: true } | { readonly resume: false; readonly why: NoResumeReason };

/**
 * **繋ぎ直してよいか**（R3 の唯一の答え）。畳み込み前の `startReconnect` の 4 門と 1:1。
 *
 * 門1（対象外の端末・見に来ただけ）→ `resumability`、門2（ホストが終わった）と
 * 門3（もう無いと言われた）→ `lost` の理由、門4（既に走っている）→ `reconnecting`。
 * 門の順序は**結論**には影響しない（`link` の 3 状態は排他なので、同時に 2 つの門に当たらない）が、
 * **`why` は門の順に決まる**ので `resumability` を先に見る——`resumability` は `link` と直交していて、
 * **門1 と門2/門3 は同時に成り立つ**（見に来ただけのタブでホストが終わった、など）。
 * 畳み込み前も門1 が先だったので、この順序が現行の振る舞い。
 * （門4 とは重ならない。`reconnecting` になるのは門を通った後だけなので `resumability` は必ず `resumable`）
 *
 * **真偽ではなく理由を返す。** 現行は**門1 だけが `MSG_CONNECTION_LOST` を書き、門2〜4 は黙る**
 * という非対称を持つ（黙る枝は「開き直す以外に手が無い」ので、待てば戻る含みの汎用文を
 * 出すと嘘になる）。真偽だけ返していた頃は、呼び出し側がこの出し分けのために
 * **`resumability` を読み直して門1 を再評価**していた——規則の外に写しが 1 つ出ている状態で、
 * requirements AC1 が禁じる形そのもの（本 work の review ラウンド1）。理由を返せば呼び出し側は `why` で分岐できる。
 */
export function resumeVerdict(link: SessionLink, r: Resumability): ResumeVerdict {
  if (r === "not-resumable") return { resume: false, why: "notResumable" };
  if (link.state === "reconnecting") return { resume: false, why: "running" };
  if (link.state === "lost" && (link.cause === "hostEnded" || link.cause === "gone"))
    return { resume: false, why: link.cause };
  return { resume: true };
}

/**
 * **ホストへ送ってよいか**。畳み込み前の `refuseIfDisconnected` の 2 分岐と 1:1。
 *
 * **`LostCause` をそのまま返さない**——`reconnecting` に対応する理由が `LostCause` に無く、
 * 現行も再接続中は「繋がっていません」を出すため。文言への写像は `session-controller`。
 */
export function canSendToHost(link: SessionLink): { ok: true } | { ok: false; reason: "disconnected" | "hostEnded" } {
  if (link.state === "connected") return { ok: true };
  if (link.state === "lost" && link.cause === "hostEnded") return { ok: false, reason: "hostEnded" };
  return { ok: false, reason: "disconnected" };
}

/**
 * **繋ぎ直しの 1 試行**（R4 の定義）。セッションごとに高々 1 つ。
 *
 * 畳み込み前は「この試行はまだ有効か」を **5 系統**で見ていた——試行ローカルの `settled`、
 * `pendingResumes` との突き合わせ、`reconnectTimers` の Map、`s.reconnect` の有無、
 * そして差し替え済みの口かどうか。**どれを畳んでも他が単独では守れない**状態だった
 * （`20260908-session-lifetime-rules-fold` の `research.md` F4）。**このうち 3 つ**（`settled` / `pendingResumes` / `reconnectTimers`）が
 * ここに畳まれ、**`s.reconnect` は `SessionLink` の `reconnecting`** が代表する——
 * つまり「走っているか」は R3 の状態、「どの試行が代表か」は R4 の状態として分かれる。
 *
 * **5 つ目（差し替え済みの口かどうか）はこの型に畳まない**——あれは「この試行が有効か」ではなく
 * 「**セッションがいま抱えている口か**」を問うており、成功した試行が退役したあとの `onClose`
 * ——**切れたことを機に自動で回し直す唯一の経路**（`startReconnect` の呼び手は他に
 * `openSession` の `onClose` と、利用者が押し直す `retryReconnect` の 2 つ）——を
 * 区別できなくなる。**捨てたのではなく、隣に置いた**
 * ——`isSessionClient` がそれで、両方が要る場所には合成の `acceptsFrame` が答える。
 *
 * **その 5 つ目が必要なのに欠けている場所があった**（`20260908-session-lifetime-rules-fold` の
 * `decisions.md` D13）。`session-controller.ts` のメッセージ共通ガードが `isCurrentAttempt` だけを
 * 見ていたため、**繋ぎ直しに成功した直後から全フレームが落ちていた**（成功時に試行を退役させるため、
 * 以後この判定は必ず偽になる）。利用者から見ると「再接続したのに画面が固まり、応答待ちの覆いが
 * 消えない」。畳み込みの work は「振る舞いを変えない」制約のため直さず backlog へ起票し、
 * **`20260910-session-reconnect-freeze` が `acceptsFrame` として塞いだ**。
 */
export interface Attempt {
  /** 待ち時間の表の何段目か */
  readonly index: number;
  /**
   * この試行の口。**待ち中は `undefined`**（まだ開いていない）。
   *
   * 畳み込み前は「待ち」と「飛行中」を別の Map に分けていたが、**同じ試行の 2 つの相**
   * でしかない——分けていたせいで「待ちだけ畳んで飛行中が残る」が作れた。
   */
  client: WsClient | undefined;
  /**
   * 待ち中は**次の試行までのタイマー**、飛行中は**黙り込みの打ち切り**。
   * 相が変わるときに張り替える（同時には持たない）。
   */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** この試行の後始末が済んだか。**1 度だけにする**ための印 */
  settled: boolean;
}

/**
 * **この試行がいまも代表か**（R4 の唯一の答え）。
 *
 * `connect()` の失敗と `onClose` は両方来うるし、打ち切った古い試行から遅れて
 * `opened` や `screen` が届くこともある。**代表でない試行の結果は捨てる**
 * ——とくに `screen` は `updateScreen` 経由で「繋がっている」に戻してしまう。
 *
 * **2 項のうち効いているのは第 1 項だけ**（`20260908-session-lifetime-rules-fold` の `decisions.md` D17）。`settled` を立てる 4 経路は
 * いずれも同じ同期ブロックで `attempts` から当該試行を外すので、`current === a && a.settled`
 * は到達しない。`!a.settled` は**外し忘れたときに効く保険**として残している——
 * 片方だけ壊しても表は落ちないので、テストではなくこの注記が唯一の記録。
 */
export function isCurrentAttempt(current: Attempt | undefined, a: Attempt): boolean {
  return current === a && !a.settled;
}

/**
 * **セッションがいま抱えている口か**（R4 の 5 つ目）。
 *
 * **繋がっているかではない。** `SessionState.client` は切れても差し替わるまで残るので、
 * **切れたばかりの口でも真を返しうる**——繋がりの真実を持つのは `SessionLink` のほう。
 * ここが答えるのは「この口がセッションの現在の口か」だけ。
 *
 * **参照の同一性で答えるので、store が口を `markRaw` していることに乗っている**
 * （`stores/sessions.ts` の `add` / `setClient`）。外れると Vue が読み戻しでプロキシに包み、
 * ここは**必ず偽**になって静かに壊れる（`20260910-session-reconnect-freeze` の
 * `decisions.md` D7 が実測）。このモジュールは Vue を知らないので `toRaw` は置けない
 * ——前提はこの注記にしか残せない。
 *
 * 畳み込み（`20260908-session-lifetime-rules-fold`）で R4 に入らなかった 1 つがこれで
 * （上の `Attempt` と下の `acceptsFrame` の注記）、名前が無いまま呼び出し側に
 * `=== client` と書かれていた。
 */
export function isSessionClient(live: WsClient | undefined, from: WsClient): boolean {
  return live === from;
}

/**
 * **この口から届いたフレームを受け取ってよいか**（R4 の合成）。
 *
 * 繋ぎ直しの口には 2 つの相がある——**まだ試行中**（代表の試行なら受け取る）と、
 * **成功して現役になった後**（セッションの口なら受け取る）。成功時に試行を退役させるので、
 * 前者だけを見ていると**成功した瞬間から以後の全フレームが落ちる**
 * （`20260908-session-lifetime-rules-fold` の `decisions.md` D13。同 work は
 * 「振る舞いを変えない」制約を負っていたため直さず起票した）。
 *
 * **選言をここに置くのが要。** 呼び出し側で `||` を書くと、独立した述語を呼ぶ側で組み立てる形
 * ——畳み込み前に判定が散った原因そのもの（このファイル冒頭の「なぜ別ファイルなのか」）——に戻る。
 *
 * **`opened` の枝では使わない。** あちらが問うのは「この試行の成功を採用してよいか」で、
 * 現役の口から 2 度目の `opened` が来たときに成功処理を二重に走らせてはならない。
 *
 * **第 2 項に `connected` の門が要る**（`20260910-session-reconnect-freeze` の review ラウンド1 の must）。`SessionState.client` は
 * 繋ぎ直しが成功するまで差し替わらないので、**はしごが回っている間ずっと第 2 項が真**になる。
 * そこへ死にかけの口からフレームが通ると `updateScreen` が「繋がっている」へ戻し、以後の送信が
 * 非 OPEN のソケットへ落ちて黙殺される（待ちだけが残る）。**配送は実在する**——
 * `ws-client.ts` の見張りは `ws.close()` のあと保険のタイマーで `onClose` を撃つので、
 * その時点でソケットはまだ CLOSING で、`message` の受け口に `readyState` の検査は無い。
 */
export function acceptsFrame(
  current: Attempt | undefined,
  a: Attempt,
  live: WsClient | undefined,
  from: WsClient,
  link: SessionLink | undefined
): boolean {
  return isCurrentAttempt(current, a) || acceptsFromSession(link, live, from);
}

/**
 * **繋がっているセッションの口から届いたフレームか**（`acceptsFrame` の第 2 項）。
 *
 * **試行を持たない口はこちらだけを問う。** 初回接続の口には `Attempt` が無いので
 * `acceptsFrame` を呼べないが、**塞ぐべき穴は同じ**——1 回目のはしごを駆動するのは必ずその口で、
 * `SessionState.client` は成功まで差し替わらないから、はしごの最中も「セッションの口」の判定は
 * 真のまま。門が無いと死にかけの口からの `screen` / `key-done` が `updateScreen` に届いて
 * 「繋がっている」へ戻す（`20260910-session-reconnect-freeze` の review ラウンド2 の must）。
 */
export function acceptsFromSession(
  link: SessionLink | undefined,
  live: WsClient | undefined,
  from: WsClient
): boolean {
  return link?.state === "connected" && isSessionClient(live, from);
}
