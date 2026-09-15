# タスク: `field-validate.ts` を ACS の `Field5250` と突き合わせる

## 実装方針

`design.md` の通り、`field-validate.ts` の数値専用欄検証（`SHIFT_NUMERIC_ONLY`/
`SHIFT_SIGNED_NUMERIC`）の正規表現に空白を追加し、ACS の `checkNumericOnlyChar()`
と一致させる（T1）。数字のみ・英字専用・カタカナシフトの検証は既に一致していると
確認済み（research.md F3〜F5）のため、coding での新規作業は発生しない（T2）。
既存のテストがあれば実行して回帰が無いことを確認する（T3）。自己点検欄
（モジュラス10/11）は実装を見送るため、`.aidev/backlog/acs-parity.md` への記録を
deliver 工程で行う（T4）。AC3（比較過程・判断根拠の記録）は `research.md`・
`design.md`・`decisions.md` で既に充足済みのため、coding での新規作業は
発生しない（T5、T2 と同種の「確認のみ」タスク）。分割は行わない（正規表現1箇所の
変更のみ）。

## 作業順序と依存関係

下の `依存:` に従う。T1 が起点。T3 は T1 に依存（変更後のコードで既存テストを
実行するため）。T2・T4・T5 は依存が無く、いつ着手してもよい——T2・T5 は既存文書
（research.md・design.md・decisions.md）の確認のみ、T4 は deliver 工程で実施する
backlog 記録。

## リスク / 留意点

- 正規表現の変更（`/^[0-9.,+-]*$/` → `/^[0-9 .,+-]*$/`）は `SHIFT_NUMERIC_ONLY`/
  `SHIFT_SIGNED_NUMERIC` にのみ適用し、`SHIFT_DIGITS_ONLY`（`/^[0-9]*$/`、
  変更しない）と混同しないこと。
- `checked.trim()` は変更しない（`design.md`「振る舞いの詳細」参照）。

## テスト方針

- T3: `field-validate.ts` を対象にした既存テストを検索し、あれば実行する。
  埋め込み空白を含む数値専用欄の値（例: `"1 234"`）が、修正前は
  `FIELD_TYPE` エラーになり、修正後は通ることを新規テストで確認する
  （discrimination）。数字のみ欄（`SHIFT_DIGITS_ONLY`）には埋め込み空白を
  含む値が引き続き拒否されることも確認する（回帰確認）。

## タスク

- [x] T1: `field-validate.ts` の数値専用欄検証の正規表現に空白を追加する。
      対象: `packages/tn5250/src/screen/field-validate.ts:42`（`research.md` A1）
      / 根拠: design.md「インターフェース / データ構造」
      依存: なし
      AC: AC1
- [x] T2: AC2（数字のみ・英字専用・カタカナシフトの検証が既に ACS と一致して
      いること）は `research.md` F3〜F5 で既に充足済みであることを確認する。
      coding での新規作業は発生しない。
      対象: `.aidev/works/20260915-acs-field-validation-audit/research.md`
      / 根拠: research.md F3-F5
      依存: なし
      AC: AC2
- [x] T3: `field-validate.ts` を対象にした既存テストを実行し、T1 の変更後も
      green のままであることを確認する。埋め込み空白を含む数値専用欄
      （`SHIFT_NUMERIC_ONLY`/`SHIFT_SIGNED_NUMERIC`）の discrimination テストを
      新規追加し、あわせて `SHIFT_DIGITS_ONLY` 欄では埋め込み空白が引き続き
      拒否される（T1 の変更が波及していない）ことを確認する回帰テストも追加する
      （「テスト方針」参照）。
      対象: `packages/tn5250/test/`（既存テストファイルを検索して特定する）
      / 根拠: design.md「受け入れ基準との対応」AC5
      依存: T1
      AC: AC5
- [x] T4: `.aidev/backlog/acs-parity.md` に、自己点検欄（モジュラス10/11）の
      実装見送りとその理由、実装する場合の次の一歩を記録する。deliver 工程で
      実施する（coding での新規作業は発生しない）。
      対象: `.aidev/backlog/acs-parity.md` / 根拠: design.md「受け入れ基準との対応」AC4
      依存: なし
      AC: AC4
- [x] T5: AC3（比較過程・判断根拠の記録）は `research.md`・`design.md`・
      `decisions.md` で既に充足済みであることを確認する。coding での新規作業は
      発生しない。
      対象: `.aidev/works/20260915-acs-field-validation-audit/decisions.md`
      / 根拠: research.md F1-F6, design.md「依拠する既存の事実」
      依存: なし
      AC: AC3
