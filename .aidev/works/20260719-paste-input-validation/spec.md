# 仕様: 入力・ペースト時の検証と ACS 準拠メッセージ

## 概要

requirement の 4 系統を実装する。

1. 打鍵・削除時のエラーメッセージ 4 種
2. 上書きペーストの桁保持（捨てて詰めない）
3. 挿入ペーストの一括拒否
4. 流し込み規則の統一（右優先・尽きたら下）＋ メッセージの寿命

## 設計方針

### A. 検証は「理由」を返す形へ変える

現状 `acceptsChar(field, ch): boolean` は真偽値しか返さず、**なぜ弾いたかを呼び出し側が知れない**。
メッセージを出すには理由が要る。

```ts
type RejectReason = "numeric" | "alphanumeric" | "dbcs-required";
function rejectReason(field: Field, ch: string): RejectReason | undefined;
export function acceptsChar(field: Field, ch: string): boolean;  // 既存 API は維持
```

`acceptsChar` は `rejectReason(...) === undefined` として残す。**既存の呼び出し側を壊さない**ため。

代替案（判定を各所に散らす）は退けた。判定が 2 か所以上に分かれると
「同じ事実に導出元を 2 つ持たない」（retro の規約案）に反する。

### B. メッセージ定数

```ts
const MSG_PROTECTED   = "Cursor in protected area of display.";
const MSG_NUMERIC     = "Field requires numeric characters.";
const MSG_ALPHANUM    = "Field data must be alphanumeric.";
const MSG_DBCS        = "Double-byte character required as input.";
const NO_ROOM         = "No room to insert data.";  // 既存
```

`RejectReason` → メッセージの対応は 1 か所の写像で持つ。

### C. 上書きペースト: 弾いた桁を消費する

`overwriteInto` の現状は次のとおりで、**弾いたとき `i` を進めない**ため後続が左へ詰まる。

```ts
if (!acceptsChar(field, ch)) continue;   // i がそのまま → 次の文字が同じ桁を上書き
out[i] = ch;
i++;
```

これを「桁を消費して元の文字を残す」に変える。

```ts
if (!acceptsChar(field, ch)) { i++; continue; }   // 元の out[i] に触れない
```

**既存 DBCS を壊さない**こと（requirement）。`out` は論理文字の配列で、全角 1 文字が 1 要素。
`out[i]` に触れなければ全角が半分だけ書き換わることはない。この不変条件をテストで固定する。

### D. 挿入ペースト: 1 文字でも不可なら何も貼らない

`insertInto` は現状 `continue` で黙って落とす。理由を返す形に変える。

```ts
function insertInto(...): { value: string } | { reject: RejectReason } | { noRoom: true } | undefined
```

戻り値が増えて読みにくいため、**呼び出し前に一括判定**する方式を採る。

```ts
const bad = [...text].map(inputChar).find((ch) => rejectReason(field, ch) !== undefined);
if (bad !== undefined) { emit("notice", msgFor(rejectReason(field, bad)!)); return; }
```

理由: 挿入は「全部入ると確定するまで書き換えない」既存方針と同じ形になり、
`insertInto` の責務（入る/入らない）を増やさずに済む。

### E. 流し込み規則の統一

**単一行も `pasteMultiline` に通す。** 現状の単一行経路（`typeChar` ループ）は
欄の右端で打ち切るため要件を満たせない。経路を 1 本にすることで規則の二重化も避ける。

`pasteMultiline` は帯モデル（次の行の同じ桁へ回る）を既に持つ。**足りないのは横方向。**

各ソース行について、消費する行 `r`（初期値 = 開始行）と開始桁 `startCol` を持ち:

1. 行 `r` の `startCol` にある欄を引く。無い／保護なら**その行を右へ走査**して
   最初の非保護欄を探す。見つからなければ `r += 1` して 1 へ戻る
2. その欄の、行 `r` における右端までを帯幅として書き込む
3. 残りがあれば、**同じ行の右隣**にある次の非保護欄を探して 2 を繰り返す
4. 行 `r` に右がもう無ければ `r += 1`、桁は `startCol` へ戻して 1 へ
5. ソース行を消費し切ったら、次のソース行は `r + 1` から（既存挙動）

**右が先、尽きたら下**。requirement の 4 例すべてがこの手順で再現する。

### F. メッセージの寿命と復帰

`StatusBar` は現状 `notice` と `snap.systemMessage` を**両方同時に**描いている。
requirement は「クライアント側が上書きし、消えたらホストのメッセージへ戻る」。

`notice` があるときは `systemMessage` を出さない、という**表示側の分岐だけ**で足りる。
`systemMessage` はスナップショットが保持し続けるため、`notice` が消えれば自然に戻る。
**復帰のために状態を持つ必要は無い。**

クリア契機は現状の `onKeydownCapture`（何かキーを押したら消す）を維持する。
ACS の「クリアまで入力を受け付けない」は再現しない（ユーザー判断）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `composables/fieldValidate.ts` | `rejectReason` 追加、`acceptsChar` は委譲 |
| `components/ScreenGrid.vue` | メッセージ定数・打鍵/削除の通知・`overwriteInto` の桁消費・挿入の一括判定・`onInputPaste` の単一行経路撤去・`pasteMultiline` の横走査 |
| `components/StatusBar.vue` | `notice` があれば `systemMessage` を出さない |

## 振る舞いの詳細

### 打鍵・削除

- 保護欄で「文字キー」「Backspace」「Delete」→ `MSG_PROTECTED`
- 非保護欄で `rejectReason` が返る → 対応メッセージ
- ペーストでは保護メッセージを出さない（走査で読み飛ばすため到達しない）

### エッジケース

- **ペースト先に入力欄が 1 つも無い**: 何も起きない（メッセージも出さない）
- **弾かれた文字だけのペースト**（上書き）: 値は変化しない。メッセージも出さない
- **J 型に SBCS のみのペースト**（上書き）: 同上。既存 DBCS は無傷
- **挿入で不可文字と溢れが同時**: 不可文字の判定を先に行う（メッセージは不可文字側）

## ACS とあえて揃えていない点

いずれも**ユーザー判断による意図的な差**であり、不具合ではない。実装コメントにも残す。

| 項目 | ACS | 本実装 | 理由 |
|---|---|---|---|
| メッセージ表示中の入力 | クリアされるまで**文字入力を受け付けない** | 受け付ける | 不便なため（ユーザー判断） |
| メッセージのクリア契機 | ホストとの通信が発生する操作、またはカーソルキー移動 | **任意のキー操作** | 上記に伴い厳密に合わせる必要が無い |

**揃えている点**（差と混同しないよう明記）:

- メッセージの文言は ACS 原文どおり
- クライアント側メッセージがホストのメッセージを上書きし、消えたら元へ戻ること
- 上書きペーストではメッセージを出さないこと
- 保護欄でのペーストがエラーにならず、右の入力欄から流し込まれること

## エラー処理 / 異常系

- `rejectReason` は未知の型に対して `undefined`（＝許可）を返す。
  検証を厳しくして誤って弾くより、core の送信時検証に委ねる方が安全（既存方針）

## 受け入れ基準との対応

| requirement | 対応 |
|---|---|
| 打鍵 4 種のメッセージ | B・打鍵の節 |
| Backspace/Delete も保護メッセージ | 打鍵の節 |
| 上書きで桁が元のまま（`123`+`3A5`→`325`） | C |
| 保護を飛ばして次の入力欄へ | E-1・E-3 |
| 挿入は不可文字で何も貼らない | D |
| 挿入の溢れは `No room to insert data.` | 既存維持 |
| 単一行の矩形折返し | E（単一行も同経路） |
| IBM i メッセージへ復帰 | F |
| 各テストが修正前に落ちる | test 工程で確認 |
