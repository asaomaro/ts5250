# タスク: DSPFMT でフィールドのオプション入力欄の下線が消えたり、罫線のみ表示される不具合の調査・修正

## 実装方針

`design.md` の通り、`wtd-applier.ts` のオーダー switch に `ORDER.WEA` の `case` を1つ
追加し（T1）、その後ろのオーダーが正しく処理されることを確認する回帰テストを書く（T2）。
既存の属性描画テスト群を実行して回帰が無いことを確認する（T3）。AC3（実機トレースの記録）は
`research.md` で既に充足済みのため、coding では新規の作業を発生させない（T4）。
分割は行わない（変更が1ファイル1ケース+テストという小規模なスコープのため）。

## 作業順序と依存関係

下の `依存:` に従う。T2・T3 は T1 を起点とする（T1 の後に着手する。異なるファイルを
触るため並行着手可）。T4 は依存が無く、いつ着手してもよい。

## リスク / 留意点

- design.md の通り、WEA の**意味的な効果**は実装しない（2バイト読み飛ばして継続するだけ）。
  T1 実装時にうっかり属性を `buf` へ反映させる処理を書き足さないよう注意する。
- T2 の回帰テストは、WEA オーダーの**後ろ**に別のオーダー（例: SF でフィールドを1つ定義する）
  を続けて配置し、それが正しく適用されることまで確認する（修正前の挙動＝WEA 以降が
  丸ごと読み飛ばされる、との対比が取れる形にする）。

## テスト方針

- 自動テストは実機接続なしで完結させる（既存の `wtd-applier.test.ts` 等と同じパターン
  ——手作りの WTD バイト列を `applyDataStream` に流し込む合成テスト）。
- T2: WEA オーダー（`0x12 <attrType> <attrValue>`）を含む WTD を組み立て、
  (a) WEA 自体が例外を投げずに処理されること、(b) WEA の**後ろ**に置いた SF 等のオーダーが
  正しく適用されること（修正前は `default:` 節に落ちて失われていたはずの部分）、
  (c) `warn` コールバックが WEA 受信を報告すること、の3点を確認する。
- T3: 既存の属性描画テスト8ファイル——`packages/web-ui/test/`
  （`screen-grid-colsep.test.ts`、`grid-input-underline.test.ts`、
  `screen-grid-embedded-attr.test.ts`、`screen-grid-gridlines.test.ts`）と
  `packages/tn5250/test/`（`field-attr-bound.test.ts`、
  `screen-buffer-attr-bounds.test.ts`、`wdsf-grid-border.test.ts`、
  `continued-field-attr.test.ts`）——を実行し、green のままであることを確認する
  （design.md「受け入れ基準との対応」AC5）。

## タスク

- [x] T1: `wtd-applier.ts` のオーダー switch に `ORDER.WEA` の `case` を追加する。
      属性タイプ・属性値の2バイトを読み進め、`warn()` で受信を報告し、`buf` への
      書き込みは行わない（design.md「インターフェース / データ構造」の疑似コード通り）。
      対象: `packages/tn5250/src/protocol/wtd-applier.ts:479-486`
      （`ORDER.WDSF` の case と `ORDER.UNKNOWN_1C` の case の間に追加） / 根拠: design.md「対象範囲」「インターフェース / データ構造」
      依存: なし
      AC: AC4, AC6
- [x] T2: WEA オーダーを含む合成 WTD の回帰テストを追加する（新規ファイル、または
      既存の `wtd-applier.test.ts` への追加。ファイル名は coding 時に決定）。
      実施結果: 既存の `wtd-applier.test.ts`「合成データ」describe 内、
      「未知オーダーは警告するが次の ESC から復帰する」テストの直後に追加した
      （同種のシナリオを対比できる位置）。修正前のコードに対して実際に失敗すること
      （discrimination）を `git stash` で一時的に確認済み。
      対象: `packages/tn5250/test/`（新規ファイルの場合はファイル名を coding で決定） / 根拠: design.md「振る舞いの詳細」「受け入れ基準との対応」AC6
      依存: T1
      AC: AC6
- [x] T3: 既存の属性描画テスト8ファイル（テスト方針参照）を実行し、T1 の変更後も
      green のままであることを確認する。
      実施結果: tn5250側4ファイル42件・web-ui側4ファイル39件、全て green
      （test 工程で `test-result.md` に正式に記録する）。
      対象: `packages/web-ui/test/`, `packages/tn5250/test/`（内訳はテスト方針の
      8ファイルを参照） / 根拠: design.md「受け入れ基準との対応」AC5
      依存: T1
      AC: AC5
- [x] T4: AC3（実機トレースで試した具体的な条件と結果の記録）は `research.md` で
      既に充足済みであることを確認する。coding での新規作業は発生しない。
      対象: `.aidev/works/20260914-dspfmt-field-underline-instability/research.md` / 根拠: research.md F5, F6
      依存: なし
      AC: AC3
