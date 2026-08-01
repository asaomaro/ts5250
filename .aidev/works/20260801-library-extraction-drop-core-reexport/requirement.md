# 要件: 利用側を直参照へ移し、core の hostserver 再輸出を撤去する

## 背景 / 課題

`.aidev/backlog/library-extraction.md` の項目 **3b**（`20260801-library-extraction-hostserver` /
PR #233 の follow-up）。**ユーザーの判断で範囲を拡張している**——backlog の 3b は
「`packages/server` を直参照へ移す」だけだったが、それでは目的を達成できないことが分かったため。

### 3b の当初の記述は目的を達成しない（2026-08-01 に判明）

PR #233 では後方互換のため `@as400web/core` の `index.ts` に hostserver の再輸出を残した。
その結果 **`core → hostserver` の辺が残っている**。3b は「これを解消する」ための項目だったが、
**server 側の import を書き換えても core は 1 行も変わらないので、辺は消えない**。

辺が消えるのは**再輸出そのものを撤去したとき**だけである。したがって本作業では
「利用側の移設」と「再輸出の撤去」を 1 つの単位として扱う——**前者だけでは価値が出ず、
後者だけでは利用側が壊れる**ため、割ると中途半端な状態がリポジトリに残る。

### 実測: `@as400web/core` から来ている名前は 4 種類に割れている（2026-08-01）

利用側は `@as400web/core` を「何でも入っている袋」として使っており、実体の在り処が
コードから見えない。分類すると次のとおり。

| 実体のある場所 | `packages/server` | `tools/hostserver-check` |
|---|---|---|
| `@as400web/hostserver` | **30 名前** | **15 名前** |
| `@as400web/base` | **4 名前**（`As400Error` / `childLog` / `assertIdentifier` / `setLogSink`） | **2 名前**（`As400Error` / `setLogSink`） |
| `@as400web/ebcdic`・`@as400web/scs`（core が再輸出） | **6 名前**（`LogicalPage` / `decodeCcsidText` / `encodeCcsidText` / `canDecodeCcsid` / `canEncodeCcsid` / `LineEnding`） | **3 名前** |
| `@as400web/core` 本体（TN5250） | 19 名前 | 2 名前（`Tn5250Error` / `ConnectOptions`） |

`import` 文の内訳（server・全 42 文）:

- **hostserver 由来のみ 4 文**（丸ごと差し替えられる）
- **混在 13 文**（import を分ける必要がある）
- TN5250 由来のみ 25 文（触らない）

### `packages/web-ui` は対象外にする（判断の根拠）

web-ui は `@as400web/core/browser` 経由で hostserver の型を 5 つ受けている
（`UploadRejection` / `IfsEntry` / `IfsListResult` / `DtaqAttributes` / `DtaqSearchOrder`）。

**これを直参照にしてはならない。** `@as400web/hostserver` は `node:net` / `node:tls` を含む
Node 専用パッケージで、ブラウザ向けパッケージの `dependencies` に載せるべきものではない。
`@as400web/core/browser` という入口は**まさにそれを避けるために在る**
（`browser.ts` の冒頭コメント: 「root は `transport/`（`node:net` / `node:tls`）を巻き込むため使えない」）。

したがって `browser.ts` の**型のみ再輸出 3 箇所は残す**。型は実行時に消えるので
（`packages/core/dist/browser.js` に `hostserver` の文字列が 0 件であることを PR #233 で実測済み）、
ブラウザのバンドルには何も入らない。

## 目的 / ゴール

1. **`packages/server` と `tools/hostserver-check` が、使っているものを在り処から直接取る**状態にする
   （`@as400web/base` / `@as400web/hostserver` / `@as400web/ebcdic` / `@as400web/scs` / `@as400web/core`）。
2. **`@as400web/core` の `index.ts` から hostserver 再輸出 39 行を撤去する**。
   これにより `@as400web/core` を import する側はホストサーバー一式を引き取らなくなる
   ＝ backlog 項目 3 で積み残した「TN5250 だけ欲しい」側が初めて成立する。

## スコープ

### 対象

- `packages/server/src` の import 付け替え（`@as400web/core` からの 42 文のうち、
  hostserver / base / ebcdic / scs 由来を含む 17 文）
- `tools/hostserver-check/src` の import 付け替え
- 両者の `package.json` に `@as400web/base` / `@as400web/hostserver`（必要なら `ebcdic` / `scs`）を追加
- 両者の `tsconfig.json` の `references` 追加
- **`packages/core/src/index.ts` から hostserver 由来の再輸出 39 行を削除**
- `packages/core/package.json` の `dependencies` と `tsconfig.json` の `references` の見直し
- `packages/core/test/hostserver-reexport.test.ts` の作り直し
  （再輸出が無くなるので、いまの「到達可能性」検査は成立しない。
  代わりに**再輸出が復活していないこと**を検査する向きへ反転させる）
- テストコード（`packages/server/test` 等）で `@as400web/core` 経由に依存している箇所の追随

### 対象外

- **`packages/web-ui`**（上記の理由。`@as400web/core/browser` の型のみ再輸出は残す）
- **`packages/core/src/browser.ts` の hostserver 型再輸出 3 箇所**（同上）
- **`@as400web/core/codec` ファサード**（`@as400web/ebcdic` への転送。既存のまま）
- `@as400web/core` が `ebcdic` / `scs` から再輸出している分の撤去
  （TN5250 の実装自身が使っており、hostserver の話とは別軸。判断が要るなら別作業）
- npm publish・別リポジトリ化
- backlog 項目 **4. TN5250 クライアント一式**の切り出し
- 公開 API の設計変更・関数の改名・振る舞いの変更

## 機能要件

- `packages/server` と `tools/hostserver-check` が、ホストサーバーの機能を
  `@as400web/hostserver` から直接 import する
- 例外・ログ・名前検証を `@as400web/base` から直接 import する
- `@as400web/core` を import しても**ホストサーバーの実装が実行時に読み込まれない**
- `@as400web/core/browser` の既存 export（web-ui が使う）は**従来どおり解決できる**
- `packages/web-ui` は**無変更**で動く
- 振る舞いは一切変わらない（import 元の付け替えのみ）

## 非機能要件 / 制約

- **`@as400web/core` → `@as400web/hostserver` の実行時依存が無くなること**が本作業の主目的。
  型のみの依存（`browser.ts`）は残ってよい
- 型検査・lint・テストが monorepo 全体で従来どおり通る（`tsc -b` / `eslint` / `vitest`）
- web-ui の本番バンドルサイズを増やさない
- 循環参照を作らない
- ライセンスは既存に合わせる（Apache-2.0）

## 完了条件 (受け入れ基準)

- [ ] `packages/core/src/index.ts` に `@as400web/hostserver` からの import が **0 件**
- [ ] `packages/core/src/browser.ts` の hostserver 由来は **`export type` の 3 箇所のみ**
- [ ] `packages/core/dist/index.js`（ビルド成果物）に `@as400web/hostserver` への
      **実行時 import が 0 件**（＝実行時の辺が消えたことの実証）
- [ ] `packages/server/package.json` の `dependencies` に `@as400web/base` と
      `@as400web/hostserver` が入っている（使っているものを宣言している）
- [ ] `tools/hostserver-check/package.json` も同様
- [ ] `packages/server/src` と `tools/hostserver-check/src` に、
      **`@as400web/core` から hostserver / base の名前を取っている箇所が 0 件**
- [ ] `npm run build`（`tsc -b`）がリポジトリ全体で成功する
- [ ] `npm test` が全 workspace で成功し、**テスト総数が減っていない**
      （基準線: 3,263 件 / 268 files。既知の skip は `zip-writer.test.ts` の 4 件）
- [ ] `npm run lint`（`packages` と `tools`）が成功する
- [ ] **`packages/web-ui` の追跡ファイル差分が 0**
- [ ] web-ui の本番バンドル JS が **359,853 バイト以下**
- [ ] 再輸出が復活したら落ちるテストがある（撤去を不変条件として固定する）

## 未確定事項 / 確認したいこと

spec 工程で決める（`mode: autonomous` のため自律判断し、根拠は `decisions.md` に残す）。

- **`hostserver-reexport.test.ts` をどう作り直すか。** いまは「再輸出が到達可能なこと」を
  検査している。撤去後は逆向き（「core が hostserver を実行時に引かないこと」）にすべきだが、
  ファイル名・検査方法・置き場所を決める
- **`packages/core` の `dependencies` から `@as400web/hostserver` を外せるか。**
  `browser.ts` が型で参照し続けるので、型検査には解決が必要。
  `dependencies` に残すか `devDependencies` へ移すか、あるいは `browser.ts` の
  型 3 箇所の置き場所そのものを見直すか
- **`@as400web/core` から `ebcdic` / `scs` 由来の名前を server が取っている 6 件**を
  この作業で直参照へ移すか（同じファイルを触るので一緒にやるのが自然だが、
  hostserver の話とは別軸。対象に含めたが、判断は spec で確定する）
- **既存の `codec-reexport.test.ts` への影響**（core の `ebcdic` / `scs` 再輸出は残すので
  基本は無影響のはずだが、`index.ts` を大きく削るため確認が要る）
