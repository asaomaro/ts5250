# 調査: セッション寿命の 4 規則の現行実装と、変えてはいけない振る舞い

**この文書は変更前のスナップショットである。** 「判明した事実 / 実装アンカー」は現状、
「design への申し送り」は変更後の想定で、混ぜていない。行番号は `90f5636f`（main）時点。

## 調査の問い

- Q1: サーバーで「畳む / 畳まない」を判断している箇所はどこか。何を読んで何を結論するか。
- Q2: クライアントで「繋ぎ直すか」「この試行はまだ有効か」を判断している箇所はどこか。
- Q3: 端末種別（5250 / 3270 / VT / プリンター）で扱いがどう違うか。
- Q4: **端末種別 × 切れ方 × viewer × 持ち主の全組合せで、現行の結論は何か**（AC4 の表の入力）。
- Q5: アイドル掃除が効く条件と、実際の定数値。
- Q6: 既存テストがどの組合せを固定しており、どこが穴か。
- Q7: AC2（判定の写しが増えたら CI が落ちる）を、この PJ の仕組みで実現できるか。

## 判明した事実

### 構造（Q1 / Q2）

- **F1: サーバーの判断本体は `ws-handler.dispose` 1 箇所で、入口が 4 つある。**
  `close` メッセージ（`ws-handler.ts:227`、`transportLost` なし）/ `onSocketClose`（`:256-260`、
  `transportLost: true`）/ ハートビート死判定（`:452-461`、`transportLost: true` ＋直後に `ws.close()`）/
  ホスト終了（**`dispose` を通らない**。F9）。
- **F2: `dispose` のゲートは 3 段で、読む順序に意味がある**（`ws-handler.ts:1084-1155`）。
  1. `detachScreen`（`:1090`）が `removeViewer` を呼ぶ。**以降の `hasViewer` は「自分以外」を意味する**。
  2. `:1125` `wasHolder = releaseHolder(...)` を**ゲートの外で無条件に**打つ（座は必ず返す）。
  3. `:1127` ゲート1 `!attached && !otherViewers && !isResident` — 偽なら**何もしない**。
  4. `:1132-1134` ゲート2 `!wasHolder && !abandoned`（交代済みで後任在席）→ **何もしない**。
     `abandoned` は `releaseHolder` の**後**に評価するので、`wasHolder === true` なら必ず `abandoned === true`。
  5. `:1135-1146` ゲート3 `transportLost` → `holdForReconnect`。
     **`!held && !isHeld()` のときだけ** `close()`。それ以外（利用者の `close`）は即 `close()`。
- **F3: クライアントの「繋ぎ直すか」は `startReconnect` の 4 門**（`session-controller.ts:275-316`）。
  門より**前**に `setBusy(false)`（`:281`）/ `connected = false`（`:282`）/ `delete notice`（`:286`）を必ず通す。
  門1 `kind==="printer" || meta.terminal==="3270" || attachedOnly`（`:299`）→ `MSG_CONNECTION_LOST` を出して return。
  門2 `endedByHost`（`:305`）→ **黙って** return。門3 `reconnectFailed==="gone"`（`:308`）→ return。
  門4 `reconnect !== undefined`（`:312`）→ return（二重起動防止）。
- **F4: 「この試行はまだ有効か」は 5 系統に分散している**（backlog が「4 規則」と呼んだ R4 の実体）。
  (1) `settled`（試行ローカル。`:359` 宣言、`:361/:369/:384/:427/:444/:459` で参照）、
  (2) `pendingResumes.get(id)?.client === client`（`:364` / `:384` / `:440`。とくに `:440` は
  `screen` が `updateScreen` 経由で `connected=true` を立てるのを防ぐ）、
  (3) `sessionsStore.get(id)?.client === client`（`:450`）、
  (4) `reconnectTimers` の Map（`:333` set / `:330` delete / `:240-246` clear）、
  (5) `s.reconnect` の有無（`:312`）。
  さらに `ws-client` 側にも 2 つある——`notifyClosed` の `ws !== this.ws || this.closeNotified`
  （`ws-client.ts:113`）と、`armPingWatchdog` が見張り対象のソケットを掴む形（`:159-174`）。
  **どれを畳んでも、他が単独では守れない。**

### 端末種別（Q3）

- **F5: 5250 表示とプリンターは同じ `sessionId` に載る**（`ws-handler.ts:497` / `784` / `908`）。
  3270 は `session3270`（`:560`）、VT は `sessionVt`（`:610`）に載り、`dispose` では
  **条件を一切見ずに常に閉じる**（`:1097-1109`）。
- **F6: プリンターは `viewers` を数えない。** `hasViewer` は `sessions` しか見ない
  （`session-manager.ts:1299`）ので、プリンター id では**常に `false`**。`addViewer`/`removeViewer` も同様。
  したがってプリンターに「他に viewer」の軸は存在せず、2 タブで開くのは**持ち主の交代**として現れる。
- **F7: `holdForReconnect` は表示セッション専用**（`session-manager.ts:1397` が `sessions` だけを引く）。
  よって**非常駐プリンターは転送断でも猶予に入らず即 close**、常駐プリンターはゲート1 の
  `isResident` で落ちて**何もしない**。
- **F8: 「見に来ただけ」と「持ち主」は排他。** `attach` の `resume` 無し枝は `claim` を呼ばない
  （`ws-handler.ts:913-917`）ので `holderToken` は常に `undefined` になり、`releaseHolder` は
  `token === undefined` で必ず `false`（`session-manager.ts:1368`）。
  逆に `attached === false` かつ `holderToken === undefined` も起こらない
  （open 系 3 経路がすべて `claim` する。`ws-handler.ts:498` / `785` / `914`）。
- **F9: ホスト終了は `dispose` を通らない別経路。** 5250 は `SessionManager` 自身が
  エントリを削除し `holdTimer` も落とす（`session-manager.ts:731-736`）。ws は
  `closed { ended: true }` を送る（`ws-handler.ts:861-866`）。**viewer・持ち主に依らない。**
  VT も同様（`vt-manager.ts:102-106` → `ws-handler.ts:631`）。
  **3270 だけは購読自体が無い**（`tn3270-manager.ts` は `session.on("screen")` のみ。`:78`）ので、
  エントリが残りブラウザにも `ended` が届かない。プリンターは常駐なら張り直し、
  非常駐なら `state="error"`——**どちらも `printers` からは消さない**（`session-manager.ts:987-999`）。

### 定数と掃除（Q5）

- **F10**: `ORPHAN_IDLE_TIMEOUT_MS = 30 分`（`session-manager.ts:83`）、
  `DEFAULT_RECONNECT_GRACE_MS = 90 秒`（`:105`）、マネージャ既定 `idleTimeoutMs = "never"`（`:638`）、
  掃除間隔 60 秒（`:648`、`main.ts:229` で起動）。
  クライアント側は `PING_DEAD_MS = 90 秒`（`ws-client.ts:44`）、`CLOSE_EVENT_GRACE_MS = 3 秒`（`:53`）、
  `RECONNECT_DELAYS_MS = [1,2,4,8,16] 秒`（`session-controller.ts:201`）、ジッター ±20%（`:209-211`）、
  `RESUME_ATTEMPT_TIMEOUT_MS = 10 秒`（`:221`）。最悪の壁時計 37.2 + 50 = 87.2 秒 < 猶予 90 秒。
- **F11: `sweepIdle` は猶予中を素通しする**（`session-manager.ts:1686-1697`）。
  `heldUntil !== undefined` なら、期限が来ていれば `reapHold`、来ていなければ `continue`
  ——**アイドル上限は一切当たらない**。期限到来時の畳み方はタイマー経路（`:1405`）と
  同じ `reapHold` に通る（結論が経路で割れないようにしてある）。
- **F12: `idleLimitOf` は設定値を書き換えず、規則として重ねる**（`session-manager.ts:1665-1674`）。
  `hadHolder !== true`（一度も `claim` されていない＝MCP / HLLAPI 由来）または
  `holderToken !== undefined`（持ち主が居る）なら設定値そのまま。持ち主が去った場合だけ
  `"never"` → 30 分、有限値 → `min(設定, 30 分)`。`hadHolder` は一度立つと降りない（`:1350`）。
- **F13: プリンターは `idleLimitOf` を通らない**（`session-manager.ts:1705-1717`）。
  常駐は無条件スキップ、非常駐は設定値のみ。**持ち主不在 30 分の上限はプリンターに掛からない。**

### Q4: 全組合せの現行結論（**AC4 の表の入力。これを変えてはいけない**）

「役割」は F8 より 4 通りに畳める。切れ方は (a) `close` メッセージ /
(b) 転送断（`onSocketClose`）/ (c) 心拍死判定 / (d) ホスト終了。
**(b) と (c) は `dispose` に同じ引数を渡す**ので結論は同一（経路は別）。

#### 5250 表示セッション（サーバー）

| # | 役割 | 他に viewer | (a) close | (b) 転送断 | (c) 心拍死 | (d) ホスト終了 |
|---|---|---|---|---|---|---|
| 1 | 現在の持ち主 | なし | **即 close**（`:1145`） | **90 秒猶予**（`:1140`） | (b) と同一 | エントリ削除＋`ended:true`（F9） |
| 2 | 現在の持ち主 | あり | **何もしない**（ゲート1） | 何もしない | 何もしない | 同上 |
| 3 | 交代済み・後任在席 | なし | **何もしない**（ゲート2） | 何もしない | 何もしない | 同上 |
| 4 | 交代済み・後任在席 | あり | **何もしない**（ゲート1 が先） | 何もしない | 何もしない | 同上 |
| 5 | 交代済み・持ち主不在 | なし | **即 close**（`:1145`） | **90 秒猶予**（`:1140`） | (b) と同一 | 同上 |
| 6 | 交代済み・持ち主不在 | あり | **何もしない**（ゲート1） | 何もしない | 何もしない | 同上 |
| 7 | 見に来ただけ（attached） | なし | **何もしない** | 何もしない | 何もしない | 同上 |
| 8 | 見に来ただけ | あり | **何もしない** | 何もしない | 何もしない | 同上 |

- **起こり得ない**: 「見に来ただけ × 持ち主」と「attached=false × 持ち主なし」（F8）。
- `reconnectGraceMs <= 0` の設定では #1 / #5 の (b)(c) が**即 close** になる（`:1141-1143`）。

#### プリンター（サーバー。viewer の軸は存在しない。F6）

| 役割 | (a) close | (b) 転送断 | (c) 心拍死 | (d) ホスト終了 |
|---|---|---|---|---|
| 非常駐・現在の持ち主 | 即 close | **即 close**（猶予対象外。F7） | (b) と同一 | エントリは残り `state="error"` |
| 非常駐・交代済み・後任在席 | 何もしない | 何もしない | 何もしない | 同上 |
| 非常駐・交代済み・持ち主不在 | 即 close | 即 close | 同左 | 同上 |
| 常駐（役割を問わず） | **何もしない**（`isResident`） | 何もしない | 何もしない | 張り直す |

#### 3270 / VT（サーバー）

(a)(b)(c) いずれでも、viewer・持ち主に関係なく**常に閉じる**（`ws-handler.ts:1099` / `:1107`）。
(d) は VT のみエントリ削除＋`ended:true`、**3270 は何も起きない**（F9）。

#### クライアント（端末種別 × 切れ方）

| 種別 | WS が閉じたときの入口 | 繋ぎ直し | 表示 |
|---|---|---|---|
| 5250 表示 | `openSession` の `onClose`（`:659-661`）→ `startReconnect` | **対象**（4 門を通過） | OIA「再接続中 (n/5)」 |
| 3270 | 同じ `onClose` → `startReconnect` | **門1 で対象外** | `MSG_CONNECTION_LOST` |
| 見に来ただけのタブ（attachedOnly） | 同上 | **門1 で対象外** | `MSG_CONNECTION_LOST` |
| ホストが終了（endedByHost） | 同上 | **門2 で対象外** | 黙る（次の打鍵で `MSG_SESSION_ENDED`） |
| 諦め済み（gone） | 同上 | **門3 で対象外** | 既存の理由を保つ |
| VT | 専用 `onClose`（`:760-766`）。**`startReconnect` を呼ばない** | 対象外 | `closeReason` を優先、無ければ `MSG_VT_CONNECTION_LOST` |
| プリンター | 専用 `onClose`（`:929-934`） | 対象外（門1 は保険） | `notice` を書くが `PrinterPane` は描いていない |
| 監視コンソール | `onClose` を渡していない（`stores/watches.ts:142`） | 対象外。**ping 見張りも張られない**（`ws-client.ts:160`） | — |

### Q6: 既存テストが固定している範囲と穴

- **F14: サーバー側で既に固定されている主なもの**——#1 の (a)(b)（`ws-handler.test.ts:74-99`）、
  #1 の (c)（`ws-lifetime.test.ts:170-192`）、#2（`ws-reconnect-resume.test.ts:266-273`）、
  #5 の (a)（`:206-217`）、#7（`session-attach.test.ts:108-119`）、
  プリンターの交代済み・後任在席（`ws-reconnect-resume.test.ts:178-191`）、
  非常駐プリンターの転送断（`:249-255`）、`reconnectGraceMs: 0`（`session-attach.test.ts:149-155`）、
  `holdForReconnect` / `claim` / `releaseHolder` / `idleLimitOf` の単体規則
  （`session-reconnect-grace.test.ts:39-357`）。
- **F15: サーバー側の穴**——(1) 常駐プリンター × `dispose`（寿命としては未固定）、
  (2) **#5 の (b)(c)**（古い接続が最後の 1 人として猶予に入れる枝）、
  (3) **#3 を viewer 無しで作る形**（既存 `:193-204` は viewers が先に効くとテスト自身が書いている）、
  (4) 心拍死判定 × viewer 有り／交代済み、(5) 3270 / VT の `dispose` が常に閉じること、
  (6) プリンターに 30 分上限が掛からないこと、(7) `close` メッセージ後の二重 `dispose`、
  (8) ホスト終了でエントリが消えること（`session-manager.ts:731-736`）。
- **F16: クライアント側で既に固定されている主なもの**——`session-reconnect.test.ts` が
  5 段のはしご・`resume:true` の送出・口の差し替え・**`edits` を捨てる**（`:149-163`）・
  `"gone"` で入り直さない・10 秒打ち切り・3270（`:326-343`）・attachedOnly（`:351-366`）・
  endedByHost（`:372-381`）・打ち切った試行の `screen` を弾く（`:453-464`）を押さえている。
  ping 見張りは `ws-ping-watchdog.test.ts` が 6 ケース。
- **F17: クライアント側の穴**——(1) **プリンターの切断**（`kind:"printer"` に `onClose` を打つ
  テストが 1 件も無い）、(2) **VT の切断**（`:760-766` を通すテストが無い）、
  (3) 古い試行からの `opened` / `error`（`:384` / `:427` のガード）、
  (4) 待ちタイマー中の二重 `onClose`、(5) `retryReconnect` が `"gone"` を素通りできること、
  (6) `ws-client` の古いソケット判定（`:113`）——`FakeSocket` が単一インスタンス固定で構造的に叩けない。

### Q7: AC2 を実現する仕組み（この PJ にあるもの）

- **F18: eslint は `packages/web-ui/**` を対象外にしている**（`eslint.config.js` の `ignores`）。
  **lint ルールによる封じ込めはサーバー側にしか効かない。**
- **F19: 型の境界は両側で効くが、強さが違う。**
  - `packages/server/tsconfig.json` の `include` は **`["src"]` のみ**——**テストは型検査されない**。
    `ws-printer-report-history.test.ts:94,141` が `private dispose()` を外から呼んでいてもビルドが通る。
  - `packages/web-ui` は `tsconfig.test.json` が `src` と `test` の両方を含み、
    `npm run typecheck`（`vue-tsc -b tsconfig.json tsconfig.test.json`）が**テストも型検査する**。
    同ファイルの注記が「eslint は web-ui を対象外にしているため、この型の境界が src を守る唯一の仕組み」と明言している。
- **F20: ソースを走査するテストの前例が複数ある**（`server/test/log-independence.test.ts` /
  `hllapi-bridge-thinness.test.ts` / `hostserver/test/no-core-dependency.test.ts` /
  `ebcdic/test/catalog-no-tables.test.ts`）。`log-independence.test.ts` は
  「ロガーが正しいことしか見ていない → 各ファイルが実際にどちらを import しているかを検査する」
  という**この work とまったく同じ形**の不変条件を、`readFileSync` + `readdirSync` で固定している。
  web-ui 側にもソース宣言を読むテストの前例がある（`tsconfig.test.json` の注記）。
- **F21: CI は `lint` → `build` → `test` の 3 本**（`.github/workflows/ci.yml`）。
  どの手段を採っても CI で落ちる。Rust（`crates/hllapi`）は対象外。

## 影響範囲

- `packages/server/src/session-manager.ts`（型定義・`claim` 系・猶予系・`idleLimitOf` / `sweepIdle`）
- `packages/server/src/ws-handler.ts`（`dispose` と 4 つの入口、`attached` / `holderToken`）
- `packages/web-ui/src/session-controller.ts`（`startReconnect` / `scheduleReconnect` / `tryResume` /
  `giveUpReconnect` / `abortReconnect` / `retryReconnect` / `refuseIfDisconnected`）
- `packages/web-ui/src/stores/sessions.ts`（`SessionState` の 6 フィールド）
- `packages/web-ui/src/ws-client.ts`（新旧ソケット判定・ping 見張り）
- **読み手として波及**: `StatusBar.vue`（`reconnect` / `reconnectFailed` / `connected`）、
  `EmulatorPane.vue`（`busy` / `loading` / `notice`）、`App.vue` / `SessionInfo.vue` /
  `PaneTabs.vue` / `WorkspaceNode.vue`（`connected` / `kind` / `meta.terminal`）。
  **これらは表示側なので、導出関数を足しても読む値の意味が変わらない限り触らなくてよい。**

## 実現性 / リスク

- **実現できる。** 判定はいずれも定数回の分岐で、外部依存も非同期の追加も要らない。
- **最大のリスクは「テストが型検査されないサーバー側」**（F19）。`dispose` の名前・シグネチャや
  `SessionManager` の公開メソッドを変えると、**実行時にしか壊れない**。
  → 公開メソッドの互換を保つ（AC6）ことがリスク低減そのものになっている。
- **次のリスクは R4 の 5 系統**（F4）。1 つに畳むと、いま偶然守れている経路
  （とくに `:440` の「代表している試行か」）が抜けやすい。**畳む前に穴（F17-(3)(4)）を
  テストで埋めてから触る**のが安全。
- 副次的リスク: `notice` の扱いが 3 通り混在している（`refuseIfDisconnected` は空のときだけ書く
  `:151` / `giveUpReconnect` は無条件上書き `:352` / `startReconnect` と `closed` は無条件削除
  `:286` `:553`）。R3 を畳むときに一様化したくなるが、**それは振る舞いの変更**なので触らない。

## 実装アンカー

- A1: サーバーの判断本体（`packages/server/src/ws-handler.ts:1084-1155` `dispose`）— 3 段のゲート。
- A2: `dispose` の入口 4 つ（`ws-handler.ts:227` / `:256-260` / `:452-461` / F9 のホスト終了経路）。
- A3: 持ち主の印（`packages/server/src/session-manager.ts:1342-1378` `claim` / `releaseHolder` / `hasHolder`）
  と、その保持先 `holderToken` / `hadHolder`（`:273` / `:445`、`ws-handler.ts:153`）。
- A4: 猶予（`session-manager.ts:1395-1452` `holdForReconnect` / `reapHold` / `cancelHold` / `isHeld`）と
  保持先 `heldUntil` / `holdTimer`。
- A5: 寿命の規則（`session-manager.ts:1665-1674` `idleLimitOf`）と掃除（`:1676-1718` `sweepIdle`）。
- A6: `attached` の唯一の設定箇所（`ws-handler.ts:916`）と `claim` の 3 箇所（`:498` / `:785` / `:914`）。
- A7: クライアントの門（`packages/web-ui/src/session-controller.ts:275-316` `startReconnect`）。
- A8: 試行の新旧判定 5 系統（`session-controller.ts:359` `settled` / `:364,384,440` `pendingResumes` /
  `:450` `sessionsStore.client` / `:240-246,330,333` `reconnectTimers` / `:312` `s.reconnect`）。
- A9: `SessionState` の定義（`packages/web-ui/src/stores/sessions.ts:102-193`）。
- A10: 送信可否（`session-controller.ts:143-155` `refuseIfDisconnected`）と、読む 5 箇所
  （`:956` / `:1033` / `:1087` / `:1114` / `:1133`）。
- A11: ws-client の新旧ソケット判定（`packages/web-ui/src/ws-client.ts:112-123` `notifyClosed`、
  `:159-174` `armPingWatchdog`）。
- A12: 走査テストの雛形（`packages/server/test/log-independence.test.ts` — `readFileSync` +
  `readdirSync` で src を舐め、不変条件を固定する形）。
- A13: 既存テストの置き場所——サーバー `packages/server/test/ws-reconnect-resume.test.ts` /
  `session-reconnect-grace.test.ts`、クライアント `packages/web-ui/test/session-reconnect.test.ts`
  （`WsClient` をモジュールごとモック `:27-46`、fake timers ＋ `Math.random=0.5` `:76-78`）。
- A14: 全組合せ表の置き場所 — **未特定**（新規ファイル。design で決める）。

## 実装時の注意

- **`dispose` の `removeViewer` は `hasViewer` より前に走る**（`ws-handler.ts:1090` → `:1126`）。
  順序を入れ替えると「自分を数えてしまう」ので、畳んでも**この順序は保つ**。
- **`releaseHolder` はゲートの外**（`:1125`）。中に入れると、他に viewer が居る経路で座を返し損ねて
  孤児になる（前 work の D7 → D10 でまさにこれを直した）。
- **`holdForReconnect` の `false` は「閉じてよい」ではない**（3 通りを兼ねる。`session-manager.ts:1391-1394`）。
  導出関数に畳むときは、この曖昧さを戻り値の型で潰す。
- **`abandoned` は `releaseHolder` の後に評価する**（`:1132`）。前に評価すると意味が変わる。
- **`startReconnect` の前処理は門より前**（`:281-286`）。「対象外の枝でもスピナーを解く」ことに
  依存している（前 work の review ラウンド2 の指摘）。
- **`session-controller.ts:270-274` の docstring は誤っている**——「打ちかけの入力も残る
  （`edits` には触らない）」と書いてあるが、前 work の **D11 で「捨てる」が正**と決まり、
  `session-reconnect.test.ts:149-163` がその挙動を固定している。畳み込みでこの関数を触るので、
  **コメントだけ訂正する**（振る舞いは変えない）。
- **`retryReconnect` は `reconnectFailed` を先に消す**（`:483`）ので、`"gone"` でも走り出す。
  押せなくしているのは UI（`StatusBar.vue:220`）だけ。**これは現行の振る舞いなので変えない。**
- `packages/server` のテストは型検査されない（F19）。**公開シグネチャを変えたら、
  ビルドではなくテスト実行で初めて壊れる。**
- 3270 のホスト終了で通知もエントリ削除も起きない（F9）。**バグに見えるが対象外**——
  表には「現行はこう」と書いて固定する。

## design への申し送り

- **AC2 の手段は両側で分けるのが素直。** サーバーは lint も型も使えるが**テストが型検査されない**、
  web-ui は lint が効かないが**テストまで型検査される**（F18 / F19）。
  **両側に効く単一の手段は F20 の走査テスト**で、前例（`log-independence.test.ts`）が
  この work とまったく同じ形の不変条件を固定している。封じ込め（型）と併用してよい。
- **R4（試行の新旧）を畳む順序**: F17-(3)(4) の穴を先に埋めてから触る。5 系統のうち
  `pendingResumes` の `:440` は「代表している試行か」を全メッセージで見ており、
  ここが抜けると打ち切った試行の `screen` が `connected` を戻す（既存テスト `:453-464` が
  その退行を捕まえる唯一の網）。
- **表の軸は「役割 4 通り × viewer 2 通り × 切れ方 4 通り × 端末 4 種」だが、
  起こり得ない組合せがある**（F8）。表には**起こり得ない旨も明記**して、
  「網羅した」と「到達しない」を区別する。
- **プリンターと 3270 / VT は軸が縮む**（F6 / F5）。同じ表に入れるなら「該当なし」を
  値として持たせる必要がある。
- 残った未確定: 表を置くファイル（A14）。サーバーとクライアントで**同じ表を共有するか、
  同じ内容を 2 か所に書くか**——共有すると型の依存が `server` ↔ `web-ui` に生まれるので、
  依存を作らない形（テスト側だけが読む定義）を選ぶこと。
