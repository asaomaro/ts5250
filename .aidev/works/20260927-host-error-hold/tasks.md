# タスク: ホストのエラーの間の WTD の保留

## 実装方針
core → server → web-ui → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 抜ける知らせが届かないと画面が止まる（AID でも抜ける）。

## テスト方針
- tn5250・server 全体、web-ui の関係するファイル。実機の ERRMSG*。

## タスク
- [x] T1: core の保留（`holdWtd`・溜め・`dismissHostError`・AID で抜ける）
      対象: `packages/tn5250/src/protocol/wtd-applier.ts`・`packages/tn5250/src/session/session.ts` / 根拠: research A1・A2
      依存: なし
      AC: AC1
- [x] T2: server の `dismiss-host-error`
      対象: `packages/server/src/ws-messages.ts`・`packages/server/src/ws-handler.ts` / 根拠: research A3
      依存: T1
      AC: AC2
- [x] T3: web-ui の `exitErrorMode` から送る
      対象: `packages/web-ui/src/components/EmulatorPane.vue` / 根拠: research A3
      依存: T2
      AC: AC2
- [x] T4: テスト（core・web-ui）
      対象: `packages/tn5250/test/host-error-hold.test.ts`・`packages/web-ui/test/host-error-mode.test.ts`
      依存: T1, T3
      AC: AC1, AC2
- [x] T5: 実機の検証
      対象: `scripts/verify-error-msgline-wtd.mjs`
      依存: T1
      AC: AC3
