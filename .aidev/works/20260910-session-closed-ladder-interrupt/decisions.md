# 判断の記録

## D1 三層判定を full とした（2026-09-10T12:58:49Z）

- **背景**: backlog `session-lifecycle.md` から「ホスト終了がはしごの最中に届くと取りこぼす」に着手する。
  `20260910-session-reconnect-freeze` の review ラウンド3 ＋ デバッグ D1 が出自。
  **2 つを 1 つの直しとして入れる必要がある**——片方だけでは無効（デバッグ D1 が実測済み）。
  1. `closed` は表示の更新ではなく寿命の信号なので、共通の門の `link.state === "connected"` の
     要求から外す（口の同一性は残す）。`delete s.notice` / `setBusy(false)` は門の内側に残す。
  2. `hostEnded` / `gone` が確定したらはしごを畳む（`resumeVerdict` を問い直す場所が無く、
     `beginReconnect` が次の段で `hostEnded` を上書きするため）。
- **決定**: `profile: full`（light にしない）。`mode: autonomous`。`humanGates` は置かない。
- **理由・代替案**: light の 4 条件のうち 2 つを満たさない。
  (a) **共有モジュールに触る**——`session-controller.ts` / `session-link.ts` は
  `aidev doctor` が繰り返し名指ししている中心ファイルで、前 work（`20260910-session-reconnect-freeze`）が
  同じファイルで 3 ラウンドのレビュー往復を要した。
  (b) **共通ガードの構造そのものに手を入れる**——`closed` を `applyDisplayMessage` の switch から
  切り出し、別経路（門の緩い述語）で通す形になる見込みで、単一の閉じた挙動に収まらない。
  加えて (2) の「はしごを畳む」は `resumeVerdict` の問い直し位置という **R3 の設計**に踏み込む
  （前 work の `decisions.md` D16 が「HEAD から在る欠陥で本 work の退行ではない」「R3 の設計に
  踏み込む」と明記）。迷ったら full（`protocol-light.md`）。
  mode は前 work と同じ autonomous をユーザーが選択（PR で停止・auto-merge なし）。
- **影響**: 上流 3 工程をそれぞれのゲートで回す。autonomous なので上流 4 文書は `aidev doccheck`、
  coding の各タスクは `aidev taskcheck` の点検記録が必須。deliver で backlog の該当行を `[x]` にする。

## D2 着手前に現物で未着手を確認した（2026-09-10T12:58:49Z）

- **背景**: backlog は遅延キューで、行が `[ ]` のまま残りうる。`aidev status` の `inflight` は
  `session-lifecycle.md` で 0。
- **決定**: 本項目は未着手と判断し、着手する。
- **理由・代替案**: リポジトリの現物で裏を取った——`packages/web-ui/src/session-controller.ts` の
  `case "closed"`（`applyDisplayMessage` 内）は依然 `acceptsFrame` / `acceptsFromSession` の
  `connected` の門を通る形のままで、はしごを畳む処理もどこにも無い（`grep` で `abortReconnect` の
  呼び手を確認済み——`startReconnect` と `giveUpReconnect` のみ）。
- **影響**: 通常どおり回す。

## D3 独立点検を上限まで回した（2026-09-10T13:10:53Z）

- **背景**: `mode: autonomous` のため上流 4 工程の独立点検は必須。requirements で 2 ラウンド回し、
  ラウンド1 で 5 件（must 1 / should 3 / nit 2）、ラウンド2 で 2 件（must 1 / should 1）。
  ラウンド2 の must は**ラウンド1 の自分の修正が作った新しい矛盾**（`wsErrorNotice` と
  `MSG_NOT_CONNECTED` を誤って同一視した）で、`protocol-check.md` が警告する型そのもの。
- **決定**: 指摘 7 件はすべてその場で反映し、`maxDocCheckRounds`（2）に達したのでラウンド3 は回さない。
  research は挟まない——`protocol.md`「4.5」の 5 条件のうち該当するのは「未検証の穴」程度で、
  前 work `20260910-session-reconnect-freeze` の `research.md` / `decisions.md` が実装アンカー・
  到達根拠・呼び手の数え上げまで既に済ませている。design 直接で十分。
- **影響**: design 工程へ進む。上限で止めた点検の残りは深追いせず、review の判断に委ねる。

## D4 T7（全回帰と smoke）の消化は test 工程に置く（2026-09-10T13:26:18Z）

- **背景**: AC7（既存回帰が緑）と AC8（smoke 通過）は coding 中に閉じられない。
- **決定**: T7 を `tasks.md` に立てたうえで、**消化は test 工程**とする（前 work と同じ理由・同じ形）。
- **理由・代替案**: 前 work `20260910-session-reconnect-freeze` の `decisions.md` D6 と同一の判断。
  タスクを立てずに省くと `aidev coverage --strict` が cover gap で落ちる。
- **影響**: test 工程で T7 をチェックする。

## D5 「転送が生きている場合」のシナリオはテストで固定しない（U3 の判断）（2026-09-10T13:26:18Z）

- **背景**: requirements U3——「転送が生きている場合」（1.2 秒の無駄な往復で `gone` に至る
  シナリオ）もテストで固定するか。
- **決定**: 固定しない。AC1〜AC3 は「転送も死んでいる場合」（待機タイマーが発火しないこと）だけを
  検証する。
- **理由・代替案**: 「転送が生きている場合」を固定するには、`tryResume` が新しい `WsClient` を
  作って `open{resume:true}` を送り、サーバー役のモックが `error`（`SESSION_NOT_FOUND`）を返す、
  という追加のモック往復が要る。しかしこのシナリオで確認できることは
  「`abortReconnect` が呼ばれて待機タイマーが畳まれた」という**同じ事実**——
  `abortReconnect` は呼ばれた時点で `attempts`（待機中・飛行中どちらでも）を畳むので、
  「転送が生きているか死んでいるか」は `abortReconnect` の呼び出しそのものには関与しない
  （design「依拠する既存の事実」）。新しい分岐を通らないテストを追加コストをかけて書く理由が無い。
- **影響**: AC1〜AC3 は「転送も死んでいる場合」（待機タイマー未発火）のみで検証する。

## D6 D-a/D-b の条件を `msg.ended === true` に狭める（review ラウンド2 の must）（2026-09-10T14:34:42Z）

- **背景**: 組み込みレビューが、`closed`（`ended` の有無を問わず）を `connected` の門から
  外したことで、**確定済みの諦めの文言（`MSG_RECONNECT_GAVE_UP`）が、同じ口から遅れて届く
  transport 起因の `closed{ended:false}` で黙って消える**ことを指摘した。
  `nextLink` は `link`（`lost/gaveUp`）自体の上書きは防ぐが、`case "closed"` の
  `delete s.notice` はそれを見ずに無条件で走っていた。`SessionState.client` は成功した
  繋ぎ直しが一度も無いセッションでは変わらないため、はしごを使い切ったあとも**同じ口**から
  届くメッセージが D-a/D-b の緩めたガードをそのまま通ってしまう。
- **決定**: D-a・D-b の条件を `msg.type === "closed"` から
  `msg.type === "closed" && msg.ended === true` に狭める。
- **理由・代替案**: 代替案は `case "closed"` の内側で「既に確定済みの終端理由を
  transport 起因の到着で上書きしない」ガードを足す形（`s.link.state === "lost" && cause !== "transport"`
  のときは `ended !== true` なら無視する、等）。却下——requirements が最初から必要として
  いたのは「`hostEnded` の確定がはしごの最中に届くこと」だけで、transport 起因の `closed` を
  緩める理由は元から無かった。ゲート条件を狭めるほうが変更が小さく、**変更を `closed{ended:true}`
  の意味に閉じる**という非機能要件にも直接合致する。
- **影響**: 実測で確認済み——修正前に上記の再現テストが落ち、修正後は緑（既存の順序 A テスト
  「`ended` の無い `closed`（サーバーの後始末）では繋ぎ直しを止めない」も影響を受けず緑のまま。
  あちらは `link.state === "connected"` の状態で届く既存シナリオで、strict 側の `acceptsFrame`/
  `acceptsFromSession` を通るので変わらない）。design.md の D-a・D-b・「依拠する既存の事実」を
  同時に訂正した。
