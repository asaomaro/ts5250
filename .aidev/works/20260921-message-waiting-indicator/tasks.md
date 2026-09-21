# タスク: メッセージ待ち表示（MW）を出さない

## 実装方針
3 層を下から積む。**つなぎごとにテストを置く**（1 層だけだと、つなぎが抜けても緑になる）。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- **セッション層のつなぎは単体テストの死角**——解析と表示だけ固定すると、間が抜けても緑。
- `--t-cyan` は未定義。使うと色が付かない。

## テスト方針
- 解析（wtd-applier）・つなぎ（セッション）・表示（StatusBar）の 3 か所に置き、
  **つなぎを 1 つずつ外して落ちることを確かめる**。

## タスク
- [x] T1: 原典で `processWCC2` の MW ビットと評価順を確かめる。
      対象: `acshod2.jar` の `DS5250.class`
      依存: なし
      AC: AC1
- [x] T2: 型と `applyCc2`。
      対象: `packages/tn5250/src/screen/types.ts` `packages/tn5250/src/protocol/wtd-applier.ts`
      依存: T1
      AC: AC1
- [x] T3: セッションへの反映とスナップショット。
      対象: `packages/tn5250/src/session/session.ts`
      依存: T2
      AC: AC2
- [x] T4: ステータスバーの表示灯。
      対象: `packages/web-ui/src/components/StatusBar.vue`
      依存: T3
      AC: AC3
- [x] T5: 3 層それぞれのテストと mutation。
      対象: `wtd-applier.test.ts` `alarm-and-query-size-session.test.ts` `status-bar.test.ts`
      依存: T2, T3, T4
      AC: AC4
