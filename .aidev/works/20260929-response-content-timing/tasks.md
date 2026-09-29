# タスク: READ SCREEN の応答を命令の時点の画面で組む

## 実装方針
実機で ACS と当 PJ の差を確かめてから直し、直した後にもう一度実機で確かめる。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 保留（`hostHeld`）や否定応答で途中打ち切りになるレコードで、応答が二重・別の状態にならないこと（独立点検で確認）

## テスト方針
- 単体（session の fake transport）と実機（DSM の READSCRTIMING）。適用側だけ・セッション側だけの変異で落ちること

## タスク
- [x] T1: DSM の SAVETIMING・READSCRTIMING モードと ACS のワイヤの測定
      対象: `scripts/host-src/dscmd.c` `scripts/acs-probe/save-timing.txt` `scripts/acs-probe/read-screen-timing.txt`
      依存: なし
      AC: AC2
- [x] T2: READ SCREEN の応答を命令の時点で組む（applier の option と応答枠・セッション）
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` `packages/tn5250/src/session/session.ts` / 根拠: research A1, A2
      依存: T1
      AC: AC1
- [x] T3: 単体テスト
      対象: `packages/tn5250/test/read-screen-timing.test.ts`（新規）
      依存: T2
      AC: AC1
- [x] T4: 実機で当 PJ のコアを確かめる
      対象: `scripts/verify-read-screen-timing.mjs`（新規）
      依存: T2
      AC: AC2
