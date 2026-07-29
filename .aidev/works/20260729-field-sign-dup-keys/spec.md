# 仕様: 負値入力（Field− / Field+）と符号付き数値の送信表現、Dup キー

## 概要

**負値がホストへ届かない不具合**（research F1: `-12` を送ると黙って `12` になる）を、
原典どおりの送信変換で直す。そのうえで実機の作法である Field− / Field+ / Dup を
ローカル編集キーとして足す。

## 設計方針

### 方針 1: 送信変換は core、符号桁の見た目は web-ui

**画面（編集モデル）は符号桁に `-` を持ったまま**にする——実機の見た目と同じ。
ワイヤに出るときだけ `read-response.ts` が変換する。
web-ui で変換すると画面と送信値が食い違い、「見えているものが送られる」原則が崩れる。

### 方針 2: `-` / `+` の打鍵を Field− / Field+ へ横流しする（原典 F7）

これが無いと「`-12` と打って正値が送られる」不具合が残る。**打った通りに送れないなら、
打たせない。**

### 方針 3: num-only 欄の符号処理は**やらない**

実機の数値入力欄はすべて signed-num（research F4）で、num-only の符号処理は
**実機で確かめられない**。確かめられないものは実装しない側へ倒し、
Field Exit と同じ振る舞いにする（原典の `field_minus_in_char` と同じ逃げ道）。

## 対象範囲

- `packages/core/src/protocol/read-response.ts` — signed-num の送信変換（**中核**）
- `packages/core/src/screen/types.ts` / `buffer.ts` — `dupEnable` フラグ
- `packages/core/src/screen/field-validate.ts` — センチネルを型検証から外す
- `packages/web-ui/src/composables/fieldEdit.ts` — `fieldMinus` / `fieldPlus` / `dupFill`
- `packages/web-ui/src/composables/useKeymap.ts` — `LOCAL_EDIT_ACTIONS` に 3 つ
- `packages/web-ui/src/stores/keybindings.ts` — 版 3 の既定バインド
- `packages/web-ui/src/components/ScreenGrid.vue` / `EmulatorPane.vue` — キー処理
- `packages/web-ui/src/composables/opMessages.ts` — Dup 不許可の文言

## インターフェース / データ構造

### `Field` に足す任意フラグ

```ts
/** FFW の DUP_ENABLE（0x1000。DDS の `DUP` キーワード）。Dup キーが使える欄 */
dupEnable?: boolean;
```

### `LocalEditAction` に足す 3 つ

```ts
export const LOCAL_EDIT_ACTIONS = [
  "field-exit", "erase-eof", "erase-input", "field-minus", "field-plus", "dup"
] as const;
```

### 既定バインド（版 3）

| キー | 割当 | 理由 |
|---|---|---|
| `ctrl+-` | `local:field-minus` | 実機は数値キーパッドの `-`。`ctrl` は既存 3 つと揃う |
| `ctrl++` | `local:field-plus` | 同上 |
| `ctrl+d` | `local:dup` | ACS の Dup は `Shift+Insert` 等だが、既存 3 つと同じ `ctrl` 系で揃える |

ブラウザ既定（`ctrl+-` = 縮小、`ctrl+d` = ブックマーク）と衝突するので **`preventDefault` する**
（既存のローカル編集キーと同じ扱い）。

## 振る舞いの詳細

### B1: 送信変換（`read-response.ts`）— 中核

signed-num の欄だけ、フィールドデータを書き出す前に次を行う（原典 `session.c:551-566` の移植）。

1. **符号桁（最終位置）は送らない**
2. 符号桁が `-` で、その手前が数字なら、**その数字の EBCDIC バイトのゾーンを 0xD にする**
3. 末尾の空白は従来どおり落とす

判定には**欄長ぶんの値**が要る（`fieldValue` は末尾空白を落とすため、符号桁が消えている）。
→ `ScreenBuffer` に「末尾空白を落とさない欄値」を取る道を用意する。

```
"    12-"（欄長 7）→ 符号桁 '-' を落とし "    12" → 最終桁 '2' のゾーンを D
                  → 40 40 40 40 F1 D2  （= −12）
"    12 "          → 符号桁は空白 → "    12" → 40 40 40 40 F1 F2（= +12）
```

### B2: `-` / `+` の横流し

`ScreenGrid` の打鍵処理で、**数値欄（`numeric`）に `-` / `+` が来たら文字として入れず**
Field− / Field+ を実行する。非数値欄では従来どおり文字として扱う
（`rejectReason` が弾くかどうかは欄の型次第）。

### B3: Field− / Field+

```
① カーソル以降を欄末尾まで消去（既存 eraseToEnd）
② ADJUST を適用（既存 applyAdjust。signed-num は符号桁を残して空白右寄せ）
③ signed-num なら符号桁へ `-`（Field−）／空白（Field+）
④ AUTO_ENTER なら Enter、そうでなければ次の入力欄へ
```

**signed-num でない欄**（非数値欄・num-only・digits-only）では ③ を飛ばす＝ Field Exit と同じ。

### B4: Dup

```
① 保護欄なら操作員メッセージ（既存 MSG_PROTECTED）
② DUP_ENABLE でなければ操作員メッセージ（新規 MSG_DUP_DISALLOWED）
③ カーソルから欄末尾まで 0x1C（生バイトのセンチネル）で埋める
④ FER なら留まる。そうでなければ AUTO_ENTER → Enter ／ そうでなければ次の欄へ
```

原典は ② の前に MDT を立てるが、**本実装は値が変われば MDT が立つ**（`sync` が `emit("edit")`）
ので、②で弾いたときに MDT だけ立てることはしない（値を変えずに MDT を立てる道が無い）。

### B5: センチネルを型検証から外す

`validateFieldContent` の数値許容集合の判定から**センチネル文字を取り除いてから**当てる。
センチネルは「表示できない生バイトを運ぶ印」であって利用者が打った文字ではない
（属性バイト・Dup 文字が該当）。

## ドメイン固有の考慮

- **矩形選択・コピー＆ペースト**: 桁割りに触らない
- **DBCS 欄**: Field− / Field+ / Dup は**数値欄・SBCS 欄の話**。DBCS 欄では Field Exit と同じく
  右寄せしない（既存の `isDbcsEdit` 分岐に乗せる）
- **`fieldValue` の末尾空白落とし**: 既存の送信仕様なので変えない。符号桁の判定にだけ
  「落とさない値」を使う

## エラー処理 / 異常系

- Dup が使えない欄では**何もせず**メッセージ（値を壊さない）
- signed-num でない欄の Field− は Field Exit と同じ（エラーにしない。原典の逃げ道と同じ）

## 受け入れ基準との対応

| requirement の完了条件 | 満たし方 |
|---|---|
| Field− でホストが負値として受け取る | B1 + B3。**実機で確認する** |
| Field+ で正値 | B3 |
| 非数値欄では Field Exit と同じ | B3 の但し書き |
| DUP_ENABLE で効き、無ければメッセージ | B4 |
| キー設定に出る | `LOCAL_EDIT_ACTIONS` に足せば既存 UI が拾う |
| 送信表現の根拠が実測で残る | `research.md` F1・F5 |
| 空振り検証 | plan のテスト方針 |
