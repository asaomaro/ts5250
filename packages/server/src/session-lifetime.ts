/**
 * **セッション寿命の 4 規則のうち、サーバー側の 2 つ**（R1 持ち主・R2 猶予）の
 * 定義と純粋な判定（`20260908-session-lifetime-rules-fold`）。
 *
 * ## なぜ別ファイルなのか
 *
 * 前身の `20260908-session-survives-disconnect` では、この 2 規則を**独立フラグの暗黙の連言**
 * として書いた結果、1 つの規則を答える判定が `ws-handler` と `session-manager` の
 * 12〜15 か所へ散った。review が 3 ラウンド続けて「直した項の隣が壊れる」を出した原因で、
 * 原因究明（同 work のデバッグ D1）の診断は**個別の欠陥ではなく規則の置き場所**だった。
 *
 * ここは**状態の保持も副作用も持たない**——引数と戻り値だけで規則を答える。
 * 保持は `session-manager.ts`（エントリの `holder` / `hold`）、副作用（タイマー・`close`）も
 * そちら。この分離のおかげで、規則そのものを 1 ファイル読めば把握でき、
 * 変異注入の対象も 1 か所に定まる。
 *
 * **Node API に依存しない**（タイマーの実体は `session-manager` 側が持つ）。
 */

/**
 * アイドルタイムアウトの内部表現。ms、または `"never"`（＝切らない）。
 *
 * **`0` / `null` を「切らない」の印にしない**——未設定・転記漏れと見分けが付かなくなる
 * （`20260729-session-lifetime-timeout` の spec 方針2「`"never"` ＋ 分の数値で表す」）。
 * 設定ファイル側は「分」で持ち、`idleTimeoutToMs()` でここへ変換する。
 */
export type IdleLimit = number | "never";

/**
 * **持ち主の状態**（R1 の定義。持ち主に関する情報をここ以外に置かない）。
 *
 * 「持ち主」は**畳む責任が誰にあるか**で、`viewers`（見ている人の数）とは別軸。
 * 半開きの回線では、クライアントが先に見切って繋ぎ直す一方、サーバー側の古いハンドラは
 * 心拍の死判定ぶん遅れて後始末に来る。印を記録しておかないと、**新しい接続が復帰した直後に
 * 古いハンドラがそのセッションを閉じる**（前 work の D7）。
 *
 * `ever` は「一度でも持ち主が付いたか」。**一度立ったら降りない**——「持ち主が去った」と
 * 「そもそも持ち主という概念で管理していない」（MCP / HLLAPI が開いたセッション）を
 * 区別するために要る。前者だけが孤児回収の対象（`lifetimeOf`）。
 *
 * **`SessionReservation.holder`（予約の持ち主＝表示名）とは別概念**。名前が似ているだけ。
 */
export type HolderState =
  | { readonly held: false; readonly ever: boolean }
  | { readonly held: true; readonly ever: true; readonly token: number };

/**
 * **猶予の状態**（R2 の定義）。転送が落ちたときだけ入る（前 work の D5 / D12）。
 *
 * 期限（`until`）は必ず在るか必ず無いかで、**中間が無い**——期限とタイマーを
 * 独立フィールドに持っていた頃は「期限はあるがタイマーは無い」という状態が型の上で作れた。
 * タイマーの実体は `session-manager` 側（Node の型を持ち込まないため）だが、
 * **判定に使うのはこの型だけ**。
 */
export type HoldState = { readonly holding: false } | { readonly holding: true; readonly until: number };

/**
 * **接続がセッションに対して持つ役割**（R1 のうち接続側が持つ分）。
 *
 * `owner` は自分で開いたか `resume` 付きの attach で引き取った接続、`viewer` は
 * 見に来ただけの attach。**見に来た人は畳む責任を持たない**——MCP が開いた画面を
 * ブラウザで覗く使い方を壊さないため（前 work の D4）。
 *
 * この 2 値に畳んであるので、「見に来ただけなのに持ち主」という到達しない組合せは作れない。
 */
export type ConnRole = { readonly kind: "owner"; readonly token: number } | { readonly kind: "viewer" };

/**
 * 接続が去るときの処分。
 *
 * `why` を分けているのは、**なぜ畳まなかったかをテストが assert できるようにする**ため
 * （結論だけだと「たまたま同じ結論」を見分けられない）。
 */
export type Disposition =
  | { readonly act: "keep"; readonly why: "viewer" | "otherViewers" | "resident" | "handedOver" }
  /**
   * 猶予として保持する。**`already` は「既に猶予中だったので何もしない」**。
   *
   * 2 つを畳むと、素直な呼び出し側（`if (act === "hold") beginHold(now + grace)`）が
   * **期限を延ばしてしまう**——繋ぎ直せないまま切断を繰り返すクライアントが、枠と
   * 装置記述を無期限に掴める。現行が `holdForReconnect` の戻り値で塞いでいる穴なので、
   * 畳まずに型で残す（`keep` に `why` を付けたのと同じ理由）。
   */
  | { readonly act: "hold"; readonly already: boolean }
  | { readonly act: "close" };

/**
 * `decideDisposition` が見る入力。**集めるのは `session-manager`、判断はここ**。
 *
 * `wasHolder` / `hasHolder` の順序に意味がある——**座は判断より前に無条件で返す**ので、
 * `hasHolder` は「返したあとで誰か居るか」を指す。返す前に評価すると意味が変わる
 * （前 work の D10 がこの順序で孤児化を塞いだ）。
 */
export interface DispositionInput {
  readonly role: ConnRole;
  /** 転送が落ちたのか（利用者が閉じたのではない） */
  readonly transportLost: boolean;
  /** 座を返した結果、自分が持ち主だったか */
  readonly wasHolder: boolean;
  /** **座を返したあとで**持ち主が居るか */
  readonly hasHolder: boolean;
  /** 自分の購読を外したあとで、まだ見ている接続が居るか */
  readonly hasOtherViewer: boolean;
  /** 常駐（サービス型）のプリンターか */
  readonly resident: boolean;
  /**
   * **いまから猶予に入れられるか**——現行 `holdForReconnect()` が「まだ猶予中でないなら
   * true を返す」条件そのもの: **エントリがまだ在る・表示セッションである・猶予が有効**
   * （`reconnectGraceMs > 0`）。プリンターは常に `false`（猶予は表示セッション専用）。
   *
   * **「エントリが在る」を落とさないこと。** 既に閉じられたセッションに古いハンドラが
   * 心拍の死判定で後から来る経路が実在し（`reapHold` → `close` のあと）、
   * そこを落とすと現行が `close` に落とす場面で `hold` を返す（T4 のタスク点検が指摘）。
   */
  readonly holdable: boolean;
  /**
   * いまの猶予の状態。**エントリが無いとき・プリンターのときは `{ holding: false }` を渡す**
   * ——現行の `isHeld()` は `sessions.get(id)?.heldUntil` を見るので、
   * どちらの場合も必ず偽になる（＝閉じる側に落ちる）。`holdable` と同じ前提が
   * こちらにも掛かる（T4 のタスク点検・ラウンド2 の指摘）。
   */
  readonly hold: HoldState;
  readonly now: number;
}

/** まだ誰も持ち主になっていない（エントリの初期値） */
export function noHolder(): HolderState {
  return { held: false, ever: false };
}

/** 新しく持ち主になる */
export function claimHolder(token: number): HolderState {
  return { held: true, ever: true, token };
}

/**
 * **座を返す。** 自分が持ち主だったなら印を外す。
 *
 * 「見るだけ」（旧 `isHolder`）ではなく「返す」なのは、2 つの接続が続けて引き取ったあと
 * **新しい持ち主が先に去るとどちらも閉じない**状態が作れたため（前 work の D10）。
 */
export function releaseHolder(
  prev: HolderState,
  token: number | undefined
): { readonly holder: HolderState; readonly wasHolder: boolean } {
  if (token === undefined || !prev.held || prev.token !== token) return { holder: prev, wasHolder: false };
  return { holder: { held: false, ever: true }, wasHolder: true };
}

/** 猶予に入る（期限つき） */
export function beginHold(until: number): HoldState {
  return { holding: true, until };
}

/** 猶予を解く */
export function endHold(): HoldState {
  return { holding: false };
}

/**
 * 猶予中か。**期限切れは false**——読み手が毎回 `until` を見比べなくて済むようにする
 * （刈るのはタイマーと掃除役）。
 */
export function isHeldAt(hold: HoldState, now: number): boolean {
  return hold.holding && hold.until > now;
}

/**
 * **接続が去るときの処分を決める**（R1 ＋ R2 の唯一の答え）。
 *
 * 順序は前身の実装（`ws-handler.dispose` の 3 段ゲート）と同値で、連言の短絡を
 * 並べ替えただけ。**呼び出し側がこの順序を組み立て直さないこと**が、この関数の存在意義。
 */
export function decideDisposition(i: DispositionInput): Disposition {
  // **見に来ただけの接続は何もしない。** 開いた人や MCP がまだ使っている
  if (i.role.kind === "viewer") return { act: "keep", why: "viewer" };
  // **他に見ている人が残っていれば閉じない**（後から繋いだタブが残っているのに画面が消える、を避ける）
  if (i.hasOtherViewer) return { act: "keep", why: "otherViewers" };
  // **常駐プリンターは切らない。** 「設定が仕事をする」サービス型なので、
  // タブを閉じたら帳票が来なくなるのは利用者の期待に反する
  // （`20260801-printer-session-residency` の design D1）
  if (i.resident) return { act: "keep", why: "resident" };
  // **交代済みで、その相手がまだ居る。** 手を出さない唯一の場合——
  // 自分が持ち主だったなら畳み、持ち主が誰も居ないなら自分が最後の 1 人（前 work の D10）
  if (!i.wasHolder && i.hasHolder) return { act: "keep", why: "handedOver" };
  if (!i.transportLost) return { act: "close" };
  // **回線が落ちただけなら少し待つ。** ホストの対話ジョブは画面遷移の途中状態を持つので、
  // 掛け直せるなら掛け直させる（前 work の D5）。
  //
  // **既に猶予中ならそのまま**（期限を延ばさない）。**期限切れはここに入らない**
  // ——現行も `holdForReconnect` / `isHeld` の両方が false を返して閉じる側に落ちる
  if (isHeldAt(i.hold, i.now)) return { act: "hold", already: true };
  if (i.holdable && !i.hold.holding) return { act: "hold", already: false };
  return { act: "close" };
}

/**
 * **猶予の期限が来たときどうするか**（R2 の残り半分）。
 *
 * **見ている人が居れば閉じない。** 猶予中のセッションにも普通に attach できる
 * （セッション管理の「既にあるセッションを開く」・MCP）ので、持ち主が戻らなかったからと
 * いって**いま使っている人の足元でセッションを閉じない**——「見に来た人が去っただけで
 * 相手の作業を殺さない」の裏返しで、相手が去ったからといって見に来た人の作業を殺さない、
 * という同じ原則。
 *
 * 猶予だけ解いた場合、そのセッションは「持ち主の居ないセッション」になるが、
 * 寿命は `lifetimeOf` が規則として孤児回収の上限に落とす（設定値そのものは書き換えない）。
 */
export function decideHoldExpiry(hasViewer: boolean): "cancelHold" | "close" {
  return hasViewer ? "cancelHold" : "close";
}

/**
 * **このエントリに効く寿命**（R1 からの導出。前 work の review ラウンド3）。
 *
 * 設定値に、**持ち主が居ないセッションの上限**を規則として重ねる。既定が `"never"`（永続）で
 * いられる根拠は「WS の切断と心拍が孤児を回収する」ことだった——**持ち主が居なくなった瞬間、
 * その根拠は消える**。去った接続はもう回収しに来ないし、見に来ただけの接続は畳まない側なので、
 * 放っておくと枠と装置記述を握ったまま永久に残る。
 *
 * **設定を書き換えないのが要点。** 書き換える形にしていた頃は (a) 持ち主が戻っても元に戻す
 * 経路が無く、(b) 有限に設定したサーバーでは上限が**延びる**という、回収を強めるつもりの
 * 変更が緩める向きに働く穴があった。規則として重ねれば、持ち主が戻った瞬間に自然と元の
 * 寿命へ戻り、短いほうが常に勝つ。
 *
 * **一度も持ち主が付いていないもの**（MCP / HLLAPI が開いた分）は対象外——開くときに
 * 自分で寿命を決めており、ここで重ねると「引数なしのマネージャは永続」という既定を黙って壊す。
 *
 * **表示セッション専用。** プリンターにも `claim` は打つので `ever` は立つが、掃除役は
 * プリンターをここに通さない。理由は「常駐が刈られるから」ではない（常駐は上限を計算する
 * 前に無条件でスキップされる）——**プリンターは猶予の対象外で、転送が落ちればその場で
 * 閉じるので「持ち主が去って宙に浮く」状態がそもそも作れない**から
 * （`session-manager.ts` の `sweepIdle` プリンター枝のコメント。前 work の review でも
 * 「対応不要」と結論している）。`claim` をプリンターにも打つのは、**古いハンドラに
 * 殺させない**ためだけのもの。
 */
export function lifetimeOf(holder: HolderState, configured: IdleLimit, orphanMs: number): IdleLimit {
  if (!holder.ever || holder.held) return configured;
  if (configured === "never") return orphanMs;
  return Math.min(configured, orphanMs);
}
