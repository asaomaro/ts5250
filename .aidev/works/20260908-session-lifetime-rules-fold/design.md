# 仕様: セッション寿命の 4 規則を定義 1 つ＋導出関数に畳む

## 概要

R1〜R4 のそれぞれに**状態を表す単一の定義**を置き、既存の判定をその定義からの導出に置き換える。
R3 だけは**状態（`link`）と、開いた時点で決まる静的な性質（`resumability`）の 2 つ**を持つ
——後者は状態ではなく識別情報で、時間とともに変わらない（現行の `kind` / `meta.terminal` /
`attachedOnly` も同じ性質だった）。
**振る舞いは 1 つも変えない。** 変えないことは、畳み込みの**前に**現行実装で埋める組合せ表
（AC4）と、既存の回帰テストが緑のままであること（AC3）で示す。

畳み込みは**呼び出し側の分岐を消す**方向で行い、**公開メソッドは残す**（AC6）。
既存の公開メソッド（`claim` / `releaseHolder` / `hasHolder` / `holdForReconnect` / `isHeld` /
`cancelHold`）は**導出関数の層に降格**する——消すと、型検査されないサーバーのテスト
（`research.md` F19）が実行時にしか壊れない。

## 設計方針

### 方針1: 定義は「状態の union」、判定は「導出関数」、副作用は「定義を持つ側」

散っている真偽値の組を 1 つの union に畳み、**呼び出し側が真偽値を組み立て直せない形**にする
（AC1）。呼び出し側は導出関数の戻り値で分岐するだけにする。

### 方針2: サーバーは `disposition()` に**判断も副作用も**寄せる

`ws-handler.dispose` の 3 段ゲート（`research.md` F2）を丸ごと `SessionManager.disposition()` へ移す。
座を返す・猶予に入れる・閉じる、はすべて `SessionManager` の内側で起きる。
`ws-handler` 側に残る**寿命の判断は 0**（残るのは「セッションに結びついているか」の
`if` 1 つだけで、これは判断ではなく有無の確認）。

- **代替案（退けた）**: `disposition()` を純粋な判定にし、`ws-handler` が結果を見て
  `releaseHolder` / `holdForReconnect` / `close` を呼び分ける。
  退けた理由: 「座は無条件に返す・`holdForReconnect` の `false` は閉じてよいの意味ではない」という
  **順序と含意の知識が呼び出し側に残る**。前 work の D7 → D10 の手戻りはまさにそこで起きた。

### 方針3: クライアントは「読む形」を変えず、「書く形」だけ畳む

`connected` / `reconnect` / `reconnectFailed` は **`link` から導く読み取り専用アクセサ**にし、
表示側（`StatusBar.vue` / `App.vue` / `EmulatorPane.vue` ほか 9 箇所。`research.md` 影響範囲）は
**1 行も変えない**。書き込み 12 箇所を遷移関数へ寄せる。

- **理由**: 散っているのは**書き込み側**（12 箇所が独立に真偽値を立てている）。読み取り側は
  すでに 1 つの値を読んでいるだけで、触ると表示の退行リスクだけが増える。
- **効き目**: `connected` を getter にすると `s.connected = true` が**型で書けなくなる**。
  web-ui はテストまで型検査される（`research.md` F19）ので、これは**最も強い封じ込め**になる。

### 方針4: AC2 の対象集合を「決定に使う生フラグ」に絞る

requirements の表の 3 列目のうち、**`kind` / `meta.terminal` / `connected` は表示にも使われる**
（`research.md` 影響範囲）。これらを「定義と導出関数の内側だけ」に閉じ込めるのは過剰で、
表示を壊さずには達成できない。**この 3 つを AC2 の対象集合から外し**、代わりに
「R3 の判定に使う静的な性質」を `resumability` に畳んで**そちらを対象に含める**。
requirements の表はこの変更に合わせて更新した（`requirements.md` の同表・`decisions.md` D4）。

### 方針5: 組合せ表は 1 ファイルに置き、両側がそこから回す

置き場所は **`packages/web-ui/test/session-lifetime-matrix.ts`**。サーバーのテストが
相対パスで import する。**この向きしか成立しない**——web-ui はテストも型検査され
（`vue-tsc -b tsconfig.test.json`）、`composite: true` の下で `include` の外のファイルを
取り込むと壊れる。サーバーのテストは型検査されない（`research.md` F19）ので、
外から取り込んでも `tsconfig` を触らずに済む。ファイル冒頭にこの理由を書く。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/server/src/session-manager.ts` | `HolderState` / `HoldState` の型と単一フィールド化、`disposition()` 追加、`idleLimitOf` → `lifetimeOf` 改名、既存公開メソッドを導出へ降格 |
| `packages/server/src/ws-handler.ts` | `sessionId` + `attached` + `holderToken` の 3 フィールドを `link` 1 つに畳む、`dispose` の処分の判断（`:1125-1147`）を `disposition()` 呼び出しに置換 |
| `packages/web-ui/src/stores/sessions.ts` | `SessionLink` union と `resumability` を追加、`connected` / `reconnect` / `reconnectFailed` を getter 化、遷移関数を追加 |
| `packages/web-ui/src/session-controller.ts` | `startReconnect` の 4 門を `resumeVerdict()` 1 つに、送信可否を `sendToHost()` に、試行の新旧 5 系統のうち 4 つを `Attempt` レコード＋`isCurrentAttempt()` に、**`connected` などへの書き込み 11 箇所を遷移関数の呼び出しに置換**（残り 1 箇所は `stores/sessions.ts` の `updateScreen`） |
| `packages/web-ui/test/session-lifetime-matrix.ts` | **新規**。組合せ表（両側が読む） |
| `packages/web-ui/test/session-lifetime-matrix.test.ts` | **新規**。クライアント側を表から回す |
| `packages/server/test/session-lifetime-matrix.test.ts` | **新規**。サーバー側を表から回す |
| `packages/server/test/lifetime-flag-containment.test.ts` | **新規**。AC2 の走査テスト（サーバー） |
| `packages/web-ui/test/lifetime-flag-containment.test.ts` | **新規**。AC2 の走査テスト（クライアント） |
| 既存テスト | 呼び出しの形だけ追随（期待値は変えない） |
| `.aidev/backlog/session-lifecycle.md` | deliver で 1・2 件目を `[x]` にする（AC8） |

**AC5 の変異注入はファイルを追加しない。** 4 定義の**読み取り**に 1 つずつ手で変異を入れて表が落ちることを
確かめ、**確かめたら戻す**（作業ツリーに残さない）。何を入れて何件落ちたかは `test-result.md` に書く
——変異を残す形（ミュータント用のフラグやビルド分岐）は本番コードに検査専用の分岐を持ち込むため採らない。

**触らない**: `StatusBar.vue` / `App.vue` / `EmulatorPane.vue` / `SessionInfo.vue` / `PaneTabs.vue` /
`WorkspaceNode.vue` / `VtPane.vue` / `composables/openConfigured.ts` / `macro-engine.ts`
（方針3 により読み取りの形が変わらない）。

## 依拠する既存の事実

すべて `research.md` で一次資料に当たって確定した（行番号は `90f5636f`）。

- `dispose`（`packages/server/src/ws-handler.ts:1084-1155`）のうち**処分の判断は `:1125-1147`**
  ——その 3 段ゲートと評価順序。
  とくに `removeViewer`（`:1090`）が `hasViewer`（`:1126`）より前に走ること、
  `releaseHolder`（`:1125`）がゲートの外であること、`abandoned`（`:1132`）が
  `releaseHolder` の**後**に評価されること。
- `holdForReconnect` の `false` が 3 通りを兼ねること（`session-manager.ts:1391-1394`）。
- `holdForReconnect` が表示セッション専用であること（`:1397` が `sessions` だけを引く）。
- `hasViewer` がプリンターを見ないこと（`:1299`）。
- 「見に来ただけ」と「持ち主」が排他であること（`ws-handler.ts:913-917` / `session-manager.ts:1368`）。
- `idleLimitOf` が設定値を書き換えず規則として重ねること（`session-manager.ts:1665-1674`）。
- `sweepIdle` が猶予中を素通しし、期限到来時は `reapHold` に通すこと（`:1686-1697`）。
- `startReconnect` の 4 門と、門より前の前処理（`session-controller.ts:275-316`）。
- 試行の新旧判定が 5 系統に分散していること（`research.md` F4）。
- `connected` の読み手 9 箇所・書き手 12 箇所（`research.md` Q3）。
- web-ui はテストも型検査され、server はされないこと（`research.md` F19）。
- ソース走査テストの前例（`packages/server/test/log-independence.test.ts` —
  `readFileSync` + `readdirSync` で `src` を舐め、不変条件を固定する形。`research.md` F20）。
  同種の前例が `hllapi-bridge-thinness.test.ts` / `hostserver/test/no-core-dependency.test.ts` /
  `ebcdic/test/catalog-no-tables.test.ts` にもある。
- CI が `lint` → `build` → `test` の 3 本を回すこと（`.github/workflows/ci.yml`。`research.md` F21）
  ——**どの手段を採っても PR で落ちる**。
- `packages/web-ui/tsconfig.test.json` が `composite: true` かつ `include: ["src", "test"]` で、
  `types` に `node` を足してテストにだけ Node の型を許していること（同ファイルの冒頭注記が
  「eslint は web-ui を対象外にしているため、この型の境界が src を守る唯一の仕組み」と明言）。
  **`include` の外のファイルを取り込めない**という方針5 の根拠はここ。
- **未確認**: `holderToken` が定義済みのまま `heldUntil` も立つ状態が実際に到達可能か
  （`research.md` の「未特定」）。**到達可能かに依らず結論が変わらない形**に畳むので、
  この設計は成立する（`disposition()` の `hold` 枝が `isHeld` を内側で見る）。

## インターフェース / データ構造

### サーバー: R1（持ち主）の定義

```ts
/**
 * 持ち主の状態（**R1 の定義**。持ち主に関する情報をここ以外に置かない）。
 * `ever` は「一度でも持ち主が付いたか」＝旧 `hadHolder`。一度 true になったら降りない。
 */
export type HolderState =
  | { readonly held: false; readonly ever: boolean }
  | { readonly held: true; readonly ever: true; readonly token: number };
```
`SessionEntry` / `PrinterEntry` は `holderToken?` / `hadHolder?` を捨て、`holder: HolderState` を持つ
（初期値 `{ held: false, ever: false }`）。

導出（いずれも既存の公開シグネチャを保つ）:
- `claim(id): number` — `holder = { held: true, token }`。**エントリが無くても番号は返す**（現行どおり）
- `releaseHolder(id, token): boolean` — 一致時だけ `{ held: false, ever: true }` にして `true`
- `hasHolder(id): boolean` — `holder.held`

### サーバー: R2（猶予）の定義

```ts
/** 猶予の状態（**R2 の定義**）。期限とタイマーは必ず同時に在る／同時に無い */
export type HoldState =
  | { readonly holding: false }
  | { readonly holding: true; readonly until: number; readonly timer: ReturnType<typeof setTimeout> };
```
`SessionEntry` は `heldUntil?` / `holdTimer?` を捨て、`hold: HoldState` を持つ（初期値 `{ holding: false }`）。

導出（公開シグネチャを保つ）: `holdForReconnect(id): boolean` / `cancelHold(id): void` /
`isHeld(id): boolean`（**期限切れは false** の現行仕様を維持）/ `reapHold(id)`（private）。

### サーバー: `disposition()`（R1 ＋ R2 からの導出。**唯一の後始末の口**）

```ts
/** 接続がセッションに対して持つ役割（**ws-handler 側の R1 の面**） */
export type ConnRole =
  | { readonly kind: "owner"; readonly token: number }  // open / resume 付き attach（claim 済み）
  | { readonly kind: "viewer" };                        // 見に来ただけの attach

/** 後始末で何が起きたか */
export type Disposition =
  | { readonly act: "keep"; readonly why: "viewer" | "otherViewers" | "resident" | "handedOver" }
  | { readonly act: "hold" }
  | { readonly act: "close" };

/**
 * **接続が去るときの処分を決め、実行する**（R1 / R2 の唯一の答え）。
 * 呼び出し側は結果を見て分岐しない——座を返す・猶予に入れる・閉じるはすべてこの中で起きる。
 */
disposition(id: string, ctx: { role: ConnRole; transportLost: boolean }): Disposition;
```

内部の順序は現行と同一（`research.md` F2）:
1. `role.kind === "owner"` なら `releaseHolder(id, role.token)` を**無条件に**打ち、`wasHolder` を得る
   （`viewer` は `claim` していないので常に `false`。現行と同値）
2. `role.kind === "viewer"` → `keep("viewer")`
3. `hasViewer(id)` → `keep("otherViewers")`
4. `isResident(id)` → `keep("resident")`
5. `!wasHolder && hasHolder(id)` → `keep("handedOver")`
6. `transportLost` → `holdForReconnect(id)`。入れたら `hold`。
   入れられず `isHeld(id)` でもない → `close`。`isHeld` なら `hold`（既に猶予中）
7. それ以外 → `close`

> **2〜4 の順序は現行の `!attached && !otherViewers && !isResident` と同値**（連言の短絡を
> 順に並べ替えただけ）。`why` を分けるのは、テストが「なぜ畳まなかったか」を assert できるようにするため。

**事前条件（呼び出し側の契約）: `disposition()` を呼ぶ前に、自分の購読をすべて外し終えていること。**
`hasViewer` が「自分以外」を意味するのはそのためで、現行も `detachScreen`（`ws-handler.ts:1090`）が
`removeViewer` を呼んでから `hasViewer`（`:1126`）を見ている。**この順序知識だけは呼び出し側に残る**
——viewer を減らすのは購読解除の一部であって処分の判断ではないため、`disposition()` の内側へは
移さない。契約は docstring に書き、組合せ表（AC4）の「他に viewer」列がこの順序を実地で固定する。

### サーバー: `lifetimeOf()`（R1 からの導出）

`private idleLimitOf(entry)` を **`private lifetimeOf(entry)`** に改名（backlog の呼び名に合わせる）。
中身は `holder` を読むように書き換えるだけで、規則は変えない:

| `holder` | 適用上限 |
|---|---|
| `{ held: false, ever: false }`（一度も `claim` されていない） | 設定値そのまま |
| `{ held: true, … }`（持ち主が居る） | 設定値そのまま |
| `{ held: false, ever: true }`（持ち主が去った） | `"never"` → 30 分 / 有限 → `min(設定, 30 分)` |

### クライアント: R3（繋ぎ直しの対象か）の定義

```ts
/** 繋ぎ直しの適性。**開いた時点で決まり、以後変わらない**（旧 kind / meta.terminal / attachedOnly） */
export type Resumability = "resumable" | "not-resumable";

/** サーバーとの結びつき（**R3 の定義**）。連結・再接続中・切断のいずれか 1 つ */
export type SessionLink =
  | { readonly state: "connected" }
  | { readonly state: "reconnecting"; readonly attempt: number; readonly max: number }
  | { readonly state: "lost"; readonly cause: LostCause };

/** 切断の理由。**上書きの優先度がある**（下記「振る舞いの詳細」） */
export type LostCause = "transport" | "hostEnded" | "gaveUp" | "gone";
```

`SessionState` は `connected` / `reconnect` / `reconnectFailed` / `attachedOnly` / `endedByHost` を
**保持フィールドとしては捨て**、`link: SessionLink` と `resumability: Resumability` を持つ。
**`attachedOnly` と `endedByHost` にはアクセサを用意しない**——読み手が
`startReconnect`（`:299` / `:305`）と `refuseIfDisconnected`（`:152`）の**3 箇所しかなく、
どれも今回の導出関数に畳まれる**（`research.md` Q3 の読み出し一覧）。表示側の読み手はゼロ。

`connected` / `reconnect` / `reconnectFailed` は表示側に読み手があるので、
**読み取り専用アクセサ**を同じ名前で残す:

```ts
get connected(): boolean            // link.state === "connected"
get reconnect(): { attempt; max } | undefined   // link.state === "reconnecting" のとき
get reconnectFailed(): "retry" | "gone" | undefined
  // link.state === "lost" && cause === "gaveUp" → "retry" / cause === "gone" → "gone" / それ以外 undefined
```

遷移関数（`stores/sessions.ts`。**`link` に書き込んでよい唯一の場所**）:
```ts
/** 連結した（繋ぎ直し成功・新画面の到着）。**無い id では何もしない** */
function markConnected(id: string): void;
/** 切断として記録する。**確定した理由（hostEnded / gone / gaveUp）は上書きしない** */
function markLost(id: string, cause: LostCause): void;
/**
 * 繋ぎ直しを始める / 次の段へ進む。**確定した理由を解く唯一の口**。
 * `link` は `{ state: "reconnecting", attempt: index + 1, max: RECONNECT_DELAYS_MS.length }`
 * ——現行の `session-controller.ts:328` と同じ組み立て。`max` は遅延表の長さ（5）。
 */
function beginReconnect(id: string, index: number): void;
```

**3 つとも `sessionId` を受ける**（`SessionState` ではなく）。現行の各書き込み箇所が
`if (!s) return` を持っている（`research.md` Q3）ので、**存在判定を関数の内側に置くほうが
呼び出し側に判断が残らない**。

**セッションを新しく開くときの初期値は、これらを通さずオブジェクトリテラルで
`link: { state: "connected" }` と書く**（`session-controller.ts:601` / `:710` / `:820`）。
遷移ではなく構築なので、AC2 の走査（`\.link\s*=` の代入）には当たらない。

導出関数（`session-controller.ts`）:
```ts
/**
 * 繋ぎ直してよいか（**R3 の唯一の答え**）。旧 startReconnect の 4 門。
 * **真偽ではなく理由を返す**——真偽だけだと、通知を出し分けたい呼び出し側が
 * `resumability` を読み直して門1 を再評価することになり、規則の外に写しが出る
 * （requirements AC1 が禁じる形。review ラウンド1 の must で修正）。
 */
type ResumeVerdict = { resume: true } | { resume: false; why: "notResumable" | "running" | "hostEnded" | "gone" };
function resumeVerdict(link: SessionLink, r: Resumability): ResumeVerdict;
/** ホストへ送ってよいか。false なら理由の文言も返す（旧 refuseIfDisconnected） */
function sendToHost(s: SessionState): { ok: true } | { ok: false; notice: string };
```

### クライアント: R4（この試行はまだ有効か）の定義

```ts
/** 繋ぎ直しの 1 試行（**R4 の定義**）。セッションごとに高々 1 つ */
interface Attempt {
  readonly seq: number;          // 単調増加。ログと突き合わせるため
  readonly client: WsClient;
  readonly index: number;        // RECONNECT_DELAYS_MS の何段目か
  timer: ReturnType<typeof setTimeout> | undefined;  // 待ち中のみ
  settled: boolean;              // この試行の後始末が済んだか
}
const attempts = new Map<string, Attempt>();

/** この試行がいまも代表か（**R4 の唯一の答え**） */
function isCurrentAttempt(sessionId: string, a: Attempt): boolean;
```
`research.md` F4 が挙げたクライアントの **5 系統のうち 4 つ**——`settled` / `pendingResumes` /
`reconnectTimers` / `s.reconnect`——がここに畳まれる。残る 1 つ（`:450` の
`sessionsStore.get(id)?.client === client`）は畳まない（下記）。`ws-client` の 2 つは別レイヤ。

> **`sessionsStore.get(id)?.client === client`（`:450`）と `ws-client` の `ws !== this.ws`（`:113`）は
> 畳まない。** これらは「試行が有効か」ではなく「**この口がいま現役か**」を問うており、
> それぞれ既に 1 か所にある。混ぜると、成功した試行が退役したあとの `onClose` を
> 区別できなくなる（現行が `startReconnect` を回し直す唯一の経路）。

## 振る舞いの詳細

### 切断理由の上書き規則（**現行の暗黙の規則を明示化する**）

現行は `connected` と `endedByHost` / `reconnectFailed` が**別フィールド**なので、
`startReconnect` 冒頭の `connected = false`（`:282`）が理由を消さない。union に畳むと
消えてしまうため、**優先度を持つ遷移関数**で同じ結果にする:

```ts
/** 切断として記録する。**確定した理由は上書きしない** */
function markLost(s: SessionState, cause: LostCause): void
```
- **`hostEnded` / `gone` / `gaveUp` の 3 つは確定**——既に立っていれば `transport` で上書きしない。
  現行の `connected = false`（`session-controller.ts:282`）が `endedByHost` も `reconnectFailed` も
  消さないことと同値。
- 確定した理由を解くのは **`beginReconnect` だけ**（`link` を `reconnecting` にする）。
  現行の `delete s.reconnectFailed`（`:314`）が**門を通過した後**に置かれているのと同じ位置で、
  `markLost` では解かない。
- **逆方向（理由を記録すると `connected` が偽になる）も現行と同値。** `endedByHost = true` を
  立てる `:558` の**直前**（`:551`）が既に `connected = false` にしているので、
  `markLost(id, "hostEnded")` が両方を一度に行っても結果は変わらない。

対応表（現行 → 畳み込み後。**結果が同じであることがこの表の主張**）:

**行番号の無印は `packages/web-ui/src/session-controller.ts`**（`sessions.ts` のみ明示）。
`connected` の書き込み **12 箇所すべて**（`research.md` Q3）に加え、`endedByHost` /
`reconnect` / `reconnectFailed` への書き込みも同じ表に写している。
うち 3 件（`:601` / `:710` / `:820`）は**構築時のリテラル**で、遷移関数を通さない。

| 現行 | 畳み込み後 |
|---|---|
| `:282` `startReconnect` 冒頭の `connected = false` | `markLost(id, "transport")` |
| `:551` 5250 の `closed` で `connected = false` | `markLost(id, "transport")` |
| `:558` `msg.ended === true` で `endedByHost = true` | `markLost(id, "hostEnded")` |
| `:314` `delete reconnectFailed` ＋ `:328` `reconnect = {…}` | `beginReconnect(id, index)` → `link = reconnecting` |
| `:349-352` `delete reconnect` ＋ `reconnectFailed = reason` ＋ `connected = false` | `markLost(id, reason === "retry" ? "gaveUp" : "gone")` |
| `:399-401` 繋ぎ直し成功時の `connected = true` ＋ 2 つの delete | `markConnected(id)` |
| `stores/sessions.ts:318` `updateScreen` の `connected = true` | `markConnected(id)` |
| `:601`（5250/3270）/ `:710`（VT）/ `:820`（プリンター）初期 `connected: true` | `link: { state: "connected" }` |
| `:737` / `:763` VT の `connected = false` | `markLost(id, "transport")` |
| `:906` / `:932` プリンターの `connected = false` | `markLost(id, "transport")` |

**いずれも `session-controller.ts` と `stores/sessions.ts` の中**で、
「触らない」と宣言した `.vue` / `macro-engine.ts` / `composables/` には 1 件も無い
（`research.md` Q3 の書き込み一覧がこの 12 箇所で閉じている）。

### `resumable()` の内訳（現行 4 門と 1:1）

| 現行の門 | 畳み込み後 |
|---|---|
| `:299` `kind === "printer" \|\| meta.terminal === "3270" \|\| attachedOnly` | `s.resumability === "not-resumable"` |
| `:305` `endedByHost` | `link.state === "lost" && link.cause === "hostEnded"` |
| `:308` `reconnectFailed === "gone"` | `link.state === "lost" && link.cause === "gone"` |
| `:312` `reconnect !== undefined` | `link.state === "reconnecting"` |

`resumability` は開く時点で決める（`:612` の `attachedOnly` 設定・`:816` の `kind` 設定・
`meta.terminal` の判定と同じ入力）。**門1 が `MSG_CONNECTION_LOST` を出して門2〜4 は黙る**という
現行の差（`research.md` F3）は、`startReconnect` 側に残す（`resumable()` は真偽だけを答える）。

### `sendToHost()` の内訳（現行 `refuseIfDisconnected` と 1:1）

現行は `session-controller.ts:143-155`。読み手は 5 箇所（`:956` / `:1033` / `:1087` / `:1114` /
`:1133`。`research.md` A10）。

| 現行 | 畳み込み後 |
|---|---|
| `:144` `s.connected` が真なら通す | `link.state === "connected"` なら `{ ok: true }` |
| `:152` `endedByHost ? MSG_SESSION_ENDED : MSG_NOT_CONNECTED` | `link.state === "lost" && cause === "hostEnded"` で出し分け |
| `:151` **`notice` が空のときだけ書く** | `sendToHost()` は文言を**返すだけ**。書くかどうかは現行どおり呼び出し側が `notice === undefined` で判断する |

**`:151` の「空のときだけ書く」を導出関数に取り込まない**——`notice` の扱いは 3 通り混在しており
（`research.md` 実現性 / リスク）、一様化は振る舞いの変更になる。

### `disposition()` の呼び出し（`ws-handler.dispose`）

```ts
// 変更前: 処分の判断 20 行（:1125-1147 の 3 段ゲート）
// 変更後:
if (this.link !== undefined) {
  this.deps.sessions.disposition(this.link.id, {
    role: this.link.role,
    transportLost: opts?.transportLost === true
  });
  this.link = undefined;
}
```
`ws-handler` の `sessionId` / `attached` / `holderToken` の 3 フィールドは
`private link: { id: string; role: ConnRole } | undefined` 1 つに畳む。
**`this.sessionId` の参照 20 箇所は `this.link?.id` への読み替えに留める**（意味は変えない）。
件数は本 work の design 工程で実測（`grep -c "this\.sessionId" packages/server/src/ws-handler.ts`）
——`research.md` には載っていない。

### 変えない振る舞い（表の主張）

`research.md` Q4 の全組合せを、そのまま `session-lifetime-matrix.ts` の期待値にする。
**畳み込みの前にこの表を書き、緑にしてから畳む**（AC4）。

## ドメイン固有の考慮

- `AGENTS.md` の規約に従い、**日本語のコメントで「なぜ」を書く**。畳んだ各定義には、
  引き継いだ判断（前 work の D4 / D5 / D7 / D10 / D12 / D13）への参照を残す（AC7）。
- **ピュアロジック層の Node API 禁止**（`eslint.config.js`）は `packages/server` / `packages/web-ui`
  には掛かっていない。今回の変更はどちらもその外なので影響しない。
- `no-console` が効くのは**サーバー側の走査テストだけ**——`packages/web-ui/**` は eslint の
  対象外（`research.md` F18）。どちらにも `console.*` を書かない（規約は eslint の
  対象範囲より広い）。

## エラー処理 / 異常系

- `disposition()` は**例外を投げない**。`close()` の失敗は現行どおり握り潰す
  （`ws-handler.ts:1142` の `.catch(() => {})` を `disposition` の内側へ移す）。
- **存在しない id を渡された `disposition()`**: `keep` に落ちる枝（`viewer` / `handedOver`）は
  何もしない。`close` に落ちた枝だけが `close()` を試み、`SESSION_NOT_FOUND` を握り潰す
  ——現行の `ws-handler.ts:1142` / `:1145` の `.catch(() => {})` と同値。
  `hasViewer` / `isResident` / `hasHolder` はいずれも未知の id で `false` を返すので、
  分岐の結論も現行と変わらない（`research.md` Q2）。
- `markConnected` / `markLost` / `beginReconnect` は**存在しない id では何もしない**
  （現行の各書き込み箇所の `if (!s) return` と同値。だから `SessionState` ではなく id を受ける）。
- `link` が `undefined` の `ws-handler`（open 前に切れた接続）は `disposition` を呼ばない
  （現行の `if (this.sessionId)` と同値）。

## 受け入れ基準との対応

- AC1: R1 = `SessionEntry.holder`（`HolderState`）、R2 = `SessionEntry.hold`（`HoldState`）、
  R3 = `SessionState.link`（`SessionLink`）＋ `resumability`、R4 = `attempts` の `Attempt`。
  **規則の答えを返す導出は `disposition()` / `lifetimeOf()` / `resumable()` / `sendToHost()` /
  `isCurrentAttempt()` の 5 つ**。これに加えて既存の公開メソッド 6 つ
  （`claim` / `releaseHolder` / `hasHolder` / `holdForReconnect` / `isHeld` / `cancelHold`）も
  **同じ定義からの導出として残る**——消さないのは AC6 の理由による（`research.md` F19）。
  「1 つだけ」と数えるのは**定義**であって導出の数ではない（`requirements.md` 背景）。
  戻り値はすべて union か真偽で、呼び出し側は組み立て直せない。
  **入力の出所**: 上記「インターフェース / データ構造」。
- AC2: 対象集合は方針4 で絞った版（14 個）。**内訳と、それぞれをどう固定するか**:
  - `holderToken` / `hadHolder` → `HolderState` に畳まれ**消える**（走査で 0 件を固定）
  - `heldUntil` / `holdTimer` → `HoldState` に畳まれ**消える**（同上）
  - `holder` / `hold`（新しい定義そのもの）/ `viewers` / `resident` →
    **`session-manager.ts` の外に出現しない**ことを走査で固定
  - `attached` → `ConnRole` に畳まれ、`ws-handler.ts` から**消える**（走査で 0 件）
  - `attachedOnly` / `endedByHost` / `reconnectFailed` / `reconnect`（保持値）→
    `SessionLink` に畳まれ**消える**（走査で 0 件。アクセサ名としての `reconnect` /
    `reconnectFailed` は `stores/sessions.ts` の定義内のみ）
  - `resumability` → `session-controller.ts` の `resumable()` の外で読まれないことを走査で固定
  - `settled` / `pendingResumes` / `reconnectTimers` → `Attempt` に畳まれ**消える**（走査で 0 件）
  手段は**走査テスト 2 本＋型による封じ込め**（下記 AC2 の詳細）。
  **入力の出所**: `research.md` F18〜F21。
- AC3: 既存テストは呼び出しの形だけ追随させる。
  **`packages/web-ui/test/tab-visibility.test.ts` は AC3 の判定から除く**——並列実行時に
  5 秒タイムアウトで落ちる既存フレークとして `.aidev/backlog/session-lifecycle.md` の 4 件目に
  起票済みで、本 work の対象範囲（セッション寿命の判定）に一切触れないため。
  除外の事実と再現条件は `test-result.md` に残す。
  **入力の出所**: `research.md` F14 / F16（既存テストの所在）、`requirements.md` スコープ対象外。
- AC4: `session-lifetime-matrix.ts` に `research.md` Q4 の表をそのまま書き、
  両側のテストがそこから回る。**入力の出所**: `research.md` Q4。
- AC5: **4 規則の定義の読み取りに 1 つずつ変異を注入する**——R1: `holder.held` を常に `true` として
  読む／R2: `hold.holding` を反転して読む／R3: `link.state` を常に `"lost"`、`resumability` を常に
  `"resumable"` として読む／R4: `Attempt.settled` を常に `false` として読む。
  **導出関数の戻り値を差し替えるのではなく、定義を読む所を壊す**——導出を潰すと
  「その導出を使っていない経路」が見えないままになる。
  **入力の出所**: 上記 4 定義（`HolderState` / `HoldState` / `SessionLink`＋`Resumability` / `Attempt`）。
- AC6: `SessionManager` の公開メソッドは 1 つも消さない・シグネチャを変えない。
  対象は `research.md` A3 / A4 が挙げた `claim` / `releaseHolder` / `hasHolder` /
  `holdForReconnect` / `cancelHold` / `isHeld` / `hasViewer` / `addViewer` / `removeViewer` /
  `isResident` / `close` / `touch`。`WsOpen` / `WsClosed` のメッセージ定義にも触らない
  （前 work が足した `WsOpen.resume` を含む。`requirements.md` スコープ対象外）。
  **消さない理由の出所**: `research.md` F19（サーバーのテストは型検査されないので、
  消すと実行時にしか壊れない）。
- AC7: 各定義の docstring に D4 / D5 / D7 / D10 / D12 / D13 への参照を書く。
  **入力の出所**: 前 work の `decisions.md`。
- AC8: deliver で `.aidev/backlog/session-lifecycle.md` の 1・2 件目を `[x]` にする。
  **入力の出所**: `state.yml` の `backlog:`。

### AC2 の詳細（手段の確定）

**走査が守らない範囲**（review ラウンド1 の指摘で明記。US3「写しが増えたら CI が落ちる」は
次の 3 つには効かない）:

1. **同一ファイル内の再計算**。走査は `session-manager.ts` を丸ごと「内側」に置くので、
   同じ規則の答えをファイル内で組み立て直しても落ちない。実際 D19 の 2 件を見つけたのは CI ではなく
   `cross` 点検で、**同じ写しが再発しても CI は落ちない**。
2. **分割代入**（`const { hold } = e`）。ドットで固定しているサーバー側 3 本を素通りする。
3. **`link` の読み**。クライアントは `.link =`（代入）だけを見るので、別モジュールが
   `s.link.state` を読んで 2 本目の門を作っても止まらない（書き込みは型で塞いであるが、
   読みは表示側にも要るので塞げない）。

1 は「規則の定義をファイルごと分ける」という architecture A1 の粒度そのものに由来するので、
本 work の手段では塞げない。**follow-up として backlog へ回す**（T14）。

| 側 | 手段 | 根拠 |
|---|---|---|
| サーバー | **走査テスト**（`packages/server/test/lifetime-flag-containment.test.ts`）。`src/**/*.ts` を読み、**消えるもの**（`holderToken` / `hadHolder` / `heldUntil` / `holdTimer`）は**全ファイルで 0 件**、**残るもの**（`\.holder\b` / `\.hold\b` / `\.viewers\b` / `\.resident\b`）は**`session-manager.ts` 以外で 0 件**、`attached` は **`ws-handler.ts` で 0 件**を固定する | 前例 `log-independence.test.ts`。lint は使えるが、走査テストなら両側で同じ形にできる |
| クライアント | **型による封じ込め**（`connected` / `reconnect` / `reconnectFailed` を getter 化 → 書き込みが型エラー）＋ **走査テスト**（`packages/web-ui/test/lifetime-flag-containment.test.ts`。`attachedOnly` / `endedByHost` / `settled` / `pendingResumes` / `reconnectTimers` が `src` に 0 件／`\.link\s*=` が `stores/sessions.ts` 以外に無い／`resumability` が `session-controller.ts` の外で読まれない） | web-ui はテストまで型検査される（F19）。eslint は効かない（F18）ので、**lint ではなく走査テストで固定する** |

**件数を数えるのではなく「特定ファイル以外での出現が 0」を固定する**——件数固定は無関係な
変更でも落ち、やがて数字を上げるだけの作業になる（requirements の未確定事項の判断）。

## 未確定のまま design を抜けるもの

- **解消済み**: `session-lifetime-matrix.ts` の越境 import は成立する。design 工程で実地に確かめた
  ——`packages/server/test/` から `import { … } from "../../web-ui/test/<name>.js"` を書き、
  `npx vitest run --root packages/server` が緑（`tsconfig` の変更は不要）。
  指定は**拡張子 `.js`**（この PJ の ESM 記法どおり。vitest が `.ts` に解決する）。
- **残る未確定は無い。**
