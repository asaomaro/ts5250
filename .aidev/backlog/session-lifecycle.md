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
- [ ] **繋ぎ直しに成功したあと画面が固まる**（`20260908-session-lifetime-rules-fold` の `decisions.md` D13）。
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
- [ ] 実機（`.env.verify`）で瞬断からの復帰を確認する（`20260908-session-survives-disconnect`
      の「未検証の穴」）。**`20260908-session-lifetime-rules-fold` も単体テストと型のみで実機は通していない**
      ので、この項目はそのまま残る。
- [ ] `packages/web-ui/test/tab-visibility.test.ts` が並列実行時に 5 秒タイムアウトで落ちる。
      CI の並列度かこのテストのタイムアウトを見直す（本件とは無関係の既存フレーク）。
      `20260908-session-lifetime-rules-fold` の test 工程でラウンド1 は落ち・ラウンド2 は落ちなかった
      ——タイミング依存であることの傍証。単体実行では 8 件とも緑。
