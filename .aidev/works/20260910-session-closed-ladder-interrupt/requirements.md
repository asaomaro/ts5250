# 要件: ホスト終了がはしごの最中に届くと取りこぼすのを直す

## 背景 / 課題

### 前提: R4 とは

前 work `20260910-session-reconnect-freeze` が、セッション寿命の判定を 4 つの規則（R1〜R4）に
畳んだ。うち **R4**（「この口から届いたフレームを受け取ってよいか」＝繋ぎ直しの試行と口の同一性の
判定）が `packages/web-ui/src/session-link.ts` に置かれている。本 work が触るのも R4 で、
その中の `isCurrentAttempt` / `isSessionClient` を使う。既存の `acceptsFrame`（`tryResume` 用）・
`acceptsFromSession`（初回接続の口用）は、どちらも「口の同一性」に加えて `link.state === "connected"`
を要求する——**この `connected` の要求が、`closed` を落としている原因そのもの**（`背景 / 課題`）。
本 work が足す新しい述語は、この 2 つとは**別に**、`connected` を要求しない形で
`isCurrentAttempt` / `isSessionClient` を組み合わせたもの（U2 で名前と形を決める）。
既存の `acceptsFrame` / `acceptsFromSession` 自体は変更しない——`closed` 以外の種別は
引き続きそちらを通る。

`packages/web-ui/src/session-controller.ts` の `applyDisplayMessage` は `case "closed"` を含む
7 種のフレームを 1 か所で扱う。前 work `20260910-session-reconnect-freeze` が繋ぎ直し経路の
共通ガードに `link.state === "connected"` の門を足した（`decisions.md` D12・D13）ため、
**`closed` もこの門の内側に入った**。

`closed` は表示の更新ではなく**寿命の信号**（`WsClosed.ended`）で、ホストが本当に終わったかどうかを
唯一伝える経路である。ところが、**繋ぎ直しのはしごが走っている間は `link.state` が `reconnecting`
で `connected` ではない**ため、その最中にホスト終了の `closed{ended:true}` が届くと門で落ちる。

**落ちる経路が実在する**（前 work `20260910-session-reconnect-freeze` の review ラウンド3 ＋
デバッグ D1 が確認済み）: 転送が半開き（片方向だけ詰まる・スリープ復帰のタブ等）になると、
`ws-client.ts` の見張りが `ws.close()` を呼んだあと保険のタイマーで `onClose` を撃つ。
この時点でソケットはまだ CLOSING で、`message` の受け口に `readyState` の検査は無いため、
**その後もフレームが配送されうる**。`onClose` は `startReconnect` を通って `link` を `reconnecting`
にし、はしごを 1 段目から回し始める。そこへ本物のホスト終了の `closed{ended:true}` が
**同じ CLOSING のソケット**に届くと、`connected` の門で落ちる。

**落ちると何が起きるか**（デバッグ D1 が実測。転送の生死で 2 通り）:

- 転送が生きている場合: 1.2 秒後にはしご 1 段目が `resume:true` を送り、サーバーが
  `SESSION_NOT_FOUND` を返して `giveUpReconnect(..., "gone")` に至る。最終的な `link` は
  `lost/gone`、文言はサーバーが返した生の理由（`wsErrorNotice`）——**正しい `hostEnded` の文言
  （`MSG_SESSION_ENDED`）より具体性が落ちる**うえ、1.2 秒の無駄な往復が挟まる。
- 転送も死んでいる場合: はしご 5 段（約 37 秒）を空振りし、`link=lost/gaveUp`、文言は
  `MSG_RECONNECT_GAVE_UP`「サーバーに繋ぎ直せませんでした（再接続で試し直せます）」——
  **押しても無駄な「再接続」ボタン**が出る（`reconnectFailed: "retry"` が立つため）。
  利用者は 37 秒待たされた末に、実態と違う案内を見る。

**どちらの場合も、最終状態に至るまでの間（`link.state === "reconnecting"` のまま）に打鍵すると
`MSG_NOT_CONNECTED`（一般的な「サーバーと繋がっていません」）が出る**——`canSendToHost` は
`hostEnded` を記録できていないので `disconnected` 理由しか返せない。
**AC2 が「塗り替わってはいけない」と挙げる 2 つの誤り文言は次に対応する**:
`MSG_NOT_CONNECTED` はこの**ラダー走行中**の打鍵で出るもの（どちらの場合にも共通）、
`MSG_RECONNECT_GAVE_UP` は「転送も死んでいる場合」がラダーを使い切ったあとの**最終状態**。
「転送が生きている場合」の最終状態（`wsErrorNotice` 由来の文言）は AC2 の対象に含めない
——AC1〜AC3 が固定するのは「転送も死んでいる場合」のシナリオ（U3 参照）で、
そちらの誤り文言が `MSG_RECONNECT_GAVE_UP` にあたるため。

**単独では直せない**（デバッグ D1 が実測）。`closed` を門の内側から外して通すだけでは、
**既に走り出しているはしご（次の段を待つタイマー）が誰にも止められない**ため、通した直後の
`markLost(hostEnded)` は次のタイマー発火で上書きされ、**利用者から見える最終状態・文言・ボタンが
1 つも変わらない**（実測で確認済み）。効かせるには「`hostEnded` が確定したらはしごを畳む」修正を
**対で**入れる必要がある。

## 目的 / ゴール

**転送が半開きになってはしごが回り始めたあとにホスト終了が届いても、利用者は「ホストが終わった」
という正しい理由を、無駄な待ち時間・無駄な再接続ボタンなしで見られる状態**にする。

同時に、**既存の振る舞い（順序 A: `closed` が先に届き、それを受けて `onClose` が発火する経路）を
変えない**状態を保つ。`closed` を先に処理した時点で `resumeVerdict` が `resume:false` を返すため、
はしごはそもそも始まらない——この経路は既にテストで固定されており（
`packages/web-ui/test/session-reconnect.test.ts` の「ホスト側が終わっているセッションは
繋ぎ直さない」）、崩してはならない（`packages/web-ui/test/session-reconnect.test.ts` の「`ended` の無い `closed`
（サーバーの後始末）では繋ぎ直しを止めない」も同じ順序 A の系列で、`transport` 原因の `closed` が
はしごを止めないことを固定している——こちらも崩してはならない）。

（`.aidev/charter.md` は無い PJ のため、charter ゴールの紐づけは行わない）

## ユーザーストーリー

- US1: 5250 の操作員として、転送が不安定な回線でホストが終了したときに、正しい理由をすぐ見たい。
  なぜなら いまは無駄なはしご（最大 37 秒）を待たされた末に、押しても無駄な「再接続」ボタンや
  具体性の落ちた理由文が出るから。（受け入れ: AC1, AC2, AC3, AC6）
- US2: この PJ の開発者として、`closed` を寿命の信号として正しい位置に置き直したい。
  なぜなら 前 work が共通ガードに足した `connected` の門は「表示の更新」を守るためのもので、
  `closed` はその範疇に無いことが前 work のレビューと原因究明で判明したから。（受け入れ: AC1, AC4）
- US3: この PJ の開発者として、既存の「`closed` が先に届く」経路（順序 A）の振る舞いを
  変えずにおきたい。なぜなら その経路は既にテストで固定されており（`背景 / 課題`で述べた
  順序 B の誤り文言の復活とは別に）、崩すと寿命の判定が二重の経路を持つことになり、
  前 work が畳んだ「判定は R4 の内側に 1 つだけ」という不変条件が破れるから。（受け入れ: AC5）

## スコープ

### 対象

- `packages/web-ui/src/session-controller.ts` の `applyDisplayMessage`（`case "closed"`）が
  通される経路——共通ガード（`tryResume`）と初回接続の口（`applyFromSessionClient`）の 2 か所。
- `closed` を通す条件（口の同一性のみ。`connected` の要求を外す）の置き場所
  （`packages/web-ui/src/session-link.ts` = R4 の定義側）。
- `hostEnded` が確定したときにはしご（待機タイマー・飛行中の試行）を畳む処理
  （`abortReconnect` の呼び出し）。
- 上記を固定する回帰テスト（`packages/web-ui/test/` 配下）。

### 対象外

- **`closed` 以外の種別（`screen` / `key-done` / `reserved` / `pc-command` / `jobinfo` / `error`）の
  ガード**。前 work `20260910-session-reconnect-freeze` の review ラウンド3 の調査で、寿命を書くのは
  `closed` だけ（他 6 種は表示状態のみを触り、繋ぎ直しが成功すれば自己回復する）と確認済み。
- **VT・プリンターの `onClose`**（backlog の別項目。`20260910-session-reconnect-freeze`
  `decisions.md` D15）。5250 の `applyDisplayMessage` を通らない別経路で、本 work の変更は無関係。
- **`openSession` の Promise が settle しない経路**（backlog の別項目。本 work と独立の既存欠陥）。
- **`closed` の `transport`（`ended` 無し）経路のガード**。`nextLink` の既存規則
  （`transport` は `reconnecting` を上書きしない）で既に保護されており、はしごへの影響は無い。
  本 work が変えるのは `ended === true`（ホスト終了）の扱いのみ。
- 繋ぎ直しの待ち時間の表・試行回数・タイムアウト値の変更。

## 機能要件

- `closed{ended:true}` は、**はしごが走っているか（`link.state === "reconnecting"`）に関わらず**、
  口の同一性が合えば `applyDisplayMessage` まで届く。
- `closed{ended:true}` が届き `link` が `lost/hostEnded` に確定したら、**進行中のはしご
  （待機タイマー・飛行中の試行）を畳む**。以後そのセッションに対して新しい試行は作られない。
- `closed` の既存の副作用（`delete s.notice` / `setBusy(false)`）は変えない——**`connected` の
  要求だけを外し、口の同一性の判定と副作用はそのまま**。

## 非機能要件 / 制約

- **振る舞いの変更は「`closed{ended:true}` がはしごの最中に届いたときの扱い」に閉じる。**
  順序 A（`closed` が先）・`transport` 原因の `closed`・他 6 種のフレームの扱いは変えない。
- **判定の写しを増やさない。** 「口の同一性」は R4 の語彙として `session-link.ts` に置き、
  呼び出し側で組み立て直さない（`packages/*/test/lifetime-flag-containment.test.ts` が緑のままであること）。
- 公開 API・WS プロトコル・永続スキーマは変えない。
- 新規の外部依存を足さない。

## 完了条件 (受け入れ基準)

- [ ] AC1: **順序 B**（`onClose` → 同じ口へ `closed{ended:true}`）で、はしごが 1 段目の待機中に
      `closed` が届くと、`link` が `lost/hostEnded` になり、**新しい試行が作られない**
      （待機タイマーが発火しても `tryResume` が呼ばれない。またはタイマー発火自体をキャンセルする）。
- [ ] AC2: AC1 の状態で、次の打鍵（`sendKey`）で `MSG_SESSION_ENDED` が出る（`MSG_NOT_CONNECTED` や
      `MSG_RECONNECT_GAVE_UP` に塗り替わらない）。
- [ ] AC3: AC1 の状態のまま時間を十分進めても（60 秒）、新しい `WsClient` が作られない
      （`clients.length` が増えない）。
- [ ] AC4: `closed` を通す条件（口の同一性のみ）が `session-link.ts` に定義され、
      `session-controller.ts` の 2 か所（`tryResume` / `applyFromSessionClient`）はそれを呼ぶだけ。
      `lifetime-flag-containment.test.ts` が緑のまま。
- [ ] AC5: 既存の順序 A のテスト（「ホスト側が終わっているセッションは繋ぎ直さない」・
      「`ended` の無い `closed`（サーバーの後始末）では繋ぎ直しを止めない」）が緑のまま。
- [ ] AC6: 打ち切った試行・差し替え済みの古い口からの `closed{ended:true}` は引き続き弾かれる
      （口の同一性が合わない場合。本 work が新たに通す穴にならないことの確認）。
- [ ] AC7: 既存の回帰テストが緑のまま（ベースライン: `20260910-session-reconnect-freeze` の
      test 工程で 5685 passed / 0 failed / 41 skipped）。新規テストはこれに上積みする。
- [ ] AC8: `aidev smoke`（`node launcher/smoke.mjs`）が通る。
- [ ] AC9: AC1〜AC3・AC6 を固定する回帰テストが `packages/web-ui/test/` に追加され、**修正前の
      コードでは落ちる**ことを確認してある（characterization として先に書く）。

> AC7 / AC8 / AC9 は**どのストーリーにも紐づかない横断的な品質ゲート**（回帰・起動確認・
> characterization の先書き）。非参照は意図的。

## 未確定事項 / 確認したいこと

- **U1**: はしごを畳む処理（`abortReconnect(sessionId)`）を、`applyDisplayMessage` の
  `case "closed"` の中に直接置くか、それとも呼び出し元（`tryResume` / `applyFromSessionClient`）に
  置くか。`abortReconnect` は `attempts` Map（module スコープ）を触るので、どちらでも書けるが、
  「寿命が確定したらはしごを畳む」という 1 つの決定を 1 か所に置きたい。→ design で決める。
- **U2**: `closed` を通す新しい述語（口の同一性のみ）の名前と、`acceptsFrame` / `acceptsFromSession`
  との関係。既存の `isSessionClient` をそのまま呼べば足りるか、`tryResume` 側（`Attempt` を持つ）
  用に `isCurrentAttempt(...) || isSessionClient(...)` をまとめた述語が要るか。→ design で決める
  （`research.md` の実装アンカーが入力になる）。
- **U3**: 転送が生きている場合（1.2 秒の無駄な往復）のシナリオもテストで固定するか、それとも
  AC1〜AC3 の「転送も死んでいる」シナリオだけで十分か。→ tasks で判断する。
