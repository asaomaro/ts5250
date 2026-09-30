# タスク: 触らない桁の目印

## 実装方針
測る（HIDDENC）→ core（目印・snapshot・mergeKeep・setField）→ web-ui（値の読み戻し）→ 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 非表示の欄の値を外へ出さない不変条件を保つ（目印は桁の番号だけ。`keep` は書いたかどうかだけ）

## テスト方針
- 単体（core・セッション・ScreenGrid）・変異・実機

## タスク
- [x] T1: 伏せ字の DBCS 欄の編集を測る
      対象: `scripts/host-src/dscmd.c` `scripts/acs-probe/hidden-dbcs-content.txt`
      依存: なし
      AC: AC1
- [x] T2: core（目印・keep・mergeKeep・setField）
      対象: `packages/tn5250/src/screen/attr-sentinel.ts` `buffer.ts` `types.ts` `packages/tn5250/src/session/session.ts`
      依存: T1
      AC: AC1, AC2
- [x] T3: web-ui・テスト・変異・実機
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `logicalFromCells` `packages/tn5250/test/hidden-keep.test.ts`（新規）`packages/web-ui/test/wide-nul.test.ts` `scripts/verify-browser-hidden-dbcs.mjs`（新規）
      依存: T2
      AC: AC1, AC2
