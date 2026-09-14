# セッションの寿命・接続状態まわり

- [x] 判定の置き場所を 1 か所に畳む（`20260908-session-survives-disconnect` デバッグ D1）。
      「持ち主が居るか」「猶予中か」「繋ぎ直しの対象か」「この試行はまだ有効か」の 4 規則が、
      独立フラグの組み合わせとして 12〜15 か所に散っている。レビューが 3 ラウンド続けて
      「直した項の隣が壊れる」を出した原因。**振る舞いを変えない差し替え**として行う:
      サーバー = `SessionManager.disposition()` / `lifetimeOf()`、
      クライアント = `SessionState.link` の判別可能 union / `resumable` / `sendToHost` /
      `isCurrentAttempt`。完了条件は既存の回帰テストが緑のまま、かつ
      判定に使うフラグの出現箇所が定義と導出関数の内側に限られること。
      **消し込み: `20260908-session-lifetime-rules-fold`。** 規則は依存ゼロの純粋モジュール 2 本に出した
      （`packages/server/src/session-lifetime.ts` = R1/R2、`packages/web-ui/src/session-link.ts` = R3/R4）。
      クライアントの導出は当初案の `resumable` / `sendToHost` ではなく **`resumeVerdict` / `canSendToHost`**
      になった（前者は review ラウンド1 の must で真偽 → 列挙に変えたため。`decisions.md` D21）。
      サーバーの `lifetimeOf` は純粋側の関数として在り、`SessionManager` 側は `idleLimitOf` のまま
      （改名は見送り。D20-3 で理由を記録）。
      **実測**: `holderToken` 14→0 / `hadHolder` 5→0 / `heldUntil` 10→0 / `attached` 4→0、
      クライアント側 4 フラグ＋2 Map 21→0（`packages/*/test/lifetime-flag-containment.test.ts` が固定）。
      回帰テストは 5664 passed / 0 failed / 41 skipped（ベースライン 5560＋新規 104）。
- [x] 端末種別 × 切れ方 × viewer × 持ち主の全組合せを 1 つの表にし、サーバー・クライアント
      双方をその表から回す（上の畳み込みと同時にやると効果が出る）
      **消し込み: `20260908-session-lifetime-rules-fold`。**
      `packages/web-ui/test/session-lifetime-matrix.ts` に 1 つの表（サーバー 64 行 / クライアント 20 行 /
      門の順序 2 行）。両側の `session-lifetime-matrix.test.ts` がここから回り、`clientViewOf()` の射影で
      両向きに突き合わせる（片側にしか無い行が生まれたら落ちる）。
      **期待値は畳み込みの前に HEAD `90f5636f` の実装から採取**した。
- [x] **繋ぎ直しに成功したあと画面が固まる**（`20260908-session-lifetime-rules-fold` の `decisions.md` D13）。
      `packages/web-ui/src/session-controller.ts` のメッセージ共通ガードが `isCurrentAttempt` だけを見るため、
      成功時に試行を退役させた瞬間から**以後の全フレームが落ちる**（`screen` / `key-done` / `reserved` /
      `pc-command` / `jobinfo` / `closed` / `error`）。利用者から見ると「再接続したのに画面が更新されず、
      応答待ちの覆いとスピナーが永久に残る」。**HEAD `90f5636f` でも再現する**ので畳み込み由来ではない
      （旧 `pendingResumes.get(id)?.client !== client` も同じ効果）。畳み込み work では
      「振る舞いを変えない」制約のため意図的に直していない。
      **直し方の当たり**: ガードに「この口がいま現役か」（`sessionsStore.get(id)?.client === client`）を足す
      ——`session-link.ts` の `Attempt` の docstring が、この項を畳まなかった理由と欠けている事実を記している。
      **直すときの注意**: ガードを緩めると `stores/sessions.ts` の `updateScreen` の遷移が広がった件の
      「到達しない」根拠を検査し直す必要がある。深刻度は高い。
      **消し込み: `20260910-session-reconnect-freeze`。** 判定を R4 の内側に置き直した——
      `packages/web-ui/src/session-link.ts:240` `isSessionClient`（セッションがいま抱えている口か）と
      `:266` `acceptsFrame`（＝`isCurrentAttempt || acceptsFromSession`）。共通ガードは
      `packages/web-ui/src/session-controller.ts:504` でこれを呼ぶだけ。
      **当たりの「この口がいま現役か」を素朴に足すだけでは足りなかった**——
      (1) 差し替えた口が `markRaw` されずリアクティブプロキシになり同一性が壊れていた
      （`stores/sessions.ts:374` `setClient` に閉じた。**成功 → 再切断ではしごが二度と回らない**という
      2 つ目の欠陥がここで判明）、(2) 第 2 項には `link.state === "connected"` の門が要る
      （無いとはしごの最中に死にかけの口で「繋がっている」へ戻る）、(3) 初回接続の口にも同じ門が要る
      （`session-controller.ts:651` `applyFromSessionClient`）。詳細は同 work の `decisions.md` D7・D12・D13。
      **「到達しない」根拠の検査し直しも完了**（`stores/sessions.ts` の `updateScreen` の注記を書き直した）。
      **実測**: テスト 5664 → 5685（+21 件、0 failed / 41 skipped）。変異で 8 件の赤化を確認。
      **残した穴 3 つはこのファイルと下に起票済み**（`closed` の取りこぼし・VT/プリンターの `onClose`・
      `openSession` の Promise）。**実機は未検証。**
- [ ] **同一ファイル内の判定の写しを CI が検知できない**（同 work の `decisions.md` D19 / design「AC2 の詳細」）。
      走査テストは `session-manager.ts` を丸ごと「内側」に置くので、同じ規則の答えをファイル内で
      組み立て直しても落ちない。実際 R1 / R2 の写し 2 件を見つけたのは CI ではなく `cross` 点検だった。
      「写しが増えたら CI が落ちる」（US3）がここだけ成立していない。
      走査の粒度を上げるか、規則を読む口をファイル外から呼ぶ形に変えるかの検討。
      あわせて**分割代入**（`const { hold } = e`）と **`link` の読み**も走査を素通りする。
- [ ] **R4 の `error` 経路と `lifetimeOf` が組合せ表に無い**（同 work の `decisions.md` D17 の積み残し）。
      `session-controller.ts` の `error` 枝のガードはどのテストも覆っていない。
      `lifetimeOf`（持ち主不在の寿命）も表がまったく通らない（門を丸ごと壊しても表は 0 件。
      server 全体では `session-reconnect-grace.test.ts` の 3 件が落ちる）。
      **注記（`20260910-session-reconnect-freeze`）**: 同 work が `error` の経路にテストを 2 件足した
      （繋ぎ直し成功後の `error` ／ 初回接続の口の `error` の通る・落ちるの両方）が、
      **これは D17 の消し込みではない**——組合せ表（`session-lifetime-matrix.ts`）には 1 行も足しておらず、
      `lifetimeOf` はサーバー側で同 work の対象外。表の軸は `Terminal × Disconnect × Role` で
      R4 の軸を持たないため、足すには表の作り直しが要る。
- [ ] 実機（`.env.verify`）で瞬断からの復帰を確認する（`20260908-session-survives-disconnect`
      の「未検証の穴」）。**`20260908-session-lifetime-rules-fold` も単体テストと型のみで実機は通していない**
      ので、この項目はそのまま残る。
- [ ] `packages/web-ui/test/tab-visibility.test.ts` が並列実行時に 5 秒タイムアウトで落ちる。
      CI の並列度かこのテストのタイムアウトを見直す（本件とは無関係の既存フレーク）。
      `20260908-session-lifetime-rules-fold` の test 工程でラウンド1 は落ち・ラウンド2 は落ちなかった
      ——タイミング依存であることの傍証。単体実行では 8 件とも緑。
- [ ] **VT とプリンターの `onClose` にも「この口がまだセッションのものか」の門を当てる**
      （`20260910-session-reconnect-freeze` の `decisions.md` D14 / review ラウンド2 の点検）。
      5250 の 2 か所（`tryResume` と `openSession`）には門を当てたが、`onClose` は全部で 4 つあり、
      VT とプリンターは `sessionsStore.get(sessionId)` の有無だけで判断する。同じ id で開き直すと
      `sessionsStore.add` が口ごと差し替えるので、あとから届く古い口の `close` が
      **健全なセッションを `markLost(transport)` ＋「接続が切れました」にする**。
      踏める経路は現物にある（`ConfigCard.vue` の force 経由で `openPrinterSession` を再度呼ぶと、
      サーバーが同じ `entry.id` を返して `add` が差し替える）。
      **本 work の門はこの 2 つを通らないので、悪化はしていない**（VT・プリンターは
      `updateScreen` / `markConnected` を呼ばず、`not-resumable` ではしごも回らない）。
- [ ] **ホスト終了がはしごの最中に届くと取りこぼす**（`20260910-session-reconnect-freeze` の
      review ラウンド3 ＋ デバッグ D1）。**2 つを 1 つの直しとして入れること**——片方だけでは無効。
      1. `closed` は表示の更新ではなく**寿命の信号**なので、共通の門の `link.state === "connected"` の
         要求から外す（口の同一性は残す＝`acceptsFrame` から `connected` の要求だけを外した述語）。
         **`delete s.notice` / `setBusy(false)` は門の内側に残す**——諦めの文言
         （`MSG_RECONNECT_GAVE_UP`）が消えると、次の打鍵で汎用の `MSG_NOT_CONNECTED` に
         塗り替わって「待てば戻る」という嘘になる（`20260908-session-survives-disconnect` の
         review ラウンド1 で潰した形の再来）。
      2. **`hostEnded` / `gone` が確定したらはしごを畳む**。いま `resumeVerdict` を問うのは
         `startReconnect` の 1 か所だけで、走り出したはしごは誰も止めない
         （`scheduleReconnect` も `tryResume` も問い直さない）。`beginReconnect` が次の段で
         `link` を `reconnecting` に戻して `hostEnded` を消すため、**1 だけ入れても
         最終状態・文言・ボタンが 1 つも変わらない**（デバッグ D1 が実測）。
      **1 は本 work が作った退行、2 は HEAD から在る欠陥**。1 単独では「直った」と言えるテストが
      書けないため、本 work では両方とも入れず対で起票した。
      再現の順序: `onClose()`（見張りの保険で CLOSING のまま）→ 同じ口へ `closed{ended:true}`。
      既存の順序（`closed` → `onClose`）は `session-reconnect.test.ts` が固定済みで影響なし。
- [ ] `openSession` の Promise が settle しないまま残る経路がある
      （`20260910-session-reconnect-freeze` の review ラウンド3）。`opened` / `error` のどちらも
      届かずにソケットが閉じると（プロキシの 1006、upgrade 後にフレーム無しで閉じるサーバー等）、
      `sessionId` が `""` のままなので `onClose` の門が閉じ、`connect()` は既に解決済みなので
      `notifyClosed` の `rejectConnect` も no-op。**開いている最中のスピナーが永久に残る**。
      その枝で reject するか、エラー付きで resolve すれば閉じる。本 work とは独立の既存欠陥。
- [ ] 最近の接続状態維持・再接続対応（session-reconnect-freeze / session-closed-ladder-interrupt 系）以降、今までスムーズだった操作で待たされるタイミングが出るなど不安定化しているとの報告（利用者、20260915）。再現条件・原因未特定。どの変更が影響しているか、直近のreconnect関連workから疑って切り分ける必要がある。（出典: .aidev/works/20260914-seu-page-cursor-hold/decisions.md）
