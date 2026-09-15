# 調査: `field-validate.ts` を ACS の `Field5250` と突き合わせる

## 調査の問い

- Q1: 数値専用欄（`SHIFT_NUMERIC_ONLY`/`SHIFT_SIGNED_NUMERIC`）の文字種別検証は
  ACS の `checkNumericOnlyChar()` と一致するか。
- Q2: 数字のみ欄（`SHIFT_DIGITS_ONLY`）・英字専用欄（`SHIFT_ALPHA_ONLY`）・
  カタカナシフト欄（`SHIFT_KATAKANA`）の検証は ACS の対応するメソッドと
  一致するか。
- Q3: 自己点検欄（モジュラス10/11）は当プロジェクトに実装されているか。
  無い場合、実装コストはどの程度か。

## 判明した事実

すべて `acsbundle.jar`（`plugins/emulator/acshod2.jar`）から
`com/ibm/eNetwork/ECL/tn5250/Field5250.class` を CFR（OSSデコンパイラ、
`https://github.com/leibnitz27/cfr`）でデコンパイルし、直接読んで確認した
（デコンパイル成果物はリポジトリに含めず、`/tmp` 配下で確認後に削除済み）。

- F1: **FFW の SHIFT ビット（下位3ビット、`FFW.SHIFT_MASK`）の割り当ては、
  当プロジェクトの `constants.ts` と ACS の `Field5250` の
  `isAlphaOnlyField()`/`isNumericOnlyField()`/`isSignedNumericField()`/
  `isKanaShiftField()`/`isDigitsOnlyField()` で完全に一致することを確認した**
  （例: `isDigitsOnlyField()` は `(ffw&0x400)==1024 && (ffw&0x200)==0 &&
  (ffw&0x100)==256` → ビット合成 `0x500`。当プロジェクトの
  `SHIFT_DIGITS_ONLY: 0x0500` と一致）。FFW のビット割り当て自体に食い違いは無い
  ——差はここではなく、各シフト種別に対する**文字レベルの検証内容**にある。
- F2: **数値専用欄（`SHIFT_NUMERIC_ONLY`/`SHIFT_SIGNED_NUMERIC`）で、ACS は
  埋め込みの空白文字を許容する。**
  `Field5250.checkNumericOnlyChar(char c)`:
  ```java
  public boolean checkNumericOnlyChar(char c) {
      boolean bl = true;
      if (!Character.isDigit(c) && c != ' ' && c != ',' && c != '-' && c != '.' && c != '+') {
          bl = false;
      }
      return bl;
  }
  ```
  数字・空白・カンマ・ハイフン・ピリオド・プラスを許容する（1文字ずつの判定、
  位置は問わない）。一方、当プロジェクトの `field-validate.ts`
  （`validateFieldContent()`）は `checked.trim()` してから
  `/^[0-9.,+-]*$/` で判定しており、**空白は前後の trim でしか許容されず、
  埋め込みの空白（例: `"1 234"`）は拒否される**（`current` に元々空白が
  含まれる場合を除く）。→ **Q1 の答え: 一致しない**（空白の扱いのみ）。
- F3: **数字のみ欄（`SHIFT_DIGITS_ONLY`）は一致する。**
  `Field5250.checkDigitsOnlyChar(char c)`:
  ```java
  public boolean checkDigitsOnlyChar(char c) {
      boolean bl = true;
      if (!Character.isDigit(c) && c != '\u0000') {
          bl = false;
      }
      return bl;
  }
  ```
  数字のみ許容（`\u0000`＝NUL文字は内部表現上の未入力セルを表す値で、
  キー入力・貼り付けされる文字には現れないため、当プロジェクトの「打鍵・
  貼り付けされた文字」の検証とは対応しない。**空白ではない**——当初この
  抜粋を `c != ' '`（空白）と誤って書き写していたが、review 工程のタスク
  点検の指摘を受けて再デコンパイルし、`c != '\u0000'`（NUL）が正しいと
  確認した）。当プロジェクトの `field-validate.ts` は `SHIFT_DIGITS_ONLY` に
  `/^[0-9]*$/` を使っており、一致する（結論は変わらず——訂正前から「一致する」
  「`SHIFT_DIGITS_ONLY` は変更しない」という判断自体は正しかった。誤って
  いたのはコード抜粋の書き写しのみ）。
- F4: **英字専用欄（`SHIFT_ALPHA_ONLY`）は一致する。**
  `Field5250.checkAlphaOnlyChar(char c)`:
  ```java
  public boolean checkAlphaOnlyChar(char c) {
      boolean bl = true;
      if (!Character.isUpperCase(c) && !Character.isLowerCase(c) && c != ' ' && c != ',' && c != '-' && c != '.') {
          bl = false;
      }
      return bl;
  }
  ```
  英大文字・英小文字・空白・カンマ・ハイフン・ピリオドを許容する。当プロジェクトの
  `field-validate.ts` は `/^[A-Za-z,.\- ]*$/` を使っており、文字集合が完全に
  一致する（空白も含めて一致——英字専用欄には元々この不一致が無い）。
- F5: **カタカナシフト欄（`SHIFT_KATAKANA`）は、当プロジェクトが検証を
  行っていないことが、ACS の挙動と結果的に一致する。**
  `Field5250.checkKanaShiftChar(char c)`:
  ```java
  public boolean checkKanaShiftChar(char c) {
      return true;
  }
  ```
  常に `true`（無制限）。当プロジェクトの `field-validate.ts` には
  `SHIFT_KATAKANA` に対応する分岐が無く、`numericOnly`・`SHIFT_ALPHA_ONLY` の
  どちらの条件にも合致しないため、この欄に対しては何の制限も掛からない
  （`typed` がそのまま通る）。→ **Q2 の答え: 数字のみ・英字専用・カタカナ
  シフトの3種はいずれも一致する**（数値専用のみ F2 の通り不一致）。
- F6: **自己点検欄（モジュラス10/11）は当プロジェクトに一切実装されていない。**
  ACS の `Field5250` には次のロジックがある:
  - `Modulus10Field`/`Modulus11Field` という内部フラグを持ち、SF に続く
    FCW（Field Control Word）で設定される（`Field5250` コンストラクタ、
    `sArray[i] & 0xFFFFFF00` で FCW カテゴリを判定するswitch文の中、
    `case -20224`（FCWカテゴリマスク一致）のサブケースで
    `Modulus11Field`/`Modulus10Field` をそれぞれ立てる）。
  - `checkModulusField(char[] cArray)`（フィールド全体の文字配列を受け取り、
    最終桁がチェックディジットかどうかを検証する）と、その実体
    `modulusCheck(char[] cArray, int n, char c)` が、標準的なモジュラス
    10/11アルゴリズムを実装している（重み付け: モジュラス10は1・2交互で
    2倍した結果が9より大きければ9を引く、モジュラス11は2〜7を周回する重み。
    チェックディジット桁と計算結果の剰余を比較）。
  - 一方、`packages/tn5250/src/protocol/wtd-applier.ts` の FCW 読み取り
    ループ（`applySf()` 内）は `0x82xx`（DBCS種別）・`0x86xx`（継続入力欄）・
    `0x88xx`（カーソル送り）だけを解釈し、モジュラス10/11 に相当する FCW
    （ACS のコードから逆算すると `0xB0xx`/`0xB1xx` 帯——正確な値は ACS の
    定数プールからは直接読めず、`sArray[i] & 0xFFFFFF00` というマスク演算の
    元の値が int 昇格されているため、`short` としての正確な16進数は今回の
    デコンパイル結果からは一意に確定できなかった）は**未知の FCW として
    無条件に読み飛ばされる**——`while (r.remaining >= 2 && (r.peek() & 0xc0)
    === 0x80)` という「上位2ビットが `10` の2バイトなら FCW として消費する」
    という汎用ループのため、**パース自体は壊れない**（画面が崩れる等の実害は
    無い）。ただし、その FCW が運ぶ「この欄は自己点検欄である」という情報は
    どこにも保持されず、`InternalField` にも自己点検フラグが無く、
    `field-validate.ts` にも対応する検証ロジックが無い。→ **Q3 前半の答え:
    未実装（ただしパース破壊は起きない、feature gap）**。

## 影響範囲

- `packages/tn5250/src/screen/field-validate.ts`: 数値専用欄検証の正規表現
  （F2）が変更対象。
- `packages/tn5250/src/protocol/wtd-applier.ts`・`packages/tn5250/src/screen/
  buffer.ts`（`InternalField`）: 自己点検欄を実装する場合、FCW 解釈の追加と
  フィールド定義への自己点検フラグ追加が必要になる（F6）。

## 実現性 / リスク

- **F2（数値専用欄の空白）の修正は低リスク**——正規表現を1箇所変更するだけで、
  既存の他の検証（数字のみ・英字専用・DBCS種別・コードページ許容文字）には
  影響しない。
- **F6（自己点検欄）の実装はより大きな設計判断を要する**:
  1. 当プロジェクトの `validateFieldContent()` は「打鍵・貼り付けされた
     **差分文字**」を1文字ずつ検証する構造（`current` との差分を取る）だが、
     モジュラス10/11は**フィールド全体の最終値**（特にチェックディジット桁）に
     対して行う検証であり、既存の文字単位検証とは検証の粒度が異なる——
     `validateFieldContent()` に組み込むより、フィールド確定時
     （READ MDT 応答直前等）に別途呼ぶ新しい検証関数が必要になる可能性が高い。
  2. FCW の正確な16進数値（ACS のコンパイル済みコードから `int` 昇格された
     マスク済みの値しか読めず、`short` としての元の値を確定できなかった）を
     確定するには、実機で自己点検欄付きの画面を作り、生バイトを採取する
     必要がある——**この work のスコープ（静的な突き合わせのみ）を超える**。
  3. 実際にモジュラス10/11欄を使うアプリがどの程度あるか（利用頻度）は、
     この静的調査だけでは分からない。
  - **判断（`decisions.md` D2 参照）**: この work では実装を見送り、backlog に
    アルゴリズムと FCW の手がかりを記録した上で、実機での FCW 値確認から
    始める形で次回以降に回す。

## 実装アンカー

- A1: `packages/tn5250/src/screen/field-validate.ts:37-51`（数値専用欄検証の
  正規表現、`numericOnly` ブロック）——F2 の修正対象。

## 実装時の注意

- 数値専用欄の正規表現を「空白を許容する」方向に緩めるとき、**既存の
  `checked.trim()` による前処理をどう扱うか**に注意する。ACS は位置を問わず
  空白を許容するため、`trim()` を残したまま正規表現に空白を追加するだけで
  十分（`trim()` で前後の空白が既に消えているので、正規表現側の空白追加は
  埋め込みの空白だけを新たに許容することになる）。

## design への申し送り

- `field-validate.ts` の数値専用欄（`SHIFT_NUMERIC_ONLY`/`SHIFT_SIGNED_NUMERIC`）
  の正規表現に空白を追加し、ACS の `checkNumericOnlyChar()` と一致させる
  （F2、A1）。`SHIFT_DIGITS_ONLY` 用の正規表現は変更しない（F3、既に一致）。
- 自己点検欄（モジュラス10/11）の実装は見送り、backlog へ記録する（F6）。
  記録する内容: モジュラス10/11のアルゴリズム概要（重み付けの規則）、
  FCW経由で伝わること、正確なFCW値の確認には実機トレースが必要なこと。
