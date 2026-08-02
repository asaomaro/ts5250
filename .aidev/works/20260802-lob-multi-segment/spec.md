# 仕様: LOB の分割受信をホストの単位（文字）で回す

## 概要

実機で**壊れていることが確定した**（`research.md` F4〜F6）。未検証項目ではなく**バグ修正**。

`retrieveLob` のループは、ホストが**文字**で数えるフィールド（`lobStartOffset` /
`lobRequestedSize`）に**バイト**を入れている。2 バイト CCSID（UTF-16・純 DBCS）で
分割が 2 周目に入ると、**位置が 2 倍に飛んで中身が抜ける**。

| 症状 | 実測 |
|---|---|
| 中抜け | 524,288 バイトの DBCLOB で**文字 65,535〜131,069 が欠落** |
| 上限超過 | `maxBytes=200,000` に対し **262,140 バイト**（1.31 倍）を保持 |
| 歯止め無効 | `body.length < want` が 2 バイト CCSID で成立しえない |

**穴の空いた値に `too-large` が付く**のが最も悪い——「末尾で切れた」と読ませる印なので、
利用者は中抜けに気づけない。

## 設計方針

### 1. ループはホストの単位（文字）で回す

送るのも受け取るのも文字で数える。**換算は上限（バイト）を当てるときだけ**。

```ts
let offsetUnits = 0;          // ホストへ送る位置（文字）
let receivedBytes = 0;        // 上限判定に使う量（バイト）
let perChar = 1;              // 最初の応答で確定する（それまでは 1 と仮定）
```

- `lobStartOffset` ← `offsetUnits`。**受け取った文字数**で進める（`body.length / perChar`）。
  **`chars`（申告値）ではなく実際に届いたバイト数から割る**——応答が途中で切れたとき
  申告どおりに進めると、届いていない分を飛ばす。
- `lobRequestedSize` ← `wantUnits = min(SEGMENT_UNITS, ceil(remainingBytes / perChar))`。
- 歯止めは**文字どうし**で比べる（`gotUnits < wantUnits` なら打ち止め）。
- 総長の比較も文字どうし（`offsetUnits >= totalUnits`）。

`SEGMENT_BYTES` は `SEGMENT_UNITS` に改名する。**名前が単位を偽っていた**のが
この不具合の入口なので、直したあとに同じ名前を残さない。

### 2. `perChar` が判明するまでの 1 周目だけ超えうる → **最後に切り詰める**

`perChar` は応答の CCSID で分かるので、**1 周目は多めに来うる**（最大 1 セグメント＝
131,070 バイト）。1 周目を小さく頼めば防げるが、SBCS の往復が倍になるので採らない。

代わりに、**戻り値を `maxBytes` へ切り詰める**。

- 切るのは **`perChar` の倍数**の位置。UTF-16 を奇数バイトで切ると末尾が化ける。
- **末尾が上位サロゲート単独になるならもう 1 単位落とす。** 切った先が
  サロゲート対の途中だと、`decodeUtf16Be` が孤立サロゲートを吐き（表示は U+FFFD）、
  「打ち切られた」ではなく「壊れた」ように見える。
- 切り詰めても `truncated` の判定（`bytes.length < totalLength`）は変わらない。

**SBCS では切り詰めは起きない**（`want` が残量ちょうどになるので `maxBytes` を超えない）。

### 3. `too-large` の意味を守る

「先頭から連続して取れて、末尾で切れた」——これが `too-large` の約束。
1 と 2 で**穴が空かなくなる**ので、この印が嘘でなくなる。約束自体は変えない。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/hostserver/src/db/lob.ts` | `retrieveLob` のループ（本体）・`SEGMENT_UNITS` へ改名・切り詰め |
| `packages/hostserver/test/lob-multi-segment.test.ts`（新規） | 単位違いを**実機なしで再現**する回帰 |
| `scripts/research-lob-multi-segment.mjs`（作成済み） | 事実の採取 |
| `scripts/verify-lob-multi-segment.mjs`（新規） | 直ったことの実機確認 |
| `scripts/README.md` | 2 本を追記 |

`query.ts` / `db-decode.ts` は**触らない**——長さの単位（`* perChar`）は
PR #248 で既に正しく、今回の不具合はループの中だけ。

## インターフェース / データ構造

**公開の形は変えない。**

```ts
retrieveLob(conn, locator, { maxBytes?, startOffset? }): Promise<RetrievedLob>
interface RetrievedLob { bytes; ccsid; totalLength; truncated }
```

- `startOffset` は**文字**として扱う（従来はバイトのつもりだったが、
  ホストが文字で解釈する以上そちらが正）。呼び出し元は `query.ts` のみで、
  常に省略している（既定 0）ので影響は無い。**doc コメントに単位を明記する。**
- `totalLength` は従来どおり**バイト**（`declared * perChar`）。
  ここは既に正しく、画面が「全体で何バイト」を出すのに使っている。

## 振る舞いの詳細

実機の実測値（`research.md`）で、直った後の期待値を書く。

| 入力 | 直す前 | 直した後 |
|---|---|---|
| DBCLOB(1200) 524,288B / `maxBytes` 200,000 | 262,140B・**文字 65,535〜131,069 が欠落** | 200,000B・**先頭から連続** |
| DBCLOB(1200) 524,288B / `maxBytes` 40,000 | 80,000B（2 倍） | 40,000B |
| CLOB(混在) 262,144B / `maxBytes` 200,000 | 200,000B・連続（**元から正しい**） | 変化なし |
| 全部収まる場合 | 正しい | 変化なし（**回帰させない**） |

- **往復回数**: DBCLOB 200,000B は 1 周目 65,535 文字（131,070B）→
  残 68,930B → 2 周目 34,465 文字（68,930B）で**ちょうど上限**。**2 往復のまま**。
- `truncated` は `bytes.length < totalLength` のまま。切り詰めても成立する。

## エラー処理 / 異常系

- 応答の本体が申告より短い → **届いた分だけ進める**（`body.length / perChar`）。
  次の周で続きから取り直せる。
- `perChar=2` で本体が奇数バイト → 端数は捨てる（半端な符号単位を混ぜない）。
- 進まなくなった（`gotUnits === 0`）→ 打ち切る。従来どおり無限ループにしない。
- 上限が 0 以下 → 1 度も要求せずに空で返す（従来どおり）。

## ドメイン固有の考慮

- **`SBCS だけで試すと通ってしまう`**——`lob.ts` の既存コメントが警告しているのに、
  分割の経路では守られていなかった。**単体テストは 2 バイト CCSID を主役にする。**
- 実機（）は共用の本番機。表は自分のライブラリーに作り `finally` で消す。
- 検証スクリプトに内部 IP を書かない（`process.env.AS400_HOST`、既定値なし）。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 64KB 超が**バイト単位で一致** | 方針 1（オフセットを文字で進める）＋ 実機 |
| `too-large` が立つ | 変更なし（`truncated`）。方針 3 で意味が保たれる |
| 打ち切りが**先頭から連続** | 方針 1・2 |
| 単位の真偽を実測で記録 | `research.md` F1〜F3 |
| 単体テストで再現できる | `lob-multi-segment.test.ts`（偽 `conn` で文字単位のホストを模す） |
| `scripts/README.md` に載る | 2 本追記 |
