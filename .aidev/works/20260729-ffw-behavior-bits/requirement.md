# 要件: FFW の挙動ビットに従う（MONOCASE / 自動送り抑止 / 自動 Enter / 入力必須・充填検証 / シフト種別）

## 背景 / 課題

`packages/core/src/protocol/constants.ts:133-158` に FFW（Field Format Word）のビット定義は
揃っているが、**実際に参照されているのは 6 つだけ**（`BYPASS` / `MDT` / `SHIFT_MASK` /
`SHIFT_NUMERIC_ONLY` / `SHIFT_DIGITS_ONLY` / `SHIFT_SIGNED_NUMERIC`）。
残りは定義されたまま**一度も読まれていない**。

FFW は「この欄をどう扱えと**ホストが端末に指示している**か」なので、無視すると
**実機と食い違う**。とくに次の 2 つは日常操作で目に見える差になる。

- **MONOCASE**: 現状は「CCSID が 930/5026 のときだけ**全欄**を大文字化」している
  （`EmulatorPane.vue:68` の `uppercaseInput`）。欄単位の指定を見ていないので、
  US 系 CCSID では MONOCASE 欄に小文字がそのまま通り、逆に日本語機では
  小文字を受け付けるべき欄まで大文字になる。**CCSID で代用していること自体が誤り。**
- **FIELD_EXIT_REQUIRED**: `advanceIfFull`（`ScreenGrid.vue:1684`）が**無条件に**次欄へ送る。
  FER 指定欄では実機は送らない（Field Exit を要求する）。

`.aidev/backlog/field-input.md` の「未実装: FFW の挙動ビット」節がこの起票元。
直前の 2 本（#205 ADJUST・ローカル編集キー / #208 `digitsOnly` の数字キーパッド）で
**FFW → `Field` の任意フラグ → web-ui が使う**という経路が既に通っているので、その上に載せる。

## 目的 / ゴール

ホストが FFW で指定した欄の作法に端末が従う。利用者から見て「実機（ACS）と同じ打鍵で同じ結果」になる。

## スコープ

### 対象

`.aidev/backlog/field-input.md` の未チェック項目のうち、FFW ビットの解釈にあたる 6 群。

| ビット | 値 | やること |
|---|---|---|
| `MONOCASE` | `0x0020` | 欄単位で入力を大文字化する。CCSID による全欄一律の代用をやめる |
| `FIELD_EXIT_REQUIRED` | `0x0040` | 満杯でも自動で次欄へ送らない |
| `AUTO_ENTER` | `0x0080` | 満杯になった時点で Enter を自動送信する |
| `MANDATORY_ENTER` | `0x0008` | 未入力のまま送信しようとしたら弾く |
| `ADJUST_MANDATORY_FILL` | `0x0007` | 部分入力のまま送信しようとしたら弾く（桁の整形はしない＝実装済みの no-op のまま） |
| `SHIFT_ALPHA_ONLY` / `SHIFT_KATAKANA` / `SHIFT_IO` | `0x0100` / `0x0400` / `0x0600` | シフト種別に応じた入力の扱い（**中身は調査で確定する**。下記 U1） |

あわせて、直前の作業で入った**誤記の訂正**（同じ FFW の話なのでここで直す）:

- `packages/core/src/screen/types.ts` の `digitsOnly` の説明が「digits-only（**0x0600**）」だが、
  `constants.ts` の `SHIFT_DIGITS_ONLY` は **`0x0500`**（`0x0600` は `SHIFT_IO`）。

### 対象外

- **`DUP_ENABLE` `0x1000`** — Dup キー自体が未実装。キーを足すかどうかの判断が先で、
  それはキーバインド（`BindingTarget`）側の話になる。別作業。
- **Field− / Field+**、**符号付き数値の送信表現 `SHIFT_SIGNED_NUMERIC 0x0700`** —
  backlog が「同じ設計判断なので切り離さずに」と明記しており、かつ**実機での切り分けが前提**。別作業。
- **EDTMSK 分解欄の境界をまたぐ操作**、**数値専用欄に編集文字が入る構成** — backlog の「要確認」節。
  実機での確認が要り、本件のビット解釈とは別問題。
- ホスト側の検証（ホストが同じ検証を二重にかけるかどうか）は変えない。端末側の作法だけを揃える。

## 機能要件

1. **MONOCASE**: FFW に `0x0020` が立つ欄では、打鍵・ペースト・IME 確定のいずれでも
   英小文字を大文字にして格納する。立っていない欄では小文字をそのまま通す。
2. **FIELD_EXIT_REQUIRED**: FFW に `0x0040` が立つ欄では、カーソルが末尾に達しても
   次欄へ自動で送らない。Field Exit（実装済みのローカル編集キー）または Tab で出る。
3. **AUTO_ENTER**: FFW に `0x0080` が立つ欄が満杯になったら Enter を自動送信する。
4. **MANDATORY_ENTER / MANDATORY_FILL**: 条件を満たさない欄がある状態で AID を送ろうとしたら
   **送信せずに操作員メッセージを出す**（`opMessages.ts` に日本語で追加）。カーソルは該当欄へ移す。
5. **シフト種別**: `ALPHA_ONLY` / `KATAKANA` / `IO` を、調査で確定した扱いで実装する
   （`field-validate.ts`（core・送信時）と `fieldValidate.ts`（web-ui・打鍵時）の両方で整合させる）。
6. どのビットも**当てはまるときだけ** `Field` に任意フラグを足す（既存 `adjust` /
   `signedNumeric` / `digitsOnly` と同じ作法。`false` は情報を持たない）。

## 非機能要件 / 制約

- **矩形選択・コピー＆ペーストを妨げない**（#207 と同じ制約。桁割りに触らない）。
- 検証で送信を止めるときも、**ホストへ何も送っていない**ことを利用者に分かる形で示す
  （黙って握りつぶさない。`MSG_NO_RESPONSE` の思想と同じ）。
- 操作員メッセージは日本語・です/ます調・句点なしで既存に揃える（`opMessages.ts` の規約）。
- **秘密を成果物に書かない**（実機検証を行う場合、資格情報は環境変数のみ・ファイルに残さない）。

## 完了条件 (受け入れ基準)

- [ ] MONOCASE 欄で小文字が大文字になり、**非 MONOCASE 欄では小文字が残る**
      （CCSID 930/5026 でも欄単位で分かれる＝`uppercaseInput` の全欄一律を置き換えている）
- [ ] FER 欄でカーソルが末尾に達しても次欄へ移らない。FER でない欄は従来どおり移る
- [ ] AUTO_ENTER 欄が満杯になると Enter が送られる
- [ ] MANDATORY_ENTER 欄が空・MANDATORY_FILL 欄が部分入力のとき AID が送られず、
      操作員メッセージが出てカーソルが該当欄へ移る
- [ ] `ALPHA_ONLY` / `KATAKANA` / `IO` が調査で確定した扱いになっている（根拠を `research.md` に残す）
- [ ] `types.ts` の `digitsOnly` の値の誤記が直っている
- [ ] 既存テストが全て通る（`packages/core` / `packages/web-ui`。ビルドは `vue-tsc` 込み）
- [ ] 新規ビットごとに単体テストがある。**空振り検証**（判定を外すとテストが落ちる）まで確認する

## 未確定事項 / 確認したいこと

- **U1（要調査・最重要）**: `SHIFT_ALPHA_ONLY` / `SHIFT_KATAKANA` / `SHIFT_IO` の正しい扱い。
  - `ALPHA_ONLY` は「数字を弾く」のか「英字＋一部記号だけ」なのか（許容集合の実体）
  - `KATAKANA` は**入力制限**ではなく**キーボードのシフト状態**ではないか
    （制限として実装すると日本語機でまともに打てなくなる恐れ）
  - `IO` は磁気ストライプ等の入力装置向けで、**キーボードからは入力不可**ではないか
  - 参照実装（GNU tn5250 / tn5250j）が何をしているかを根拠にする
- **U2**: MONOCASE は実機でどれくらい一般的か。DDS の既定（`CHECK(LC)` 無しの文字欄）で
  立つのなら**ほぼ全欄**に立つことになり、`uppercaseInput` の置き換え影響が大きい。
  **実機のログオン画面・PDM で FFW の実バイトを採取して確かめる。**
- **U3**: `MANDATORY_ENTER` / `MANDATORY_FILL` の検証をどの AID で行うか。
  実機は Enter/機能キーで挙動が違う（F3 は検証を通さず抜けられるはず）。
  参照実装と実機で切り分ける。
- **U4**: `AUTO_ENTER` は満杯時に必ず Enter か、それとも「最終欄のときだけ」か。
- **U5**: 検証で止めたときのキーボードロックの扱い。既存の操作員メッセージは
  「クリアされるまで入力を止めない」方針（`opMessages.ts` の注記）なので、それに揃えるか。

→ **U1・U2 は誤ると利用者が文字を打てなくなる**（回帰の代償が大きい）。research 工程で
参照実装と実機の実バイトを根拠に潰してから spec に入る。
