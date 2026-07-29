# 要件: 数値欄にモバイルの数字キーパッドを出す（inputmode）

出典: `.aidev/backlog/input-assist.md`「他にできそうなこと」→ **`inputmode` の指定**
（「安価。**現在どこにも設定されていない**」「**推測を一切含まず**ホストの申告だけで決まる」）。

## 背景 / 課題

`grid-input` には `type="text"` しか付いておらず、`inputmode` は**リポジトリのどこにも無い**。
モバイル・タブレットで数値欄に触れてもフルキーボードが出るため、数字の入力が遠い。

## 目的 / ゴール

ホストが数値欄だと申告している欄で、ソフトキーボードを数字キーパッドにする。

## スコープ

### 対象
- `inputmode` を入力欄に付ける
- **どの欄に付けるか**の判定（下記の「機能要件」が肝）

### 対象外
- datepicker / timepicker、F4=Prompt の導線（同 backlog の別項目）
- デスクトップの挙動（`inputmode` はソフトキーボードにしか効かない）

## 機能要件

- **数字しか受け付けない欄にだけ絞る。** `field-validate.ts` の許容集合は
  **digits-only（FFW 0x0600）だけが `/^[0-9]*$/`** で、numeric-only / signed-numeric は
  `/^[0-9.,+-]*$/`＝ `.` `,` `+` `-` を通す。
- したがって **`numeric` 全体に `inputmode="numeric"` を付けてはならない**。
  付けると `.` `-` のキーが消え、**打てるはずの文字が打てなくなる**
  （AGENTS.md「環境の検出結果で選択肢を塞がない」）。
- 既存の `Field` は `numeric`（3 種まとめ）と `signedNumeric` しか持たず、
  **digits-only を見分けられない**。core 側に印を足す必要がある。
- 保護欄には付けない。

## 完了条件 (受け入れ基準)

- [ ] digits-only の欄で `inputmode="numeric"` が付く
- [ ] numeric-only / signed-numeric / 英数字欄では**付かない**
- [ ] 保護欄では付かない
- [ ] `digitsOnly` が実データストリームから正しく立つ
- [ ] 既存テストが通る
