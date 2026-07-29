# 仕様: FFW の挙動ビットに従う

## 概要

FFW のビットを `Field` の**任意フラグ**として公開し（既存の `adjust` / `signedNumeric` /
`digitsOnly` と同じ作法）、web-ui がそれを見て実機と同じ作法で振る舞う。
**core は判定材料を出すだけ、端末の作法は web-ui** という前作 #205 の分担をそのまま踏襲する。

## 設計方針

### 方針 1: ビットの解釈は core、作法は web-ui

`buffer.ts` の snapshot 組み立てが FFW を読んでフラグにする。すでに `adjust` / `signedNumeric` /
`digitsOnly` が同じ場所で同じ形をしているので、**新しい仕組みを足さない**。

### 方針 2: `uppercaseInput`（CCSID 930/5026）は残し、MONOCASE と**併存**させる

requirement では「CCSID による全欄一律の代用をやめる」としたが、research 4-1 のとおり
**2 つは別の理由**だった。

| 規則 | 理由 | 適用範囲 |
|---|---|---|
| MONOCASE（FFW 0x0020） | **ホストがこの欄を大文字化しろと言っている** | その欄だけ |
| カタカナ系 CCSID（930/5026） | **コードページに英小文字が無い**。大文字化しないと `field-validate.ts` の「マップ不能文字」検証で送信できなくなる | 全欄 |

→ **どちらかが真なら大文字化**する。CCSID 側を消すとカタカナ系ホストが退行する。

### 方針 3: 必須検証（ME / MF）は **Enter のときだけ**

research 4-3 のとおり。機能キーでも検証すると**必須欄が空の画面から F3 で抜けられなくなる**。
参照実装は AID 時検証をそもそも持たない（research F6）ので、弱い側に倒しても原典から離れない。
→ `decisions.md` に記録する。

### 方針 4: FER は「自動送りをしない」だけ

原典の FER 標識（他キーを抑止する状態機械。research F4）までは作らない。
本実装は欄が満杯になると以降の打鍵が入らないので、自動送りを止めるだけで
「Field Exit か Tab で出る」という実機の操作感になる。

## 対象範囲

- `packages/core/src/screen/types.ts` — `Field` に任意フラグ追加・`digitsOnly` の誤記訂正
- `packages/core/src/screen/buffer.ts` — snapshot 組み立てでビットを写す
- `packages/core/src/screen/field-validate.ts` — alpha-only / キーボード入力不可
- `packages/web-ui/src/composables/fieldValidate.ts` — 打鍵時の一次フィルタ
- `packages/web-ui/src/composables/opMessages.ts` — 操作員メッセージ
- `packages/web-ui/src/components/ScreenGrid.vue` — MONOCASE・FER・AUTO_ENTER
- `packages/web-ui/src/components/EmulatorPane.vue` — Enter 前の必須検証

## インターフェース / データ構造

### `Field` に足す任意フラグ（すべて**当てはまるときだけ**付ける）

```ts
/** FFW の MONOCASE（0x0020）。この欄に打った ASCII 英小文字は大文字にして格納する */
monocase?: boolean;
/** FFW の FIELD_EXIT_REQUIRED（0x0040）。満杯でも自動で次欄へ送らない */
fieldExitRequired?: boolean;
/** FFW の AUTO_ENTER（0x0080）。満杯・欄を出た時点で Enter を自動送信する */
autoEnter?: boolean;
/** FFW の MANDATORY_ENTER（0x0008）。空のまま送信できない */
mandatoryEnter?: boolean;
/** FFW の shift が alpha-only（0x0100）。英字・`,`・`.`・`-`・空白のみ */
alphaOnly?: boolean;
/** FFW の shift が io（0x0600）。**キーボードからは入力できない**欄 */
keyboardInhibited?: boolean;
```

`MANDATORY_FILL` は**足さない**——既存の `adjust === "mandatory-fill"` が同じ事実を持っており、
同じ事実の導出元を 2 つ作らない（`fieldValidate.ts` のコメントと同じ原則）。

### `RejectReason` に足す理由（web-ui）

```ts
| "alpha-only"      // 英字専用(X)項目に英字以外
| "kbd-inhibited";  // キーボード入力不可(I)項目
```

### 操作員メッセージ（`opMessages.ts`）

| 定数 | 文言 | ACS 原文 |
|---|---|---|
| `MSG_BY_REASON["alpha-only"]` | この項目には英字しか入力できません | Field requires alphabetic characters. |
| `MSG_BY_REASON["kbd-inhibited"]` | この項目はキーボードから入力できません | Data not allowed in this field. |
| `MSG_MANDATORY_ENTER` | 入力が必要な項目が入力されていません | Mandatory field not entered.（5250 の 0021） |
| `MSG_MANDATORY_FILL` | この項目はすべての桁を埋めてください | Field must be filled.（5250 の 0022） |

## 振る舞いの詳細

### B1: MONOCASE

`ScreenGrid.vue` の `inputChar(ch)` を `inputChar(ch, f)` にし、
`props.uppercaseInput || f.monocase` のとき ASCII `a`–`z` を大文字化する。
**全角・カナ・記号には触らない**（research F3 の `isalpha` 相当）。
打鍵・ペースト・IME 確定のすべてが既に `inputChar` を通っているので、経路は増やさない。

### B2: FIELD_EXIT_REQUIRED

`advanceIfFull(f)` の先頭で `if (f.fieldExitRequired) return;`。
Field Exit（`fieldExitKey`）と Tab は従来どおり欄を出る（原典でも FER 標識を落として通る）。

### B3: AUTO_ENTER

満杯になった時点（`advanceIfFull`）と Field Exit（`fieldExitKey`）で、
**次欄へ送る代わりに** `emit("aid", "Enter")` する。既存の凡例ボタン用 `aid` emit をそのまま使う
（親の `onAid` が送信経路の単一の入口）。

**FER と AUTO_ENTER が同時に立つ欄**では FER を優先する（原典 `display.c:1035` が
FER 分岐の中で auto-enter を見ないため）。

### B4: MANDATORY_ENTER / MANDATORY_FILL

`EmulatorPane.onAid(key)` の先頭、`key === "Enter"` のときだけ検証する。

各入力欄の**現在値** = `state.edits.get(f.index) ?? f.value`（`edits` は打鍵ごとに更新される）。

| 条件 | 判定 |
|---|---|
| `f.mandatoryEnter` かつ 現在値が空白のみ | 違反（`MSG_MANDATORY_ENTER`） |
| `f.adjust === "mandatory-fill"` かつ 現在値が**空でも満杯でもない** | 違反（`MSG_MANDATORY_FILL`） |

- **MANDATORY_FILL は「全部埋める」か「全部空」のどちらか**（DDS の CHECK(MF) の定義）。
  部分入力だけを弾く
- 「満杯」の判定は**送信バイト長**で行う（DBCS 欄は `dbcsByteLength`。`f.length` はバイト予算）
- **`hidden` 欄で `edits` に無いものは検査しない**（snapshot が値を持たないので判定できない。
  分からないものを弾かない側へ倒す）
- 違反があれば**送信せず**、操作員メッセージを出し、**最初の違反欄へカーソルを移す**
- 画面順（`fields` の並び）で最初の違反を採る

### B5: シフト種別（alpha-only / io）

| 場所 | 変更 |
|---|---|
| core `field-validate.ts` | `alphaOnly` なら `/^[A-Za-z,.\- ]*$/`、`keyboardInhibited` なら**常に拒否** |
| web-ui `fieldValidate.ts` | `rejectReason` に同じ 2 つを足す。**DBCS 判定より前**に置く（キーボード不可は種別より強い） |

**katakana（0x0400）は何もしない。** 制限だと誤解して実装しないよう、コードにコメントを残す。

core 側の `keyboardInhibited` は「キーボードから」の制限なので、**送信時検証で弾くと
ペースト・マクロ・MCP 経由の設定まで塞ぐ**。→ **core では弾かず web-ui の打鍵時だけ**にする。
（`validateFieldContent` は送信時＝経路を問わない検証なので、キーボード固有の制約を入れない）

## ドメイン固有の考慮

- **矩形選択・コピー＆ペーストを妨げない**: 桁割り（`slicesOf` / `<input>` の構造）に一切触らない。
  変更は「打鍵した文字の変換」「フォーカス移動をするかどうか」「送信を止めるかどうか」だけ
- **DBCS**: MONOCASE は ASCII 英字だけなので全角に影響しない。
  mandatory-fill の桁数は `dbcsByteLength` で見る
- **`hidden` 欄**: snapshot が値を持たない（`value: hidden ? "" : ...`）ため、
  `edits` に無ければ検査しない

## エラー処理 / 異常系

- 必須検証で止めたときも**キーボードはロックしない**（`opMessages.ts` の既存方針）。
  次のキー操作でメッセージが消えるのも既存どおり
- `keyboardInhibited` 欄への打鍵は既存の `rejectReason` 経路（メッセージを出して 1 文字を捨てる）に乗る

## 受け入れ基準との対応

| requirement の完了条件 | 満たし方 |
|---|---|
| MONOCASE 欄で大文字化・非 MONOCASE 欄で小文字が残る | B1。CCSID 側と OR にするので katakana 系は従来どおり |
| FER 欄で自動送りしない | B2 |
| AUTO_ENTER 欄が満杯で Enter | B3 |
| ME / MF で AID を止め、メッセージとカーソル移動 | B4 |
| alpha-only / katakana / io が調査どおり | B5（根拠は research F2） |
| `digitsOnly` の誤記訂正 | `types.ts` の JSDoc を 0x0500 に直す |
| 既存テスト全通過・新規ビットの単体テスト・空振り検証 | plan のテスト方針 |
