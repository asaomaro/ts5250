# 仕様: 利用側の直参照化と core の hostserver 再輸出の撤去

## 0. 着手前ベースライン（2026-08-01 実測）

| 項目 | 値 |
|---|---|
| テスト | **268 files / 3,263 tests**（`zip-writer.test.ts` の 4 件は skip） |
| web-ui 本番バンドル JS | **359,853 バイト**（CSS 89,097） |
| `packages/core/dist/index.js` の `@as400web/hostserver` | **33 箇所**（＝実行時に引いている） |
| `npm run build` / `npx eslint packages tools` | 成功 |

内訳: base 1/8・ebcdic 8/83・scs 1/13・hostserver 42/643・core 49/456・
server 59/801(4 skipped)・web-ui 107/1249・gen-tables 1/10。

**`dist/index.js` の 33 箇所がこの作業の的**。ここが 0 になれば、
`@as400web/core` を import してもホストサーバーの実装は読み込まれない。

## 1. 移設の対象（実測して機械的に列挙した）

`@as400web/core` からの import を、実体のある場所ごとに割り直す。

| 移設先 | import 文 | 主な名前 |
|---|---|---|
| `@as400web/base` | 46 | `As400Error` / `Tn5250Error` / `childLog` / `setLogSink` / `resetLogSink` / `assertIdentifier` |
| `@as400web/hostserver` | 37 | `DbConnection` / `IfsConnection` / `DtaqConnection` / `CommandConnection` / `NetPrintConnection` / `DdmConnection` / `query` / `openQuery` / `queryLimited` / `listJobs` ほか |
| `@as400web/core`（残る） | 15 | `ConnectOptions` / `ScreenSnapshot` / `Session5250` / `renderSpoolHtml` / `parseCsv` / `ReplayTransport` ほか |
| `@as400web/scs` | 3 | `LogicalPage` |
| `@as400web/ebcdic` | 3 | `decodeCcsidText` / `encodeCcsidText` / `canDecodeCcsid` |

**触るファイル 58 / 書き換える import 文 61。**

| 場所 | ファイル数 |
|---|---|
| `packages/server/src` | 31 |
| `packages/server/test` | 16 |
| `tools/hostserver-check/src` | 11 |

> requirement で「17 文」と見積もったのは `packages/server/src` の本体だけを数えた値だった。
> **テストと tools を入れると 61 文**になる（テストも `@as400web/core` 経由で
> hostserver の型を取っており、再輸出を消すと同時に壊れる）。

### 1.1 `ebcdic` / `scs` 由来の 6 件も一緒に移す（requirement の未確定事項に対する結論）

`LogicalPage`（scs）と `decodeCcsidText` 等（ebcdic）は hostserver とは別軸だが、
**同じ import 文の中に混ざっている**（例: `host-spools.ts` は 1 文で
`As400Error` / `ConnectOptions` / `LogicalPage` / `renderSpoolHtml` を取っている）。
どのみちその行を割るので、**同じ作業で正しい宛先に振る**。分けると同じファイルを 2 度触ることになる。

### 1.2 `Tn5250Error` は改名しない

`tools/hostserver-check` の 7 ファイルが旧名 `Tn5250Error` を使っている。
`@as400web/base` の JSDoc は「このリポジトリ内の新しいコードでは `As400Error` を使うこと」と
書いているが、**これは新しいコードではない**。本作業は import 元の付け替えに徹し、
**識別子には触れない**（差分を「どこから取るかだけが変わった」と読める状態に保つ）。
改名は別作業（review で follow-up として記録する）。

## 2. `@as400web/core` から撤去するもの

`packages/core/src/index.ts` の `@as400web/hostserver` からの再輸出 **39 行**を削除する。
撤去後、`index.ts` に `@as400web/hostserver` の文字列は**コメントを除いて 0 件**になる。

### 2.1 `browser.ts` の型 3 箇所は残す（decisions.md D2）

```ts
export type { UploadRejection } from "@as400web/hostserver";              // 29 行目
export type { IfsEntry, IfsListResult } from "@as400web/hostserver";      // 36 行目
export type { DtaqEntry, DtaqAttributes, DtaqType, DtaqSearchOrder } …    // 60 行目
```

web-ui がこれを使う。**直参照にすると、ブラウザ向けパッケージが `node:net` を含む
パッケージを依存に持つ**ことになるので残す。`export type` は実行時に消えるため、
`core → hostserver` は**型のみの依存**になる。

### 2.2 `packages/core` の `dependencies` はどうするか（requirement の未確定事項に対する結論）

**`@as400web/hostserver` を `dependencies` に残す。**

`browser.ts` が型で参照し続けるので、`dist/browser.d.ts` を型検査する利用者にはパッケージの
解決が必要になる。`devDependencies` へ移すと、`@as400web/core` を入れた利用者が
`browser` サブパスの型を解決できない。

**完全に外すには `browser.ts` の型 3 箇所を無くすしかなく、それは web-ui を触ることを意味する**
（web-ui が `@as400web/hostserver` を `devDependencies` に持ち `import type` する形）。
requirement で web-ui を対象外にしているので、本作業では踏み込まない。**follow-up 3c** として起票する。

本作業の主目的（**実行時**の辺を消す）はこれで達成される——受け入れ基準は
`dist/index.js` の実行時 import が 0 件であることで測る。

## 3. `hostserver-reexport.test.ts` の作り直し（requirement の未確定事項に対する結論）

いまのテストは「再輸出が実行時に到達可能なこと」を検査している。**撤去すると存在意義が反転する。**

- **`git mv` で `packages/core/test/hostserver-not-reexported.test.ts` にする**
  （名前が意味と食い違ったまま残ると、次に読む人が中身と逆の期待をする）
- 検査内容:

| # | 検査 | 落ちる状況 |
|---|---|---|
| 1 | `import * as core` に hostserver の**実行時 export 名が 1 つも無い** | 再輸出を戻した |
| 2 | `packages/core/src` の `@as400web/hostserver` 参照は **`browser.ts` の `export type` のみ** | 値 import を足した／`index.ts` に戻した |
| 3 | ビルド成果物 `dist/index.js` に `@as400web/hostserver` が **0 件** | 型のつもりが値になった |
| 4 | `dist/browser.js` に `@as400web/hostserver` が **0 件** | `export type` が値に化けた |

**3 と 4 はビルド成果物を読む**——ソースの `export type` は目視では値と区別しにくく、
実行時に何が残るかは `dist` を見るのが唯一の確実な方法（PR #233 でこの見方を採って
「`dist/browser.js` に hostserver が 0 件」を実証している）。

> `dist` を読むテストはビルド済みであることに依存する。**`dist` が無ければ落とす**
> （skip にすると「ビルドしていないから緑」という無意味な緑になる）。

## 4. 変更するマニフェスト

| ファイル | 変更 |
|---|---|
| `packages/server/package.json` | `dependencies` に `@as400web/base` / `@as400web/hostserver` / `@as400web/ebcdic` / `@as400web/scs` を追加 |
| `packages/server/tsconfig.json` | `references` に `../base` / `../hostserver` / `../ebcdic` / `../scs` を追加 |
| `tools/hostserver-check/package.json` | 同様（使う分だけ） |
| `tools/hostserver-check/tsconfig.json` | 同様 |
| `packages/core/package.json` | `@as400web/hostserver` は**残す**（型のみ。コメントで理由を書く） |

## 5. 受け入れ基準

- [ ] `packages/core/src/index.ts` に `@as400web/hostserver` の import が 0 件
- [ ] `packages/core/src` の `@as400web/hostserver` 参照は `browser.ts` の `export type` 3 箇所のみ
- [ ] **`packages/core/dist/index.js` の `@as400web/hostserver` が 33 → 0 件**
- [ ] `packages/core/dist/browser.js` の `@as400web/hostserver` が 0 件（現状維持）
- [ ] `packages/server/src` `packages/server/test` `tools/hostserver-check/src` に、
      `@as400web/core` から base / hostserver / ebcdic / scs の名前を取っている箇所が 0 件
- [ ] `packages/server/package.json` と `tools/hostserver-check/package.json` が
      使っているパッケージを `dependencies` に宣言している
- [ ] `npm run build`（`tsc -b`）が成功
- [ ] `npm test` が **268 files / 3,263 tests 以上**、失敗 0（skip は `zip-writer` の 4 件のみ）
- [ ] `npx eslint packages tools` が成功
- [ ] **`packages/web-ui` の追跡ファイル差分が 0**
- [ ] web-ui 本番バンドル JS が **359,853 バイト以下**
- [ ] 再輸出を戻すと落ちるテストがある（わざと戻して確認する）

## 6. 残る未確定（plan で判定）

- **subtask に割るか**。58 ファイル・61 文だが、性質は import 指定子の付け替えで機械的。
  ただし**「利用側を移す」と「再輸出を消す」の間で一度も緑にならない**——
  再輸出を消した瞬間に移し残しが全部コンパイルエラーになるので、
  段の切り方を plan で決める（前作業の base → hostserver のように緑で刻めない）。
