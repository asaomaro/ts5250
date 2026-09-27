# タスク: telnet の残り

## 実装方針
下の `依存:` に従う。

## テスト方針
- 単体（固定の SEND を IBM i の形に替えて ACS の順を固定）・変異・実機（tap で ACS と並べる・自動サインオン・装置名・社内機）

## タスク
- [x] T1: SEND の順に答える
      対象: `packages/tn5250/src/telnet/telnet.ts` / 根拠: research A1
      依存: なし
      AC: AC1
- [x] T2: 単体の SEND を IBM i の形に替える
      対象: `packages/tn5250/test/helpers/fake-transport.ts` ほか
      依存: T1
      AC: AC1
- [x] T3: 実機の確認
      対象: `scripts/verify-autosignon.mjs`・`scripts/verify-device-name.mjs`
      依存: T1
      AC: AC2
