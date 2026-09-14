# タスク: ホスト終了がはしごの最中に届くと取りこぼすのを直す

## 実装方針

**壊れていることをテストで固定してから直す**（前 work と同じ順序）。design D-a・D-b・D-c は
3 つとも同じファイル（`session-controller.ts`）を触るので並行はできない——直列に積む。
3 つが揃って初めて AC1〜AC3 が満たされる（design「概要」の非機能要件どおり、1 つだけでは無効）。

## 作業順序と依存関係

- **T1 を最初に置く**。修正後に書いたテストは「緑のまま通るテスト」になり、何も守らない
  （AC9 が「修正前に落ちること」を求めているのはこのため）。
- **T2（述語の追加）は T1 への依存を持たない**——振る舞いを変えないため。
- **T3・T4・T5 は同じファイルの別箇所への追記だが、実装の完成は 3 つ揃って初めて意味を持つ**
  （design「概要」）。順序自体に強い理由は無いので、design の記載順（D-a → D-b → D-c）に倣う。
- 下の `依存:` に従う。

## リスク / 留意点

- **`closed` の先行分岐を追加しても、他 6 種の経路（`acceptsFrame` / `acceptsFromSession` を
  通る側）を 1 行も変えていないことをタスク点検で確かめる**（design「設計方針」の却下案 1）。
- **`abortReconnect` を呼ぶ位置は `case "closed"` の 1 か所だけ**（design「設計方針」の却下案 3）。
  T3・T4 では `abortReconnect` を直接呼ばない——`case "closed"` に通すところまでが仕事。
- **`packages/web-ui/**` は eslint の対象外**。`lifetime-flag-containment.test.ts` の既存走査
  （比較・代入）が緑のままであることを T6 で確認する（新しい述語は `.client ===` を増やさない）。

## テスト方針

- T1 で書く characterization は `packages/web-ui/test/session-reconnect.test.ts` に追加する
  （前 work と同じファイル。土台の `open()` / `reconnected()` / `runAttempt()` / `clients[]` を再利用）。
- **D-a の経路（繋ぎ直しに成功した口が死にかけ）と D-b の経路（初回接続の口が死にかけ）を
  それぞれ 1 件ずつ書く**（design の真理値表 2 行目・5 行目に対応）。
- **AC6（打ち切った試行・古い口からの `closed` は弾かれ続ける）は、既存の複数ホップの
  シナリオ（「打ち切った試行から遅れて届いた画面で、接続中に戻らない」と同じ組み立て）を流用する。**
- **U3 の判断（requirements）**: 「転送が生きている場合」（1.2 秒の無駄な往復で `gone` に至る
  シナリオ）はテストで固定**しない**。AC1〜AC3 が直接検証するのは「転送も死んでいる場合」
  （待機タイマーが発火しないこと）で、これが `abortReconnect` の効果を最も直接に示す。
  「転送が生きている場合」は WS の `open{resume}` → サーバー応答という追加のモック往復が要り、
  検証の追加コストに見合う新しい分岐を通らない（同じ `abortReconnect` の呼び出しを確認するだけ）。
  判断は `decisions.md` に残す。
- 全パッケージの回帰（ベースライン 5685 passed / 0 failed / 41 skipped）と `smoke` は **test 工程**
  で通す（T7。前 work と同じ理由——coding 中には閉じられない）。

## タスク

- [x] T1: はしご走行中に `closed{ended:true}` が届くと取りこぼす characterization テストを追加し、**修正前に落ちる**ことを確認する
      対象: `packages/web-ui/test/session-reconnect.test.ts`（`reconnected()` / `runAttempt()` / 既存の「打ち切った試行から遅れて届いた画面で、接続中に戻らない」を流用）/ 根拠: design「テスト方針」
      依存: なし
      AC: AC1, AC2, AC3, AC6, AC9
- [x] T2: `session-link.ts` に `acceptsLifetimeSignal` を追加する
      対象: `packages/web-ui/src/session-link.ts:266`（`acceptsFrame` の直後）/ 根拠: design「インターフェース / データ構造」
      依存: なし
      AC: AC4
- [x] T3: `tryResume` の共通ガードに `closed` の先行分岐を足す（D-a）
      対象: `packages/web-ui/src/session-controller.ts:503-505` / 根拠: design D-a
      依存: T1, T2
      AC: AC1, AC2, AC3, AC4
- [x] T4: `applyFromSessionClient` に同じ形の先行分岐を足す（D-b）
      対象: `packages/web-ui/src/session-controller.ts:651-654` / 根拠: design D-b
      依存: T3
      AC: AC1, AC2, AC3, AC4
- [x] T5: `case "closed"` に `abortReconnect` の呼び出しを足す（D-c）
      対象: `packages/web-ui/src/session-controller.ts:615-628` / 根拠: design D-c
      依存: T4
      AC: AC1, AC2, AC3
- [x] T6: web-ui のテストと型検査を流し、既存の順序 A のテスト・走査テストが緑のままであることを確認する
      対象: `packages/web-ui/test/session-reconnect.test.ts`（既存の 2 件）/
      `packages/web-ui/test/lifetime-flag-containment.test.ts` /
      `packages/web-ui/tsconfig.json` と `tsconfig.test.json`（`vue-tsc -b`）/
      根拠: design「受け入れ基準との対応」AC5, AC7
      依存: T1, T3, T4, T5
      AC: AC5, AC7
- [x] T8: review ラウンド2 の must（transport 起因の closed が確定済みの notice を消す）を修正し、再入経路のテストを追加する
      対象: `packages/web-ui/src/session-controller.ts`（D-a/D-b の条件を絞る）/
      `packages/web-ui/test/session-reconnect.test.ts`（再現テスト・再入テスト）/
      根拠: review ラウンド2・decisions D6
      依存: T5
      AC: AC1, AC2, AC5, AC7
- [x] T7: 全パッケージの回帰と `smoke` を通す。**このタスクの消化は test 工程**（coding 承認時は未チェックで残る。decisions D4）
      対象: ルート `package.json` の `test` スクリプトと `.aidev/config.yml` の `smokeCommand`
      / 根拠: design「受け入れ基準との対応」AC7, AC8
      依存: T6
      AC: AC7, AC8
