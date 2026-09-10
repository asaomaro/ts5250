# タスク: 繋ぎ直し成功後のフレーム遮断を R4 の内側で塞ぐ

## 実装方針

**壊れていることをテストで固定してから直す**。`research.md` F8 のとおり「成功した口の後続フレームを
送るテスト」は 1 件も無く、その空白が本件を生かしていた。先にテストを書けば、修正が効いたことも、
既存の遮断（AC4）を壊していないことも同じ実行で分かる。

そのうえで design の D-a〜D-d を順に当てる——規則の追加（`session-link.ts`）→ 呼び出し側の差し替え
（`session-controller.ts` 2 か所）→ 注記の書き直し（2 か所）。実装の変更は `stores/sessions.ts` には**無い**。

## 作業順序と依存関係

- **T1 は、それが固定する修正（T3）より前に置く**。修正後に書いたテストは「緑のまま通るテスト」に
  なり、何も守らない（requirements AC10 が「修正前に落ちること」を求めているのはこのため）。
  **この順序は下の `依存:` にも書いてある**（T3 が T1 に依存する）——本文だけの約束にすると、
  `依存:` を読む coding には届かない。
- **T1 が固定するのは T3 が変える振る舞いだけ**。T2（述語の追加）と T4（呼び替え）は
  振る舞いを変えないので、**T1 への依存を持たない**——T4 が `依存: T2` を持つのは、呼ぶ述語が
  T2 で追加されるため。
- **T9 を T3 / T4 より前に置く**（coding 中に判明。`decisions.md` D7）。口の同一性が
  リアクティブプロキシで壊れているので、**先に直さないと T3 の差し替えも効かない**
  （T1 の独立点検が実測）。T4 が「真偽の変わらない呼び替え」でいられるのも T9 の後だけ。
- **注記は、それが記述する実装が確定してから書き直す**——先に書くと、実装が変わったときに
  片方だけ古くなる（`.aidev/conventions/comment-provenance.md` 1）。かかる先はタスクごとに違う:
  T5（`Attempt` の docstring）は述語の追加と 2 か所の呼び出しを記述するので **T3 と T4**、
  T6（`updateScreen` の注記）は**共通ガードだけ**を記述するので **T3** に依存する。
- 残りは下の `依存:` に従う。

## リスク / 留意点

- **`session-controller.ts` の中で判定を直書きしても走査テストは通る**（`research.md` F9）。
  T3 / T4 で `acceptsFrame` / `isSessionClient` を**呼ぶだけ**にできているかは、型と review でしか
  守れない（AC7）。タスク点検の観点に入れる。
- **`packages/web-ui/**` は eslint の対象外**。lint は当てにできない。
- **テストのフェイク `WsClient` は閉じた後もメッセージを配送できる**（`research.md` F7）。
  実機より緩いので、テストが緑でも「閉じた口からは来ない」の証明にはならない
  （design「エラー処理 / 異常系」の既知の制約）。
- 対になる資産（`.aidev/conventions/paired-artifact-sync.md`）: 走査テストはサーバー／クライアントの対だが
  **規則を変えないので同期は不要**。ただし review で対の側に当たっているかを確かめる（design「対象範囲」）。

## テスト方針

- **T1 で書く characterization** は `packages/web-ui/test/session-reconnect.test.ts` に追加する
  （新規ファイルにしない——土台の `open()` / `runAttempt()` / モック `WsClient` がこのファイル内にある）。
  形は既存の「打ち切った試行から遅れて届いた画面で、接続中に戻らない」と対にする
  （**同じ流れで、成功した口の側は通る**ことを見る）。
- 見るのは 3 つ: `screen` が反映される（AC1）/ `key-done` で待ちが解ける（AC2）/
  `reserved` `pc-command` `jobinfo` `closed` `error` が届く（AC3）。
- **既存テストは 1 件も書き換えない**。AC4 は既存の遮断テストが**そのまま**緑であることが条件。
- 全パッケージの回帰（ベースライン 5664 passed / 0 failed / 41 skipped）と `smoke` は **test 工程**で通す（T8）。

## タスク

- [x] T1: 繋ぎ直し成功後の後続フレームを送る characterization テストを追加し、**修正前に落ちる**ことを確認する
      対象: `packages/web-ui/test/session-reconnect.test.ts:103-108`（`open()`）/ `:81-83`（`runAttempt`）/ `:455-466`（対にする既存テスト）/ 根拠: research A5
      依存: なし
      AC: AC1, AC2, AC3, AC10
- [x] T2: `session-link.ts` に `isSessionClient` と `acceptsFrame` を追加する（`isCurrentAttempt` は変更しない）
      対象: `packages/web-ui/src/session-link.ts:215` `isCurrentAttempt` の直後 / 根拠: research A2
      依存: なし
      AC: AC7
- [x] T3: 繋ぎ直し経路のメッセージ共通ガードを `acceptsFrame(...)` に差し替える
      対象: `packages/web-ui/src/session-controller.ts:483` / 根拠: research A1
      依存: T1, T2, T9
      AC: AC1, AC2, AC3, AC4, AC7
- [x] T4: `tryResume` の `onClose` の生の口比較を `isSessionClient(...)` に寄せる（真偽は変えない）
      対象: `packages/web-ui/src/session-controller.ts:493` / 根拠: research「実装時の注意」
      依存: T2, T9
      AC: AC5, AC7
- [x] T5: `Attempt` の docstring を「欠けている」から「`acceptsFrame` として R4 の内側に置いた」へ書き直す
      対象: `packages/web-ui/src/session-link.ts:176-183` / 根拠: research A3・design D-d の 1
      依存: T3, T4
      AC: AC7
- [x] T6: `updateScreen` の「到達しない」注記を、何が弾かれ続け何がブラウザ仕様頼みかを書き分ける形に書き直す（実装は変えない）
      対象: `packages/web-ui/src/stores/sessions.ts:436-452` / 根拠: research A4・design D-d の 2・decisions D5
      依存: T3
      AC: AC6
- [x] T9: 繋ぎ直し成功時の口の差し替えを `markRaw` にし、成功 → 再切断ではしごが回ることを固定する
      対象: `packages/web-ui/src/session-controller.ts:443`（口の差し替え）と
      `packages/web-ui/src/stores/sessions.ts` の `add()` の隣（`setClient` を新設）/ 根拠: research A7・A8・decisions D7, D8
      依存: T1
      AC: AC5
- [x] T10: 共通ガードの第 2 項に `connected` の門を付ける（review ラウンド1 の must。`decisions.md` D12）
      対象: `packages/web-ui/src/session-link.ts` の `acceptsFrame` と
      `packages/web-ui/src/session-controller.ts` の呼び出し / 根拠: review ラウンド1・decisions D12
      依存: T3
      AC: AC1, AC2, AC3, AC4
- [x] T11: 第 2 項を `acceptsFromSession` として切り出し、初回接続の口にも当てる（review ラウンド2 の must。`decisions.md` D13）
      対象: `packages/web-ui/src/session-link.ts` の `acceptsFromSession` と
      `packages/web-ui/src/session-controller.ts` の `applyFromSessionClient`・`openSession` の `onClose`
      / 根拠: review ラウンド2・decisions D13, D14
      依存: T10
      AC: AC1, AC2, AC3, AC4
- [x] T7: web-ui のテストと型検査を流し、既存の遮断テストと走査テストが緑のままであることを確認する
      対象: `packages/web-ui/test/session-reconnect.test.ts:455-466` / `packages/web-ui/test/lifetime-flag-containment.test.ts` / 根拠: research A5・A6
      依存: T1, T3, T4, T5, T6, T9
      AC: AC4, AC7
- [x] T8: 全パッケージの回帰と `smoke` を通す。**このタスクの消化は test 工程**（coding 承認時は未チェックで残る。decisions D6）
      対象: ルート `package.json` の `test` スクリプト（`npm run test --workspaces --if-present`）と
      `.aidev/config.yml` の `smokeCommand`（`node launcher/smoke.mjs`）
      依存: T7
      AC: AC8, AC9
