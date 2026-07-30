# 仕様: 入力支援 UI（F4 の導線）と、datepicker を作らない判断

## 概要

**datepicker / timepicker は作らない。** 判定材料である「`EDTMSK` が付いた欄は分解されて届く」が
**実機で成立しないと分かった**（research F1。backlog の数値は合成データストリームのもの）。
代わりに実測を backlog へ残し、材料が揃っている **`F4` の導線**だけを作る。

## 設計方針

### 方針1: 材料が無い機能は作らない（research F1・F4）

backlog の署名（`2/2/2` / `2:2:2`）は、同一行に連続する数値欄と保護された区切り文字から作る。
実機ではどの `EDTMSK` の綴りでも**欄は 1 つ**で来て、編集文字は**欄の中の値**に入る。

代替も成立しない（research F4 の表）。とくに「現在値に `/` があるか」は
**値があるときだけ効く**——新規入力の空欄では材料ゼロで、**出たり出なかったりは無いより悪い**。

作れば「推測を真実として扱う」ことになり、リポジトリの原則
（ホストが送る情報を UI 側で上書きしない／同じ事実の導出元を 2 つ持たない）に反する。

**requirement に前提が崩れたときの扱いを先に書いてあるので、その通りにする。**

### 方針2: `F4` は「語」ではなく「キー」で判定し、表示はホストのラベルを使う

backlog は「凡例に `F4=Prompt` がある画面では」と書くが、**ラベルは地域語**で来る
（実機は `F4=ﾌﾟﾛﾝﾌﾟﾄ`）。語で判定すると言語ごとに壊れる。

- 判定: `detectFkeyLegends(snap)` に **`key === "F4"`** の凡例があるか
- 表示: **凡例のラベルをそのまま**（`title` / `aria-label`）。UI 側で「プロンプト」と言い換えない

これで「F4 が別の意味の画面」でも嘘にならない——利用者はホストが書いた語を読む。

### 方針3: 押すのは利用者の明示操作だけ

フォーカスしただけでは何も送らない。ボタンを押したときに **`F4` を AID として送る**
（カーソルはその欄。ホストがどの欄をプロンプトするかはカーソル位置で決まる）。

### 方針4: `optHints` の作法をそのまま守る

- **キーイベントを 1 つも購読しない**／`@mousedown.stop.prevent` で伝播とフォーカス移動を止める
  ＝**矩形選択・コピー＆ペースト・キー操作を妨げない**（利用者指示。`opt-hints-ui.test.ts` の不変条件）
- 絶対配置（`left: ch` / `top: 1.25em` 係数）なので**桁割りに影響しない**

### 方針5: 設定は ON/OFF の 2 択・既定 OFF

`VIEW_ITEMS` に 1 項目。見た目の候補が無いので `linkify` と同じ 2 択
（backlog:「全部にデザイン候補を作らない」）。

既定 OFF は backlog の明示要求（「勝手に有効化しない」）。
`F4` の検出そのものは推測を含まない（ホストの宣言）が、**画面に部品を重ねる**ので
利用者が選んでから出す。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/web-ui/src/composables/fkeyLegend.ts` | `detectPromptKey(snap)` を追加（`F4` の凡例を 1 件返す） |
| `packages/web-ui/src/components/ScreenGrid.vue` | `promptHint` prop / ボタンの描画 / `aid` の送出 |
| `packages/web-ui/src/components/EmulatorPane.vue` | `promptHint` を `ScreenGrid` へ渡す |
| `packages/web-ui/src/stores/viewSettings.ts` | `promptHint: boolean` を型・`VIEW_ITEMS`・`FALLBACK` に |
| `packages/web-ui/src/composables/opMessages.ts` | `MSG_PROMPT_HINT`（`aria-label` の既定文言） |
| `packages/web-ui/test/prompt-hint.test.ts` | 新規 |
| `scripts/build-dttest.mjs` / `research-edtmsk.mjs` / `research-sysval.mjs` | 新規（実測の再現手段） |
| `scripts/README.md` | 3 本を登録し、実測の要点を注意書きへ |
| `.aidev/backlog/input-assist.md` | 5 件すべてに結論。**未着手 0** |

## インターフェース / データ構造

```ts
/**
 * `F4` の凡例（＝ホストが「この画面では F4 が効く」と書いている）。無ければ null。
 *
 * **語（"Prompt" / "プロンプト"）では判定しない**——ラベルは地域語で来る
 * （実機は `F4=ﾌﾟﾛﾝﾌﾟﾄ`）。`key === "F4"` で判定し、**ラベルはホストのものを渡す**
 * （UI 側で言い換えない）。
 */
export function detectPromptKey(snap: ScreenSnapshot, charOf?: CharOf): FkeySpan | null;
```

`ScreenGrid` 側:

```ts
/** F4 の導線を出すか（画面設定。既定 false） */
promptHint?: boolean;

/** フォーカス中の入力欄と F4 凡例の両方が揃ったときだけボタンを出す */
const promptTarget = computed<{ row: number; col: number; label: string } | null>(...)
```

## 振る舞いの詳細

| 状態 | 出るか |
|---|---|
| 設定 OFF | 出ない |
| 設定 ON ＋ 凡例に `F4` あり ＋ 入力欄にフォーカス | **出る**（欄の右隣 1 桁） |
| 設定 ON ＋ 凡例に `F4` あり ＋ フォーカスが無い / 保護セル | 出ない |
| 設定 ON ＋ 凡例に `F4` が無い | 出ない |
| 窓が開いている | `detectFkeyLegends` が窓の内側だけを見る（既存の歯止め） |
| 押した | `aid("F4")` を送る（カーソルはその欄） |

- **フォーカスに完全従属**させる（`optHints` の `focusedField` と同じ）。
  画面が変わってフォーカスが外れれば消える
- ボタンは `tabindex="-1"`（タブ順に入れない）。一覧を Tab で降りるときの停止数を変えない

## ドメイン固有の考慮

- **`F4` の意味はホストが決める。** こちらは「凡例にある」という事実だけを使う
- 凡例が**窓の外**にある場合は既存の `detectFkeyLegends` が除外する
  （ラベルが切れていたり、押すと前面の窓の文脈で解釈されるため）
- `gui.selectionFields` がある行は検出しない（ホストの宣言を優先）

## エラー処理 / 異常系

| 事象 | 扱い |
|---|---|
| 凡例が複数行に `F4` を持つ | 最初の 1 件を使う（どれを押しても同じキーが飛ぶ） |
| `busy`（ホスト応答待ち） | `sendKey` 側の既存プロテクトで弾かれる（この層では判定しない） |
| 閲覧専用セッション | 同上（`assertKeyAllowed` がサーバーで弾く） |

## 受け入れ基準との対応

| requirement の完了条件 | どうなったか |
|---|---|
| `EDTMSK` の分解が実機で確かめられ、記録されている | **不成立を実測**（research F1）。backlog に記録 |
| システム値のビュー名が確かめられている | **`QSYS2.SYSTEM_VALUE_INFO`**（research F3）。値は `CURRENT_CHARACTER_VALUE` |
| 署名から日付 / 時刻を導く純関数 | **作らない**（材料が無い。方針1） |
| 桁順がシステム値で解釈される | 同上 |
| 支援 UI が出て、選ぶと欄へ値が入る | 同上 |
| 矩形選択・コピー・キー操作が妨げられない | `F4` の導線で守る（方針4・テスト） |
| `F4` の導線が凡例のある画面でだけ出る | 方針2・3 |
| 画面設定に項目があり、既定が無効 | 方針5 |
| backlog の未着手が 0 | 5 件すべてに結論（2 件は「作らない」理由つき） |
