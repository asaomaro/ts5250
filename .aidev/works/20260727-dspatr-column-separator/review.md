# レビュー記録

## ラウンド 1

差分 2 ファイル（`ScreenGrid.vue` / `styles.css`）＋テスト 3 件。

### 要件適合・正確性

- **報告書の指摘を現リポジトリで実地確認した**: `packages/web-ui/src` に
  `columnSeparator` の参照は 0 件で、core が持つ属性を描画側が完全に素通ししていた
- 修正前に落ちるテストを先に書き、`cls.push("a-colsep")` を外して**落ちることを確認**した
- 桁区切りが無い画面に `a-colsep` が出ないことも固定（R1）
- `attrByteClass` にも入れたので、入力欄の色バンド経由でも同じ扱いになる（R3）

### 指摘

- [nit] 報告書は (1) を「対応済み」としていたが、**この差分は受領 PDF に含まれていなかった**。
  報告元環境のローカル修正と判断し、こちらで実装し直した。
  内容は報告書の記述（`a-colsep` / `border-left: 1px solid currentColor`）に合わせている。
  ／ 対応: 記録のみ

### 再検証

- クリーンビルド ／ lint ／ `vue-tsc` 込み web-ui ビルド：成功
- web-ui 912 件（＋3）通過

**判定: must 0 / should 0 / nit 1（記録のみ）。review 通過。**
