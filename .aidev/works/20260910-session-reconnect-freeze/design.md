# 仕様: 繋ぎ直し成功後のフレーム遮断を、R4 の内側で塞ぐ

## 概要

繋ぎ直し経路のメッセージ共通ガードが問うている「この試行が代表か」は、**繋ぎ直しが成功した後に
問うべき問いではない**（成功時に試行を退役させるため、以後必ず偽になる）。成功後に問うべきなのは
「**この口がいま現役か**」で、これは前 work が R4 に畳まなかった 5 つ目の判定である。

したがって直し方は「ガードを緩める」ではなく、**共通ガードが問う問いを、2 つの判定の選言として
R4 の内側に定義し直す**。合成そのものを `session-link.ts` に置くのが本設計の要で、
呼び出し側で `||` を書くと前 work が畳んだ形（独立述語を呼び出し側で組む）に戻る。

## 設計方針

**採用**: `session-link.ts` に述語を 2 つ足し、`session-controller.ts` は**それを呼ぶだけ**にする。

1. `isSessionClient(live, from)` — 「**セッションがいま抱えている口か**」（R4 の 5 つ目。
   これまで無名だった判定に名前を与える）。**「繋がっているか」ではない**——`s.client` は
   切れても差し替わるまで残る（「依拠する既存の事実」の F5）ので、**退役した口でも真を返しうる**。
   繋がりの真実は `link` が持つ。当初案の `isLiveClient` は「現役＝繋がっている」と読めて
   実態とずれるため、この名前にした。
2. `acceptsFrame(current, a, live, from)` — 「この口から届いたフレームを受け取ってよいか」
   ＝ `isCurrentAttempt(current, a) || isSessionClient(live, from)`

**代替案と却下理由**:

- **呼び出し側で `|| sessionsStore.get(id)?.client === client` を書き足す**（最小の差分）→ 却下。
  判定が `session-controller.ts` に生まれ、requirements AC7 と前 work の畳み込みの趣旨に反する。
  走査テストはこの形を検出できない（`research.md` F9）ので、規約の側で止めるしかない。
- **`isCurrentAttempt` 自体に第 3 引数を足して意味を広げる** → 却下。`opened` 枝（成功の判定）と
  共通ガード（受信の判定）は**違う問いを問うており**、片方に合わせて広げると他方が壊れる（下記 D-b）。
- **`s.client` を optional にして、切れたら clear する**（`isSessionClient` を実態に合わせる）→ 却下。
  HEAD `657ad59b` の `stores/sessions.ts:153` の `client: WsClient` は **optional ではない**（型宣言そのもの。
  読み手側が全員その前提で書いているかは**未確認**だが、optional 化は型の変更として全読み手に波及する）。
  requirements 非機能要件「公開 API・スキーマは変えない」「振る舞いの変更を閉じる」に反する。

**採用案そのものを非機能要件に照らす**。「振る舞いの詳細」の表 4 行目で 1 経路が新たに通るため、
requirements 非機能要件「振る舞いの変更は『繋ぎ直し成功後にフレームが届く』ことに閉じる」に
形式上は触れる。**それでも反しないと判断する**理由は 2 つ——(a) その経路の到達には
**閉じたソケットにメッセージが配送される**ことが要り、実際の振る舞いは変わらない、
(b) その依存は初回接続の経路が最初から負っているもの（「依拠する既存の事実」の F3）で、
本件が新しく作る穴ではない。**判断であって自明ではない**ので `decisions.md` D5 に残し、review の対象とする。

**戻り値は真偽にする**。`resumeVerdict` / `canSendToHost` が列挙（`{resume, why}` / `{ok, reason}`）を
返すのは、呼び出し側が理由を**表示文言へ写す**ため（`session-link.ts` の冒頭 docstring「表示文言を知らない」）。
共通ガードは理由を使わず捨てるだけなので、`isCurrentAttempt` と同じ真偽でよい。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/web-ui/src/session-link.ts` | 関数 2 つ追加、`Attempt` の docstring 修正 |
| `packages/web-ui/src/session-controller.ts` | 共通ガードの差し替え / 2 つの `onClose` の述語化 / `applyFromSessionClient` の新設と初回接続の 2 か所（**coding で訂正**: `decisions.md` D12・D13・D14） |
| `packages/web-ui/src/stores/sessions.ts` | `updateScreen` の注記＋**`setClient` の新設**（**coding で訂正**: `decisions.md` D8） |
| `packages/web-ui/test/session-reconnect.test.ts` | テスト追加 |
| `packages/web-ui/test/lifetime-flag-containment.test.ts` | 走査を 2 件追加（**coding で追加**: `decisions.md` D9・cross 点検） |
| `packages/web-ui/test/session-link.test.ts` | 新規（R4 の述語の真理値表。**coding で追加**: cross 点検） |

**対になる資産の確認**（`.aidev/conventions/paired-artifact-sync.md`）:
`lifetime-flag-containment.test.ts` はサーバー／クライアントの対。**coding で訂正**——走査の規則は
クライアント側に 2 件足した（`decisions.md` D9 と cross 点検）。サーバー側に同じ規則を足す必要は無い
（`packages/server/src` に口の同一性を素で比べる箇所は無く、サーバーは繋ぎ直しの口を持たない。
cross 点検が現物で確認済み＝`paired-artifact-sync` 4 の「対の側に当たった」記録）。サーバー側に本件の対応物は無い——`research.md`「影響範囲」が
「サーバー側は無関係（`packages/server/` に本件の判定は無い。R1/R2 は別ファイル）」と結論している。
**サーバー実装を全数確認したわけではない**ので、review で対の側に当たっているかを確かめる
（`.aidev/conventions/paired-artifact-sync.md` 4）。

**明示的に対象外**: `packages/web-ui/test/session-lifetime-matrix.ts` に R4 の行を足すことはしない。
あの表の軸は `Terminal × Disconnect × Role`（`:24-47` / `ClientCase` は `:81`）で、答えるのは
**繋ぎ直すか（R3）**であり、フレームを受け取るか（R4）の軸を持たない。軸を足すのは表の作り直しで、
backlog の別項目（D17）の範囲。**本 work で `error` 経路にテストが付くのは AC3 の結果であって、
D17 の消し込みではない**（requirements の対象外に明記済み）。

## 依拠する既存の事実

- **`opened` 成功時に `a.settled = true` と `attempts.delete(sessionId)` の両方が起きる**
  — `session-controller.ts` の `tryResume` 内 `opened` 枝（`research.md` F1。HEAD `657ad59b` の `:429` / `:432`）。
- **`isCurrentAttempt` は `current === a && !a.settled`** — HEAD `657ad59b` の
  `session-link.ts:215-217`（関数本体。本 work で動く行なのでコミット ID を添える）。
- **繋ぎ直し経路の `onServerMessage` は 3 つの枝を持ち、`applyDisplayMessage` を呼ぶ直前の
  共通ガードが `isCurrentAttempt` である** — `research.md` F1。枝は (1) `opened`（先頭に
  `isCurrentAttempt`）、(2) `error` かつ `!a.settled`（引き取り失敗 → `giveUpReconnect`）、
  (3) それ以外すべて（共通ガード → `applyDisplayMessage`）。
- **`applyDisplayMessage` が `reserved` / `screen` / `key-done` / `jobinfo` / `pc-command` /
  `closed` / `error` の 7 種を 1 か所で扱う** — `research.md` F1（枝 3 の落ち先を数えたもの）。
- **`s.client` は clear されない**。代入は初回の `sessionsStore.add` と繋ぎ直し成功時の 1 か所だけで、
  `startReconnect` も `markLost` も口に触れない — `research.md` F5（`grep '\.client = '` で全数確認）。
- **初回接続の経路にはガードが無い** — `session-controller.ts` の `openSession` 内 `default:`（`research.md` F3）。
- **`session-link.ts` は store を知らない**（import は `type { WsClient }` の 1 行のみ。HEAD `657ad59b` の `:21`）— `research.md` F4。
- **走査テストが固定する 5 つの規則**（`attempts` は `session-controller.ts` だけ / `settled` は
  `session-link.ts` と `session-controller.ts` だけ 等）— `research.md` F9。
  新設の 2 関数はどれにも触れない（`Attempt` を引数で受けるだけ）。
- **`key-done` と未施錠の `screen` だけが `setBusy(id,false)` を呼び、`closed` が `markLost` を呼ぶ**
  — `research.md` F2（`applyDisplayMessage` の各 case を数えたもの）。この 3 つが落ちることが
  「待ちが解けない」「ホスト終了が記録されない」の直接の原因。
- **`updateScreen` の「到達しない」注記が名指ししているのは打ち切った試行の `screen` であり、
  `s.client` はその口を指さない** — `research.md` F6。
- **`tryResume` の `onClose` は既に `sessionsStore.get(sessionId)?.client === client` を書いている**
  — `research.md`「実装時の注意」（HEAD `657ad59b` の `session-controller.ts` の `onClose` 枝）。
- **`a.client` の代入は `new WsClient(...)` の後に置かれている** — HEAD `657ad59b` の
  `session-controller.ts` で `const client = new WsClient(` が `:421`、`a.client = client;` が `:500`
  （本 work で動く行なのでコミット ID を添える。`.aidev/conventions/comment-provenance.md` 2）。
- **成功した口の後続フレームを送るテストは 1 件も存在しない** — `research.md` F8
  （HEAD `657ad59b` の `session-reconnect.test.ts` 全 576 行で `type: "screen"` は 1 か所、
  `type: "key-done"` は 1 か所。**本 work の T1 がここに足す**ので、この数は HEAD 時点のもの）。
- **テストのフェイク `WsClient` は閉じた後もメッセージを配送できる** — `research.md` F7。

## インターフェース / データ構造

`packages/web-ui/src/session-link.ts` に追加（`isCurrentAttempt` の直後）。既存 API の変更は無い。

```ts
/**
 * **セッションがいま抱えている口か**（R4 の 5 つ目）。
 * **繋がっているかではない**——`s.client` は切れても差し替わるまで残る。
 */
export function isSessionClient(live: WsClient | undefined, from: WsClient): boolean {
  return live === from;
}

/** **この口から届いたフレームを受け取ってよいか**（R4 の合成） */
export function acceptsFrame(
  current: Attempt | undefined,
  a: Attempt,
  live: WsClient | undefined,
  from: WsClient,
  link: SessionLink | undefined // **coding で追加**（decisions D12）
): boolean {
  return isCurrentAttempt(current, a) || acceptsFromSession(link, live, from);
}

// **coding で追加**（decisions D13）。試行を持たない初回接続の口はこちらだけを問う
export function acceptsFromSession(
  link: SessionLink | undefined,
  live: WsClient | undefined,
  from: WsClient
): boolean {
  return link?.state === "connected" && isSessionClient(live, from);
}
```

- `live` = `sessionsStore.get(id)?.client`（呼び出し側が渡す。規則は store を知らないため）
- `from` = そのフレームが届いた口（`onServerMessage` の閉包が捕まえている `client`）
- **`a.client` ではなく `from` を受け取る**——`a.client` の代入は `new WsClient(...)` の**後**なので、
  構築中に届く経路を想定すると未設定になりうる。届いた口をそのまま渡せばその前提が要らない。

## 振る舞いの詳細

| 状況 | `isCurrentAttempt` | `isSessionClient` | `acceptsFrame` | 現行からの変化 |
|---|---|---|---|---|
| はしごの飛行中の試行から `screen` | true | false | true | 変化なし |
| 打ち切った試行から遅れて `screen` | false | false | **false** | 変化なし（AC4） |
| **繋ぎ直し成功後、その口から `screen` / `key-done`** | false | **true** | **true** | **本件の修正**（AC1/AC2） |
| 成功 → 再切断 → はしご中に、退役した口から遅延 | false | ~~true~~ **false** | **false** | **coding で訂正**（`decisions.md` D12。`connected` の門で塞いだ） |
| 2 度目の成功後、1 度目の口から遅延 | false | false | false | 変化なし |
| 初回接続の口から `screen` | — | `acceptsFromSession` | 繋がっている間だけ | **coding で訂正**（`decisions.md` D13。ここにも門を当てた） |

### D-a: 共通ガードの差し替え

`session-controller.ts` の `tryResume` 内、`applyDisplayMessage` を呼ぶ直前のガードを
`acceptsFrame(attempts.get(sessionId), a, sessionsStore.get(sessionId)?.client, client)` にする。

### D-b: `opened` 枝のガード（`isCurrentAttempt`）は**変更しない**

あちらが問うているのは「**この試行の成功を採用してよいか**」で、答えは代表かどうかだけで決まる。
`acceptsFrame` に替えると「現役の口から 2 度目の `opened` が来たら成功処理をもう一度回す」経路が
生まれ、`attempts.delete` と `cur.client = client` が二重に走る。**問いが違うので述語も別**。

### D-c: `onClose` の生の比較を `isSessionClient` に寄せる

`tryResume` の `onClose` は既に `sessionsStore.get(sessionId)?.client === client` を書いている
（同じ問いの、名前の無い写し）。ここを `isSessionClient(...)` に差し替える。
**向きが逆（あちらは「現役なら回し直す」、こちらは「現役なら受け取る」）でも問いは同一**なので、
1 つの述語で表せる。これで `session-controller.ts` から生の口比較が消える（AC7）。

### D-d: 書き直す注記は 2 か所

1. `session-link.ts` の `Attempt` の docstring — いま「その 5 つ目が必要なのに**欠けている場所がある**」と
   現在形で書いている（`requirements.md`「前提: R4 とは」）。塞いだ後は嘘になるので、
   **「`acceptsFrame` として R4 の内側に置いた」**へ書き直す。
2. `stores/sessions.ts` の `updateScreen` の「到達しない」注記 — 根拠が寄りかかる先が
   `isCurrentAttempt` から `acceptsFrame` に変わるので、**何が弾かれ続け、何がブラウザ仕様頼みになるか**を
   書き分ける（AC6）。

どちらも `.aidev/conventions/comment-provenance.md` に従い、**本 work で動く行を行番号で指さない**
（参照は work 名・D 番号・関数名で書く）。

## ドメイン固有の考慮

- **コメントの出所**（`.aidev/conventions/comment-provenance.md`）: 新設関数と書き直す 2 か所の注記では、
  **本 work で動く行を行番号で指さない**。参照は work 名（`20260908-session-lifetime-rules-fold`）と
  D 番号、または名前（`acceptsFrame` / `tryResume` の共通ガード）で書く。数を書くなら数えた範囲も書く。
- **`packages/web-ui/**` は eslint の対象外**（`lifetime-flag-containment.test.ts` 冒頭 docstring）。
  この設計を守るのは走査テスト・型・review だけ。**AC7 は機械では守れない**（`research.md` F9）ので、
  review の観点として明示する。
- 表示文言は増やさない（`opMessages.ts` に触らない）。本件は「届かない」を「届く」に戻すだけで、
  新しい通知は生まれない。

## エラー処理 / 異常系

- **成功後の `error`**: `a.settled` が真なので `error && !a.settled` 枝（引き取り失敗）には入らず、
  共通ガードを通って `applyDisplayMessage` の `error` case へ落ちる＝送信拒否の理由が操作員に出る（AC3）。
- **成功後の `closed`**: 同様に共通ガードを通り、`markLost` が走る。**現行は落ちているため
  「ホストが終わった」がこの口から一度も記録されない**（`research.md` F2）。
- **`giveUpReconnect` 後**: `attempts` は空、`s.client` は退役した口のまま。遅延フレームは
  `isSessionClient` で通る——ただし到達には閉じたソケットからの配送が要る（下記の既知の制約）。
- **既知の制約（AC6 の答え）**: `updateScreen` の「到達しない」注記が名指ししているのは
  **打ち切った試行**で、そちらは `acceptsFrame` が弾き続ける。新たに通りうるのは
  「退役した現役口からの遅延」だけで、その到達には**閉じたソケットにメッセージが配送される**ことが要る。
  これは初回接続の経路が最初から負っているのと同じ依存（F3）で、本 work では**塞がず、注記を書き直す**
  （実装を直す案を却下した理由は「設計方針」の 3 つ目。判断は `decisions.md` D5）。

## 受け入れ基準との対応

> **`D` 記法の使い分け**: `D-a`〜`D-d` は本文書の設計判断、`D3` / `D5` は**本 work の
> `decisions.md`** のエントリ、`D17` は前 work `20260908-session-lifetime-rules-fold` の
> `decisions.md` 由来で backlog に起票された項目。


- AC1: 成功後の `screen` が反映される。入力は D-a の差し替えと「振る舞いの詳細」の表 3 行目（`isSessionClient` が真）。
  検証は新規テスト（`session-reconnect.test.ts` に追加。土台は `research.md` の実装アンカー A5）。
- AC2: 成功後の `key-done` で待ちが解ける。入力は同じ D-a。`setBusy(id,false)` に到達することを
  `s.busy`（または覆いの状態）で見る。`key-done` が `setBusy` を呼ぶことは `research.md` F2。
- AC3: 成功後の `reserved` / `pc-command` / `jobinfo` / `closed` / `error` が初回接続と同じ扱いになる。
  入力は同じ D-a と、`applyDisplayMessage` が全種を 1 か所で扱う構造（`research.md` F1 の枝 3）。
- AC4: 打ち切った試行の `screen` は弾かれ続ける。入力は「振る舞いの詳細」の表 2 行目
  ——`isCurrentAttempt` false かつ `isSessionClient` false（`s.client` は打ち切った試行の口ではない。F5）。
  検証は既存テスト（`session-reconnect.test.ts` の「打ち切った試行から遅れて届いた画面で、接続中に戻らない」）が緑のまま。
- AC5: 再切断後にはしごが回る。~~入力は D-c——`onClose` の判定は式を関数へ移すだけで真偽が変わらない~~
  **coding で訂正（`decisions.md` D7）**: 式としては同一だが、繋ぎ直しの口が `markRaw` されずに
  プロキシ化していたため、**現行の `onClose` は成功後に必ず偽で、はしごが二度と回らなかった**。
  AC5 は「退行が無いことの確認」ではなく「壊れているものを直す」になり、T9（`setClient`）が担う。
- AC6: `updateScreen` の注記を書き直す（D-d の 2 番目）。入力は「エラー処理 / 異常系」の既知の制約と、
  「依拠する既存の事実」に挙げた F6。
  実装は直さない（**本 work の `decisions.md` D3** で認めた例外は発動しない）。判断は同 `decisions.md` D5。
- AC7: 述語は `session-link.ts` に定義し、`session-controller.ts` は呼ぶだけ。入力は
  「インターフェース / データ構造」の 2 関数と D-c（生の比較の除去）。`lifetime-flag-containment.test.ts` は
  `attempts` / `settled` の所在を変えないので緑のまま（`research.md` F9）。
  `Attempt` の docstring の書き直し（D-d の 1 番目）もここに属する——**述語が R4 の内側に在ること**を
  記述の側でも一致させる。
- AC8: 既存の回帰が緑。入力は本設計が**既存 API を変えない**こと（追加のみ）と、D-b/D-c が
  真偽を変えないこと。ベースラインは requirements 非機能要件（5664 passed / 0 failed / 41 skipped）。
- AC9: `node launcher/smoke.mjs` が通る。入力は `.aidev/config.yml` の `smokeCommand`。
  本件はクライアントの判定のみで配線を変えないが、test 工程で通す。
- AC10: AC1〜AC3 の characterization を先に書き、**修正前に落ちる**ことを確認する。入力は
  `research.md` F7（フェイクの土台で書ける）と F8（いま存在しない穴）。
