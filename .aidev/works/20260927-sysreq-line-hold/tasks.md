# タスク: ホストのエラーの保留の残り

## 実装方針
design のとおり。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 画面の側の SysReq の行と、コアの保留がずれると出力が止まったままになる（切断・フォーカスを失うときも閉じる知らせを送る）

## テスト方針
- 単体・変異・実機

## タスク
- [x] T1: SysReq の行の保留（core・server・web-ui）
      対象: `packages/tn5250/src/session/session.ts`・`packages/server/src/ws-messages.ts`・`ws-handler.ts`・`packages/web-ui/src/components/EmulatorPane.vue`・テスト / 根拠: research A1〜A3
      依存: なし
      AC: AC1
- [x] T2: 保留の間の CC2 の持ち越し
      対象: `packages/tn5250/src/session/session.ts`・`test/host-error-hold.test.ts` / 根拠: research A1
      依存: T1
      AC: AC2
- [x] T3: CANCEL INVITE・RESTORE の READ の印
      対象: `packages/tn5250/src/session/session.ts`・`test/wec-only-unlock.test.ts` / 根拠: research A1
      依存: なし
      AC: AC3
- [x] T4: DSM のモード・プローブ・検証スクリプト・README・片付け
      対象: `scripts/host-src/dscmd.c`・`scripts/acs-probe/sysreq-line-hold.txt`・`hold-cc2.txt`・`scripts/verify-sysreq-line-hold.mjs`・`scripts/README.md`
      依存: T1, T2
      AC: AC1, AC2, AC4
