# 仕様: ホスト終了がはしごの最中に届くと取りこぼすのを直す

## 概要

`closed` を「寿命の信号」として R4 の外側にある `connected` の要求から独立させ、
はしごの最中でも口の同一性さえ合えば通す。通った `closed{ended:true}` が `link` を
`lost/hostEnded` に確定させたら、その場で進行中のはしご（待機タイマー・飛行中の試行）を畳む。
**この 2 つを 1 つの変更として入れる**——requirements の非機能要件どおり、片方だけでは無効。

## 設計方針

**採用**: 2 つの呼び出し箇所（`tryResume` の共通ガード／`applyFromSessionClient`）で、
`msg.type === "closed"` を**先に分岐**させ、`connected` を要求しない別の述語で通す。
通った後の `applyDisplayMessage` の `case "closed"` 自体（末尾）に、`abortReconnect(sessionId)`
の呼び出しを 1 行足す（`msg.ended === true` のときだけ）。

**代替案と却下理由**:

- **`acceptsFrame` / `acceptsFromSession` 自体から `connected` の要求を外す**（門を全種別に対して
  緩める）→ 却下。requirements の非機能要件「振る舞いの変更は `closed` に閉じる」に反する。
  他 6 種（`screen` 等）が `connected` の門無しに通ると、はしごの最中に打ち切った試行からの
  古い画面が復帰扱いになる退行——前 work `20260910-session-reconnect-freeze` が直したものの再来。
- **`case "closed"` を `applyDisplayMessage` の switch から完全に切り出し、独立関数にする**
  （前 work の debug 報告が触れた案）→ 却下。切り出すと `delete s.notice` / `setBusy(false)` の
  副作用を**この 1 関数の中でだけ**保証すればよくなる利点はあるが、`applyDisplayMessage` が
  「7 種を 1 か所で扱う」という既存の構造（`research.md` F1 由来）を崩し、変更が本 work の
  スコープ（`closed` の通し方だけ）を超える。**switch のケース自体は動かさず、通すかどうかの
  判定だけを switch の手前で分ける**——最小差分。
- **`abortReconnect` を呼び出し側（`tryResume` / `applyFromSessionClient`）に置く**（U1 の代替案）
  → 却下。「寿命が確定したらはしごを畳む」は `closed` の処理そのものに属する決定で、
  2 か所に書くと片方だけ更新される事故の芽になる（`.aidev/conventions/paired-artifact-sync.md` 1）。
  `applyDisplayMessage` は `abortReconnect` と同じモジュール（`session-controller.ts`）内にあり、
  呼ぶのに支障は無い。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/web-ui/src/session-link.ts` | 関数 1 つ追加（`acceptsLifetimeSignal`） |
| `packages/web-ui/src/session-controller.ts` | 呼び出し 2 か所の先頭分岐、`case "closed"` に 1 行 |
| `packages/web-ui/test/` | テスト追加（characterization。AC9） |

**対になる呼び出し箇所を両方直す**（`.aidev/conventions/paired-artifact-sync.md`）。
前 work `20260910-session-reconnect-freeze` の T11 は、まさにこの 2 か所（繋ぎ直しの口／
初回接続の口）のうち片方を先に直し、後から独立点検で「対の片側だけ」と指摘されて広げた経緯がある
（同 work `decisions.md` D13）。本 work は**最初から両方を対象範囲に含める**。

**明示的に対象外**: `applyDisplayMessage` の switch 本体のうち、`case "closed"` の**既存の副作用**
（`markLost` の呼び方・`delete s.notice`）は変えない——足すのは `abortReconnect` の呼び出し 1 行だけ
（対象範囲の表のとおり）。7 種の他 6 つのケースには 1 行も触れない。

## 依拠する既存の事実

> **coding での訂正**（review ラウンド2 の must）: `nextLink` は `link` 自体の上書きを防ぐが
> （下記）、`case "closed"` の `delete s.notice` は無条件だった。`SessionState.client` は
> 成功した繋ぎ直しが一度も無いセッションでは変わらないので、はしごを使い切って
> `lost/gaveUp`（`MSG_RECONNECT_GAVE_UP` 付き）に確定したあとも、**その同じ口**から
> 遅れて届く `closed{ended:false}`（transport 起因）が本設計の D-a/D-b をそのまま通り、
> 確定済みの文言を黙って消していた（実測で再現。`packages/web-ui/test/session-reconnect.test.ts`
> の「諦めたあと、同じ口から遅れて届いた transport 原因の `closed` で諦めの文言が消えない」）。
> **修正**: D-a/D-b の条件を `msg.ended === true` に限定する。要件が必要としているのは
> 「ホスト終了の確定」だけで、transport 起因の `closed` を `connected` の門から外す必要は
> 元から無かった——`ended` 無しの `closed` は従来どおり `acceptsFrame`/`acceptsFromSession`
> （`connected` を要求）を通る。

- **`tryResume` の共通ガードは `acceptsFrame` を 1 回だけ呼ぶ** — HEAD `31b1f098` の
  `session-controller.ts:503-505`（`const held = ...` から `applyDisplayMessage` 呼び出しまで）。
- **`applyFromSessionClient` は `acceptsFromSession` を 1 回だけ呼ぶ** — 同 `:651-654`。
- **`acceptsFrame` / `acceptsFromSession` は `session-link.ts` に定義され、どちらも
  `link?.state === "connected"` を要求する** — 同 `session-link.ts:266-291`
  （`acceptsFrame` は `isCurrentAttempt(...) || (link?.state === "connected" && isSessionClient(...))`
  の形、`acceptsFromSession` はその第 2 項だけを単独の関数にしたもの）。
- **`case "closed"` は `applyDisplayMessage` の switch の 1 ケース** — HEAD `31b1f098` の
  `session-controller.ts:615-628`。
  `markLost(id, ended ? "hostEnded" : "transport")` → `delete s.notice` → 
  （switch を抜けたあと）`setBusy(sessionId, false)`。
- **`abortReconnect` は待機タイマーと飛行中の試行の両方を畳む** — 同 `session-controller.ts:271-283`。
  `clearReconnectTimer(sessionId)` を先頭で常に呼んだあと、`a?.client !== undefined` で分岐する:
  真なら（飛行中）`attempts.delete` → `a.settled = true` → `inflight.send/close`、
  偽なら（待機中またはエントリ無し）`else` 節の `attempts.delete` のみ。
  どちらの分岐でも安全に呼べる。
- **`nextLink` は `transport` 原因の遷移だけ `reconnecting` を上書きしない** — 同
  `session-link.ts:96-112`。`hostEnded` / `gone` / `gaveUp` は無条件に上書きする。
  → **`transport` 原因の `closed`（`ended` 無し）は、そもそも `link` を書き換えない**ので、
  本 work が `connected` の要求を外しても、はしごへの影響が無いことが型の側で保証されている
  （requirements の対象外「`transport` 経路のガード」の根拠）。
- **`a.client` は `WsClient` 構築直後・`connect()` 呼び出し前に代入される** — 同 `session-controller.ts:529`
  （`a.client = client;` が `.connect()` の直前）。→ **飛行中の試行自身の口から `closed` が
  届いた場合でも `a.client` は既に設定済み**なので、その場で `abortReconnect` を呼んでも
  `a?.client !== undefined` の分岐（後始末込みの安全な畳み方）に入る。未確認: 実機での
  `close()` の再入可能性は確かめていない（requirements「未検証の穴」相当）。
- **`refuseIfDisconnected` は `canSendToHost` の `reason` を写像する**（`hostEnded` →
  `MSG_SESSION_ENDED`、それ以外 → `MSG_NOT_CONNECTED`）— 同 `session-controller.ts:154-168`
  （`refuseIfDisconnected` 全体）。**本 work はこの写像に触れない**——`markLost(hostEnded)` が
  正しいタイミングで走ることだけが本 work の関心で、写像自体は前 work が既に固定している。

## インターフェース / データ構造

`packages/web-ui/src/session-link.ts` に追加（`acceptsFrame` の直後）。

```ts
export function acceptsLifetimeSignal(
  current: Attempt | undefined,
  a: Attempt,
  live: WsClient | undefined,
  from: WsClient
): boolean {
  return isCurrentAttempt(current, a) || isSessionClient(live, from);
}
```

- **`acceptsFrame` から `connected` の要求だけを外した形**——第 1 項は同じ、第 2 項が
  `acceptsFromSession(link, live, from)` ではなく `isSessionClient(live, from)` 単体になる。
- **初回接続の口（`Attempt` を持たない）には新しい関数を作らない**。`acceptsFromSession` が
  `isSessionClient` 単体を包んだだけだったのと対称に、そちらは `isSessionClient(held?.client, client)`
  を**直接呼ぶ**（`acceptsFrame` に対する `acceptsFromSession` の関係と同じ縮約）。

## 振る舞いの詳細

### D-a: `tryResume` の共通ガードに `closed` の先行分岐を足す

```ts
const held = sessionsStore.get(sessionId);
if (msg.type === "closed" && msg.ended === true) {
  if (!acceptsLifetimeSignal(attempts.get(sessionId), a, held?.client, client)) return;
  applyDisplayMessage(sessionId, client, msg);
  return;
}
if (!acceptsFrame(attempts.get(sessionId), a, held?.client, client, held?.link)) return;
applyDisplayMessage(sessionId, client, msg);
```

**coding で訂正**（review ラウンド2 の must）: 条件を `msg.type === "closed"` から
`msg.type === "closed" && msg.ended === true` に狭めた。`ended` の無い `closed`（transport 起因）
は従来どおり `acceptsFrame` 側を通る。理由は「依拠する既存の事実」の訂正を参照。

`msg.type` で先に分けるので、`acceptsFrame` を通る他 6 種の経路は 1 行も変わらない
（`held` の取得位置も変えない——同じ `held` を両方の分岐が使う）。

### D-b: `applyFromSessionClient` に同じ形の先行分岐を足す

```ts
function applyFromSessionClient(sessionId: string, client: WsClient, msg: WsServerMessage): void {
  const held = sessionsStore.get(sessionId);
  if (msg.type === "closed" && msg.ended === true) {
    if (!isSessionClient(held?.client, client)) return;
    applyDisplayMessage(sessionId, client, msg);
    return;
  }
  if (!acceptsFromSession(held?.link, held?.client, client)) return;
  applyDisplayMessage(sessionId, client, msg);
}
```

**coding で訂正**（D-a と同じ理由。review ラウンド2 の must）。

### D-c: `case "closed"` にはしごを畳む 1 行を足す

```ts
case "closed": {
  const s = sessionsStore.get(sessionId);
  if (s) {
    sessionsStore.markLost(sessionId, msg.ended === true ? "hostEnded" : "transport");
    delete s.notice;
  }
  setBusy(sessionId, false);
  // **coding で追加**: hostEnded が確定したら、走っているはしごを畳む
  // （`20260910-session-closed-ladder-interrupt` の `decisions.md`。設計は本 design.md D-c）
  if (msg.ended === true) abortReconnect(sessionId);
  break;
}
```

`msg.ended !== true`（`transport` 原因）では呼ばない——「依拠する既存の事実」のとおり
`nextLink` がその遷移で `reconnecting` を上書きしないので、畳む理由が無い
（呼んでも実害は無いが、変更を `closed{ended:true}` の意味に閉じるため条件を付ける）。

### 真理値表（新しい分岐が通す／落とす組合せ）

| 状況 | `link.state` | `isCurrentAttempt` | `isSessionClient` | 通る？ | 前後の変化 |
|---|---|---|---|---|---|
| 飛行中の代表の試行自身の口から `closed` | `reconnecting` | true | — | 通る | 変化なし（元々 `acceptsFrame` の第1項で通っていた） |
| **成功した口が死にかけ、はしご走行中に旧口から `closed`** | `reconnecting` | false | true | **通る** | **本 work の修正**（AC1〜AC3。D-a の経路） |
| 打ち切った試行の口から遅れて `closed` | 問わず | false | false | 落ちる | 変化なし（AC6） |
| 初回接続の口から `closed`（はしご未走行） | `connected` | — | true | 通る | 変化なし（元々ガード無しで通っていた） |
| **初回接続の口が死にかけ、はしご走行中に旧口から `closed`** | `reconnecting` | — | true | **通る** | **本 work の修正**（AC1〜AC3。D-b の経路） |

## ドメイン固有の考慮

- **コメントの出所**（`.aidev/conventions/comment-provenance.md`）: D-c の新しい 1 行には
  「coding で追加」と明示し、本 work の decisions への参照を添える。「依拠する既存の事実」の
  行番号引用には HEAD のコミット ID（`31b1f098`）を添えてある（本 work で動く行のため）。
- **`packages/web-ui/**` は eslint の対象外**（前 work で繰り返し確認済み）。この設計を守るのは
  型と review、および `lifetime-flag-containment.test.ts` の走査（新しい述語も `session-link.ts`
  の内側に閉じる——`.client ===` の直接比較を増やさないので、既存の走査 2 件（比較・代入）に
  抵触しない）。
- 表示文言は増やさない（`opMessages.ts` に触らない）。

> `.aidev/config.yml` の `smokeCommand` は `node launcher/smoke.mjs`。本件はクライアントの
> 判定のみで配線を変えないが、test 工程で通す（AC8）。

## エラー処理 / 異常系

- **`closed{ended:true}` が診断できない口から届く場合**（`isSessionClient` も `isCurrentAttempt` も
  偽）: 落ちる（変化なし。AC6）。
- **`abortReconnect` を呼んだ時点で `attempts` に何も無い場合**（順序 A・はしご未走行）:
  `clearReconnectTimer` は no-op、`a` は `undefined` なので `else` 分岐の `attempts.delete` のみ
  （既に無いものを消すだけ）。実害無し。
- **`abortReconnect` を、その `closed` を配送した当のソケット自身に対して呼ぶ場合**（飛行中の
  代表の試行自身の口から `closed` が届いた場合）: 「依拠する既存の事実」のとおり `a.client` は
  既に設定済みなので安全に畳める。この経路は requirements のスコープ外（AC1〜AC3 は「旧口から」の
  シナリオを固定する）だが、design 上は矛盾なく動く経路として確認しておく。

## 受け入れ基準との対応

- AC1: 順序 B（`onClose` → 同じ口へ `closed{ended:true}`）で新しい試行が作られない。
  入力は D-a（または初回接続の口の場合は D-b）・D-c——`closed` が新分岐で通り、
  `case "closed"` の `abortReconnect` が待機タイマーを畳む。真理値表の 2 行目・5 行目に対応。
- AC2: 次の打鍵で `MSG_SESSION_ENDED`。入力は D-c の `markLost(hostEnded)` と、「依拠する既存の
  事実」に挙げた `refuseIfDisconnected` の写像（変更なし）。
- AC3: 60 秒後も口が増えない。入力は D-c の `abortReconnect`（タイマーが畳まれているので
  `tryResume` が二度と呼ばれない）。D-a・D-b どちらの経路でも同じ `abortReconnect` を通る。
- AC4: 述語が `session-link.ts` にあり、呼ぶだけ。入力は「インターフェース / データ構造」の
  `acceptsLifetimeSignal` と、D-a・D-b が `session-controller.ts` 側で新しい判定ロジックを
  組み立てていないこと。
- AC5: 既存の順序 A のテスト 2 件が緑のまま。入力は D-a・D-b が `msg.type === "closed"` でしか
  分岐しないこと（他の経路・他の種別を一切変えない）と、`nextLink` の `transport` 不変（依拠する
  既存の事実）。
- AC6: 打ち切った試行・古い口は引き続き弾かれる。入力は真理値表の 3 行目——
  `isCurrentAttempt` false かつ `isSessionClient` false の組合せは新旧どちらの述語でも偽。
- AC7: 既存の回帰が緑。入力は本設計が既存 API を変えないこと（`acceptsLifetimeSignal` は追加のみ）
  と、D-a・D-b が他の種別の経路を素通しすること。
- AC8: `node launcher/smoke.mjs` が通る。入力は `.aidev/config.yml` の `smokeCommand`。
  本件はクライアントの判定のみで配線を変えないが、test 工程で通す。
- AC9: AC1〜AC3・AC6 の characterization を先に書き、**修正前に落ちる**ことを確認する。
  入力は「依拠する既存の事実」（現行コードは `closed` を `connected` の門で落とすので、
  D-a・D-b 適用前は必ず落ちる）。
