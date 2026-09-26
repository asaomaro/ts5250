# タスク: O 欄の挿入の必要桁（SO/SI 込み）を ACS に合わせる

## 実装方針
design のとおり、`dbcsType` の挿入の経路に `acsInsertShortOfRoom` を足し、新しいテストで C3・C4（0012）と C5・既存の一致例（変わらない）を固定する。
(c)（継続欄）と入ったあとのバイト列の差は、deliver で `acs-parity.md` に別項目として起票する。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 判定を広げすぎると、既に ACS と一致している挿入（並びの中の全角へ全角など）まで 0012 にする。対象は (i)(ii) の 2 つだけに絞る（design「振る舞いの詳細」）。
- 貼り付け・IME の確定も `dbcsType` を通るので同じ規則になる。複数字の貼り付けで途中から拒否されたときの扱いは既存のまま（requirements の対象外）。

## テスト方針
- 新しいテスト（ScreenGrid を mount して打鍵）: C3・C4（空き 2）→ 0012・値は変わらない／C5（空き 4）→ 入る／C3 の位置で空き 4 → 入る／並びの中の全角へ全角・半角の中へ半角 → 従来どおり入る／
  継続欄・上書き・J 欄・選択の置き換え（`replaced`）は対象外であることを 1 件ずつ。背景の表の B2・B3・C1・C2・F1 も同じ補助の画面で 1 件ずつ（既存テストと重なるが、同じ補助で表を網羅する）。
- 既存の DBCS 系テスト（`dbcs-insert-room`・`insert-no-room` ほか）が通る。mutation で (i)(ii) の各条件を外すと落ちることを確かめる。
- 実機: ACS 側は測定済み（C3・C4・C5）。当 PJ の判定は画面の中身だけで決まる（ホストに問い合わせない）ので、単体テストの画面で同じ状況を再現して確かめる。

## タスク
- [x] T1: `acsInsertShortOfRoom` を足し、`dbcsType` の挿入の経路から呼ぶ
      対象: `packages/web-ui/src/components/ScreenGrid.vue:2225` `dbcsType` / 根拠: research A1・design「振る舞いの詳細」
      依存: なし
      AC: AC1, AC3
- [x] T2: 新しいテスト `dbcs-insert-sosi-room.test.ts` を書く（C3・C4・C5・「C3 の位置で空き 4」・表の B2〜F1・並びの中の全角へ全角・半角の中へ半角・対象外 4 件）
      対象: `packages/web-ui/test/dbcs-insert-sosi-room.test.ts`（新規作成。補助は `test/dbcs-insert-room.test.ts` に倣う）
      依存: T1
      AC: AC1, AC3
- [ ] T3: (c) 継続欄と、入ったあとのバイト列の差を `acs-parity.md` に別項目として起票する（deliver で本項目の消し込みと一緒に行う）
      対象: `.aidev/backlog/acs-parity.md` の「挿入モードの余地の残り（DBCS）」の行 / 根拠: decisions D2（入ったあとのバイト列）・D3（継続欄）
      依存: なし
      AC: AC4
