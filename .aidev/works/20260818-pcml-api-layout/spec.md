# 仕様: 実機 API の PCML を通す

## 設計方針

### D1: 名前なしは「触れないが場所は取る」

`name` が無い項目は**完全名を持たない**（原典の `getQualifiedName` は名前が空なら打ち切る）。
こちらも `path` を空にし、**`slots` に入れない**。バイトだけ進める。

**入れ子ごと触れなくなる**——名前なしの構造体の子も同じ（原典と同じ）。
`planField` に「触れるかどうか」を引き回す。

### D2: 入力の長さと出力の長さを分ける

`ProgramArg` の `bytes` に **`outLength?`** を足す。

```
in    → data（算出値のまま）
out   → length = outLength ?? 算出値
inout → data（算出値）＋ length = outLength ?? 算出値
```

`ProgramParameter` は元から `inout` で `data` と `length` を別に持つので、下は無改変。

**`outLength` が算出値より小さければ断る。** ホストが書ける場所が足りず、
返るバイトが途中で切れる——**切れたことに気づけない**形の失敗になる。

### D3: 版の判定は解析の時点で行う

`minvrm` / `maxvrm` は**引数の本数を変える**（原典は列から丸ごと落とす）。
画面が並べるものと実際に送るものを食い違わせないため、**`parsePcml` の時点で落とす**。

```ts
parsePcml(text, { vrm })   // vrm は (V<<16)+(R<<8)+M
```

**版が分からないのに `minvrm` がある記述は断る。** 勝手に通すと本数がずれる。

版は `signon` が既に返している（`rawVersion`）。**符号化が原典と同じ**なので、
`CommandConnection` に持たせて渡すだけでよい。

### D4: `offset` は引き続き断る

出力の値で飛び先が決まるので、静的な割り付けには載らない。
出力の読み取りを「先頭から順に解く」へ作り替えるまで、**理由を言って断る**。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `hostserver/src/command/program-args.ts` | `bytes` に `outLength?` |
| `hostserver/src/command/pcml-parse.ts` | 名前なし・`outputsize`・`minvrm`/`maxvrm` |
| `hostserver/src/command/pcml-layout.ts` | 触れない項目を飛ばす・`outLength` を決める |
| `hostserver/src/command/command-connection.ts` | `hostVrm` を公開 |
| `server/src/host-pcml.ts` | 版を取って渡す |
| `web-ui/src/components/PcmlPane.vue` | 予約域を「（予約）」として出す（入力欄は出さない） |

## 型の追加

```ts
export interface PcmlField {
  // …既存…
  /** 名前なしは "" になる。**完全名も ""** で、名前では触れない */
  name: string;
  path: string;
  /** 整数、または**入力項目の完全名** */
  outputsize?: number | string;
  /** `VvRrMm` を数にしたもの。`(V<<16)+(R<<8)+M` */
  minvrm?: number;
  maxvrm?: number;
}

export interface PcmlParseOptions {
  /** ホストの版。`minvrm` / `maxvrm` の判定に要る */
  vrm?: number;
}
```

## 完了条件との対応

| 受け入れ基準 | どこで |
|---|---|
| `qsyrusri.pcml` が手を入れずに解析できる | 固定資料に IBM の原本をそのまま置く |
| 実機の QSYRUSRI を呼べて値が一致 | `scripts/verify-pcml-api-osaka.mjs` |
| 予約域がバイトを占める | `pcml-layout` の単体テスト |
| `outputsize` が名前で解ける | 同上 |
| 版に合わない引数が外れる | `pcml-parse` の単体テスト |
| `offset` は断る | 既存の単体テスト（据え置き） |
| REST と画面 | `host-pcml` / `PcmlPane` |
