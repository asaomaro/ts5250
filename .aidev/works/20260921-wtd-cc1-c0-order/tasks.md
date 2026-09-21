# タスク: WTD の CC1=0xC0 で欄が消えない

## 実装方針
2 行の順序を入れ替えるだけ。先に原典で順序を確かめる。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- **順序に意味がある**ことをコメントに残さないと、将来「整理」で戻される。
- 欄の値は `buf.snapshot(...).fields[0].value` で読む（`fieldByIndex` は内部表現で `value` を持たない）。

## テスト方針
- 合成 WTD で MDT を立ててから CC1=0xC0 を当て、**値と MDT の両方**を見る。
- **順序を戻して落ちることを確かめる**（条項 `verify-by-mutation`）。

## タスク
- [x] T1: ACS の `DS5250.processWCC1` の case 6 を原典で確認する。
      対象: `acshod2.jar` の `DS5250.class`（`javap -c -constants`）
      依存: なし
      AC: AC4
- [x] T2: `case 0xc0` の順序を入れ替え、出所コメントを書く。
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` `applyCc`
      依存: T1
      AC: AC1, AC2, AC4
- [x] T3: テストを足す（値が消える・MDT が落ちる）。
      対象: `packages/tn5250/test/wtd-applier.test.ts`
      依存: T2
      AC: AC1, AC2
- [x] T4: mutation で担保を確かめる（順序を戻すと落ちる）。
      対象: `packages/tn5250/src/protocol/wtd-applier.ts`（一時的に戻す）
      依存: T3
      AC: AC3, AC5
