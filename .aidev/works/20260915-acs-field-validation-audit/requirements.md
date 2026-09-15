# 要件: フィールド入力値検証（`field-validate.ts`）を ACS のコア実装と突き合わせる（第2弾）

## 背景 / 課題

利用者から「全体的にACSを手本に見直しを図ってください」との要望（20260915）を受け、
`.aidev/works/20260915-acs-protocol-order-audit`（第1弾、WTD オーダー switch と
文字書き込み処理の突き合わせ）を実施済み。利用者から「引き続き、acs.jarのコードとの
突き合わせ点検を続けて」との依頼があり、第2弾として `packages/tn5250/src/screen/
field-validate.ts`（フィールド入力値の内容検証）を対象に、ACS のデコンパイル済み
コア（`Field5250` クラス）と突き合わせる。

`field-validate.ts` は現状、GNU tn5250・tn5250j という2つのOSS参照実装とだけ
突き合わせて書かれており（ファイル内コメント参照）、ACS との突き合わせは
行われていなかった。予備調査（本セッション内、`Field5250.class` をデコンパイルして
実施）で、次の2点の食い違いを発見した:

1. **数値専用欄（`SHIFT_NUMERIC_ONLY`/`SHIFT_SIGNED_NUMERIC`）で、ACS は埋め込みの
   空白文字を許容している**（`Field5250.checkNumericOnlyChar()`）が、当プロジェクトは
   前後の空白のみ許容し、埋め込みの空白は拒否している（`field-validate.ts` の
   `checked.trim()` してから正規表現判定する実装）。
2. **自己点検欄（モジュラス10/11、FCW `0xB0xx`系）が当プロジェクトに一切実装されて
   いない**——`wtd-applier.ts` の FCW 読み取りループは未知の FCW を安全に読み飛ばす
   （パース破壊は起きない）が、`Field5250.checkModulusField()`/`modulusCheck()` に
   相当するチェックディジット検証ロジックが存在しない。

この開発環境には ACS 実機が無く、実機同時比較はできない（`.aidev/works/
20260914-seu-page-cursor-hold` decisions.md D6）。この work は**プロトコル仕様レベルの
静的な突き合わせ**（デコンパイル済みコードの読解）に限定し、ACS・実機起動のどちらも
必要としない——第1弾（`20260915-acs-protocol-order-audit`）と同じ性質の work である。

## 目的 / ゴール

`field-validate.ts` の文字種別検証ロジックが、ACS のデコンパイル済みコア
（`Field5250`）の対応するロジックと一致している状態、または一致していない箇所が
明示的に記録され、対応方針（この work で直す／別途 backlog へ回す）が決まっている
状態を達成する。

## ユーザーストーリー

- US1: 開発者（このプロジェクトの保守者）として、当プロジェクトの入力値検証が
  ACS の実装と一致しているかを知りたい。なぜなら、GNU tn5250・tn5250j という
  2つの参照実装だけでは、IBM純正クライアントであるACSとの食い違いに気づけず、
  利用者がACSからの移行時に「入力できたはずの値が拒否される／逆に拒否されるべき
  値が通ってしまう」という体験の差に困る可能性があるため。（受け入れ: AC1, AC2, AC3, AC5）
- US2: このエミュレータの利用者として、チェックディジット付きの欄（社員番号・
  口座番号等でよく使われる）に不正な値を入力したとき、ACS と同じタイミングで
  エラーになってほしい。なぜなら、現状は自己点検欄という概念自体が実装されて
  おらず、本来ホスト側でも弾かれるはずの入力がクライアント側では素通りしてしまう
  ため。（受け入れ: AC4）

## スコープ

### 対象

`packages/tn5250/src/screen/field-validate.ts` の文字種別検証を、ACS の
`Field5250` の対応するメソッドと1対1で突き合わせる:

| 当プロジェクトの検証カテゴリ | ACS の対応メソッド |
|---|---|
| 数値専用（`SHIFT_NUMERIC_ONLY`/`SHIFT_SIGNED_NUMERIC`） | `checkNumericOnlyChar()` |
| 数字のみ（`SHIFT_DIGITS_ONLY`） | `checkDigitsOnlyChar()` |
| 英字専用（`SHIFT_ALPHA_ONLY`） | `checkAlphaOnlyChar()` |
| カタカナシフト（`SHIFT_KATAKANA`。当プロジェクトは現状検証を行っていない） | `checkKanaShiftChar()`（常に `true`＝無制限） |

自己点検欄（モジュラス10/11、FCW）が当プロジェクトに実装されていないことの
記録、および実装するかどうかの判断（`wtd-applier.ts` の FCW 読み取り・
`buffer.ts` の `InternalField`・`field-validate.ts` の検証ロジックが対象になりうる）
も対象に含める。

### 対象外

- ACS の UI 描画層・実機起動を要する検証（この開発環境では実行できない）。
- `checkBidiChar`・`checkArabicNum`（アラビア語/BIDI固有の文字検証）——当プロジェクトの
  対応状況・優先度は別途 backlog で扱う（この work のスコープでは深追いしない。
  理由: 現状 BIDI/アラビア語サポート自体の対応状況が本 work の主眼である数値/英字
  検証と別軸のため）。
- `checkMandatoryFillField`（必須入力欄の未入力チェック）——`packages/web-ui/src/
  composables/mandatoryCheck.ts` で既に別途対応済みと見られ（予備調査で確認）、
  この work では突き合わせない。
- **DBCS種別（`DBCSOnlyField`/`DBCSEitherField`/`DBCSOpenField`）の欄種別判定
  そのもの**——ACS 側はこれらを `checkXxxChar`系のメソッドではなく FCW 由来の
  フィールド種別として保持しており、当プロジェクトの `isDbcsChar` ヘルパー
  （文字がDBCSかどうかの判定）とは対応の粒度が異なる。1対1で突き合わせるには
  別途スコープを切る必要があるため、この work では対象外とする。
- **コードページ許容文字（SUB置換文字の拒否）**——ACS の `Field5250` に直接対応する
  メソッドが予備調査では見つからなかった（`PS5250` や codepage 関連クラスに
  あるかもしれないが、`Field5250` の対象範囲を超えるため今回は調査しない）。

## 機能要件

- `field-validate.ts` の数値専用欄検証（`SHIFT_NUMERIC_ONLY`/`SHIFT_SIGNED_NUMERIC`）が、
  埋め込み空白の扱いについて ACS の `checkNumericOnlyChar()` と一致しているか判定し、
  一致しない場合は修正するか、意図的な相違として記録するかを決める。
- `field-validate.ts` の数字のみ欄検証（`SHIFT_DIGITS_ONLY`）が ACS の
  `checkDigitsOnlyChar()` と一致しているかを確認する。
- `field-validate.ts` の英字専用欄検証（`SHIFT_ALPHA_ONLY`）が ACS の
  `checkAlphaOnlyChar()` と一致しているかを確認する。
- カタカナシフト欄（`SHIFT_KATAKANA`）について、当プロジェクトが現状検証を
  行っていないことが、ACS の `checkKanaShiftChar()`（常に `true`＝無制限）と
  結果的に整合しているかを確認する。
- 自己点検欄（モジュラス10/11）の扱いについて、当プロジェクトが実装するかどうかを
  判断する（実装コストと実際の利用頻度を踏まえる）。

## 非機能要件 / 制約

- **推測のみでの修正をしない**: ACS のコードは実際にデコンパイルして読んだ内容を
  根拠にする（要約や記憶に頼らない）。デコンパイルした成果物（.java ファイル）は
  リポジトリに含めない（プロプライエタリコードのため。`/tmp` 配下で作業し、
  確認後に削除する）。
- **確認できていないことを確認済みと書かない**: ACS の実際の見た目の挙動
  （UI層）ではなく、コアのコード（`Field5250` 等）の静的な読解であることを
  明示する。

## 完了条件 (受け入れ基準)

- [ ] AC1: `field-validate.ts` の数値専用欄検証（埋め込み空白の扱い）が、ACS の
      `Field5250.checkNumericOnlyChar()` と比較され、対応方針（修正する／意図的な
      相違として記録する）が決まっている。
- [ ] AC2: `field-validate.ts` の数字のみ欄検証（`SHIFT_DIGITS_ONLY`）・英字専用欄
      検証（`SHIFT_ALPHA_ONLY`）・カタカナシフト欄（`SHIFT_KATAKANA`）が、ACS の
      `checkDigitsOnlyChar()`・`checkAlphaOnlyChar()`・`checkKanaShiftChar()` と
      比較され、一致している場合はその旨、一致していない場合は対応方針（修正する／
      意図的な相違として記録する）が決まっている（AC1 と同じ、一致・不一致どちらの
      結果も許す構造）。
- [ ] AC3: 上記の比較過程・判断根拠が `research.md`・`decisions.md` に、
      デコンパイルしたコードの具体的な抜粋（file:line 相当の引用）とともに
      記録されている。
- [ ] AC4: 自己点検欄（モジュラス10/11）について、当プロジェクトが実装するか
      どうかの判断が行われ、`decisions.md` に理由とともに記録されている
      （実装する場合は本 work で対応し、見送る場合は backlog に残す）。
- [ ] AC5: AC1・AC2・AC4 で「修正する」と判断した変更（あれば）について、既存の
      関連テスト（`field-validate.ts` を対象にした既存テストがあれば）に回帰が
      無いことを確認する——US1 が求める「ACSとの整合」を、修正を加えても既存の
      検証機能（コードページ許容文字チェック等、この work の対象外の既存機能）を
      壊さずに達成できていることの裏付けとして必要。

## 未確定事項 / 確認したいこと

- 自己点検欄（モジュラス10/11）を実装する場合の実装コスト・要否は、design 工程で
  具体的に検討する。
