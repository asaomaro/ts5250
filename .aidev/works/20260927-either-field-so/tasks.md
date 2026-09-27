# タスク: 空にした E 欄の全角・半角の状態

## 実装方針
下の `依存:` に従う。

## テスト方針
- 単体（core・server・web-ui の 3 層）・変異・実機（`scripts/verify-either-empty.mjs`）

## タスク
- [x] T1: core の `setField` / `setFieldValue` の `opts.eitherDbcsOn`
      対象: `packages/tn5250/src/session/session.ts`・`packages/tn5250/src/screen/buffer.ts` / 根拠: research A3
      依存: なし
      AC: AC1, AC2
- [x] T2: ws の `fields[].eitherDbcsOn`
      対象: `packages/server/src/ws-messages.ts`・`ws-handler.ts` / 根拠: research A2
      依存: T1
      AC: AC1, AC2
- [x] T3: 画面の側の状態を送る
      対象: `packages/web-ui/src/components/ScreenGrid.vue`・`EmulatorPane.vue`・`session-controller.ts`・`stores/sessions.ts` / 根拠: research A1
      依存: T2
      AC: AC1
- [x] T4: 実機の検証・ACS の測定・片付け
      対象: `scripts/verify-either-empty.mjs`・`scripts/acs-probe/either-switch-empty.txt`
      依存: T1, T2, T3
      AC: AC1
