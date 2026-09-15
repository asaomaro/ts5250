# 仕様: `field-validate.ts` を ACS の `Field5250` と突き合わせる

## 概要

**達成したい状態**: `field-validate.ts` の数値専用欄検証（`SHIFT_NUMERIC_ONLY`/
`SHIFT_SIGNED_NUMERIC`）が、ACS のデコンパイル済みコア（`Field5250.
checkNumericOnlyChar()`）と一致し、埋め込みの空白文字を許容する。それ以外の
検証（数字のみ・英字専用・カタカナシフト）は `research.md` F3〜F5 で既に一致が
確認されているため変更しない。自己点検欄（モジュラス10/11）は、判明した制約——(1) 正確な FCW 値が実機
トレース無しでは確定できない、(2) 検証の粒度が既存の文字単位検証と異なり
別設計が要る——を踏まえ、この work では実装を見送り、backlog に記録する
（詳細は「設計方針」参照）。

## 設計方針

代替案として「`checked.trim()` を撤去し、正規表現側で前後の空白も含めて
判定する」ことも検討したが、既存のコメント（43-47行目）が示す通り、
`trim()` には「FFW の ADJUST による右寄せ・空白埋めを尊重する」という
既存の意図があり、無関係にみえて実は必要な処理——**`trim()` は残したまま、
正規表現に空白を追加するだけ**で ACS の挙動に一致する（`research.md`
「実装時の注意」参照）。これにより変更を最小限（1文字の追加）に抑える。

自己点検欄については、`design.md` を書く前に検討した代替案:
- **代替案A（実装する）**: FCW を新しい値として `wtd-applier.ts` に追加し、
  `InternalField` に自己点検フラグを持たせ、`field-validate.ts` とは別の
  「フィールド確定時検証」を新設する。→ 正確な FCW 値が実機トレース無しでは
  確定できず（`research.md` F6）、当て推量の値でパースすると**実際には
  存在しない条件でフィールドを誤判定するリスク**がある（当て推量が外れて
  いた場合、無関係な FCW を自己点検と誤認する、または実際の自己点検 FCW を
  見逃す）。この work のスコープ（静的な突き合わせのみ、実機起動不要）を
  超えるため見送る。
- **代替案B（見送り、backlog へ記録）**: 採用。アルゴリズム・FCW の手がかり・
  実装に必要な次の一歩（実機トレース）を記録し、実機アクセスがある次回の
  work に引き継ぐ。

## 対象範囲

- `packages/tn5250/src/screen/field-validate.ts`: 数値専用欄検証の正規表現を
  変更する（`research.md` A1）。
- `.aidev/backlog/acs-parity.md`: 自己点検欄（モジュラス10/11）を実装しない
  という判断と、実装に必要な情報（アルゴリズム概要・FCW の手がかり・実機
  トレースの必要性）を記録する。
- 対象外（変更しない）: 数字のみ・英字専用・カタカナシフトの検証ロジック
  （`research.md` F3〜F5 で一致を確認済み）、DBCS種別・コードページ許容文字の
  検証（`requirements.md`「対象外」）。

## 依拠する既存の事実

- ACS の `Field5250.checkNumericOnlyChar()` が数字・空白・カンマ・ハイフン・
  ピリオド・プラスを許容すること（`research.md` F2 に該当コードの抜粋あり。
  デコンパイル済みコード全文を確認済み）:
  ```java
  public boolean checkNumericOnlyChar(char c) {
      boolean bl = true;
      if (!Character.isDigit(c) && c != ' ' && c != ',' && c != '-' && c != '.' && c != '+') {
          bl = false;
      }
      return bl;
  }
  ```
- 当プロジェクトの `field-validate.ts` の `checked.trim()` が、FFW の
  ADJUST（右寄せ・空白埋め）を尊重するための既存の意図的な処理であること
  （`field-validate.ts:43-47` の既存コメント、変更前のコード読解で確認）。
- 数字のみ・英字専用・カタカナシフトの検証が既に ACS と一致していること
  （`research.md` F3〜F5）。
- **自己点検欄（モジュラス10/11）の正確な FCW 値が、今回のデコンパイル結果
  からは一意に確定できないこと**（`research.md` F6）。ACS のコンパイル済み
  コードでは FCW カテゴリの判定が `int` に符号拡張された `short` 値への
  `& 0xFFFFFF00` マスク演算で行われており、元の `short` としての正確な
  16進数を定数プールだけからは復元できなかった——これが「設計方針」の
  代替案A（実装する）を却下する中心的根拠。

## インターフェース / データ構造

新しい公開 API は追加しない。既存の正規表現リテラルの変更のみ。

```ts
// packages/tn5250/src/screen/field-validate.ts の numericOnly ブロック内
// 変更前:
const allowed = shift === FFW.SHIFT_DIGITS_ONLY ? /^[0-9]*$/ : /^[0-9.,+-]*$/;
// 変更後（SHIFT_NUMERIC_ONLY/SHIFT_SIGNED_NUMERIC 側にのみ空白を追加。
// SHIFT_DIGITS_ONLY 側は research.md F3 で一致確認済みのため変更しない）:
const allowed = shift === FFW.SHIFT_DIGITS_ONLY ? /^[0-9]*$/ : /^[0-9 .,+-]*$/;
```

## 振る舞いの詳細

- `SHIFT_NUMERIC_ONLY`/`SHIFT_SIGNED_NUMERIC` の欄に埋め込みの空白（例:
  `"1 234"`）を含む値を書き込んでも、`FIELD_TYPE` エラーにならず通るように
  なる——ACS の `checkNumericOnlyChar()` と同じ挙動。
- `SHIFT_DIGITS_ONLY` の欄は変更しない（引き続き空白を含む値は拒否）。
- `trim()` による前後空白の除去は変更しない——正規表現に空白を追加したことで、
  埋め込みの空白**も**追加で許容されるようになるだけで、`trim()` 自体の
  役割（前処理）とは独立して機能する。

## ドメイン固有の考慮

- 該当なし。

## エラー処理 / 異常系

- 該当なし（正規表現の緩和のみで、新しいエラー経路は追加しない）。

## 受け入れ基準との対応

- AC1: 上記の正規表現変更により、ACS の `checkNumericOnlyChar()` と一致する
  （`research.md` F2）。
- AC2: `research.md` F3〜F5 で、数字のみ・英字専用・カタカナシフトの検証が
  既に ACS と一致していることを確認済み。この work ではコードの変更は
  不要——確認結果を `research.md`・本 design.md に記録することで満たす。
- AC3: `research.md` F2〜F6 に、デコンパイルしたコードの具体的な抜粋
  （`checkNumericOnlyChar()`・`checkDigitsOnlyChar()`・`checkAlphaOnlyChar()`・
  `checkKanaShiftChar()`・`modulusCheck()` 等）とともに比較過程を記録済み。
  本 design.md「依拠する既存の事実」にも、判断に直結する抜粋（数値専用欄の
  検証内容）を転記した。
- AC4: `decisions.md` D2 に、自己点検欄の実装を見送る判断とその理由
  （正確な FCW 値が実機トレース無しでは確定できないこと、フィールド確定時
  検証という別粒度の検証が必要になること）を記録する。
- AC5: test 工程で `field-validate.ts` を対象にした既存テスト（あれば）を
  実行し、正規表現変更後も green であることを確認する。
