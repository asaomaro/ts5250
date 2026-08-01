# レビュー記録

## ラウンド 1（2026-08-01）

差分 **115 ファイル / +357 −241**（移動は rename として現れるため、実質の読みどころは
新設 manifest 3 本・`index.ts` 2 本・ガードテスト 3 本に収束する）。

### 要件・仕様との突き合わせ

`requirement.md` の完了条件 12 項目、`spec.md`「7.」の受け入れ基準 12 項目とも
すべて実測で充足（`test.md`）。**must は 0 件**。

とくに中心となる後方互換は達成できている——`packages/server`（37 ファイル）・
`packages/web-ui`（22 ファイル）・`tools/hostserver-check` の**追跡ファイル差分が 0**。

### 指摘（すべて review 内で修正済み。差し戻しはしていない）

いずれも**移設によって記述が実態と食い違った箇所**で、コードの動作には影響しない。
放置すると「次に読む人が古い地図を信じる」種類の負債になるため、この作業のうちに直した。

- **[should]** `AGENTS.md:36` — ログの節が `packages/core/src/log.ts` を指していた（移設済み）。
  さらに「パッケージ分割と入口」の節が **ebcdic / scs しか説明しておらず**、base と hostserver が
  存在しないことになっていた。
  **対応: 修正済**。5 パッケージの表（中身・依存）に書き換え、`core → hostserver` は
  後方互換専用で逆向きは禁止であること、`base` に置くのは「複製すると壊れるもの」だけ、
  という判断基準を明記した。
- **[should]** `packages/core/src/index.ts:114` — ホストサーバー節の見出しコメントが
  **「第1段階として signon サーバーの認証のみ。SQL・データ転送は未実装」**のままだった。
  その後 SQL・IFS・DDM・DTAQ・スプール・各種一覧まで載っており、実態と正反対に近い。
  **対応: 修正済**。実体が `@as400web/hostserver` にある再輸出であること、列挙を落とすと
  外の利用者だけが壊れること、新しいコードは直接使うことを書いた（古い記述の経緯も残した）。
- **[should]** `packages/base/src/errors.ts:16` — `CONNECT_FAILED` の JSDoc が
  「投げるのは **core の** `transport/` だけ」と書いていたが、分割で throw 元が 2 パッケージに
  割れた（core の `tcp.ts` と hostserver の `host-connection.ts` / `ddm-transport.ts`）。
  意味を決め直した `20260729-connect-failed-semantics` の成果が、記述の側から腐りかけていた。
  **対応: 修正済**。実測した throw 元を両方書き、server から 0 件という不変条件も明記した。
- **[should]** `packages/base/src/log.ts` / `identifier.ts` — 移設したのに
  **「なぜ base に在るのか」がどこにも書かれていない**状態だった。log は可変状態を持つため
  複製できない、identifier はどちらのパッケージにも属さない、という置き場所の理由が
  分からないと、次の人が「使う側に寄せよう」として壊す。
  **対応: 修正済**。両ファイルの JSDoc に理由と、それを固定しているテストの場所を書いた。
- **[should]** `packages/core/test/socket-error-hint.test.ts` が
  `@as400web/base` の関数だけを検査する形になっていた（coding 中に検知。decisions.md D9）。
  検査対象が別パッケージにあるテストを残すと、base を壊しても base のテストは緑のまま。
  **対応: 修正済**。`packages/base/test/` へ移した（base のテストが 0 件だった状態も解消）。

### 設計面で確認したこと（指摘なし）

- **循環参照なし**。`hostserver → core` の import は 0 件（コメント中の言及 5 箇所のみ）。
  `packages/hostserver/src` の外部指定子は `@as400web/base`(51) / `@as400web/ebcdic`(16) /
  `@as400web/scs`(1) / `node:net`(2) / `node:tls`(2) だけで、node は `src/transport/` に限られる。
- **ブラウザ入口が汚染されていない**。`packages/core/dist/browser.js` に
  `hostserver` の文字列は **0 件**——`export type` が完全に消えている。バンドルも
  359,853 バイトで前後一致。
- **eslint のピュアロジック層ガードが消えていない**。移設前 `hostserver/**` は
  `packages/core/src/**` の glob 下で守られていた。設定に足さなければ**保護だけが黙って消える**
  ところだった（設定ファイル自身のコメントが警告していた失敗様式）。`files` に base と
  hostserver を追加し、`ignores` を新レイアウトに合わせた。
- **`export *` を使っていない**。core・hostserver とも公開面は列挙。
- **ガードが実際に効く**ことを、3 つとも壊して確認済み（`test.md`「4.」）。
  とくに log の複製は **`tsc -b` が通ってしまう**ため、実行時テストでしか捕まらない。

### 残す判断（対応しない）

- **`packages/core/src/index.ts` に `from "@as400web/hostserver"` が 36 回並ぶ。**
  1 つにまとめれば短くなるが、**節ごとの見出しコメントと列挙の対応が失われる**。
  行単位の diff も「指定子だけが変わった」と読めなくなるため、現状維持とした。
- **`CoreLogger` という型名が `@as400web/base` に移っても "Core" のまま。**
  改名は公開 API の破壊で、requirement の対象外（「関数の改名・シグネチャ変更」）。
  `@as400web/core` が再輸出しており利用側が名前で参照している。
- **`packages/server` の 37 ファイルを `@as400web/hostserver` 直参照へ移す件**は
  follow-up（decisions.md D6）。deliver で backlog に起票する。

### 集計

| 重大度 | 件数 |
|---|---|
| must | 0 |
| should | 5（すべて修正済み） |
| nit | 0 |

修正後に `npm run build` / `npx eslint packages tools` / 各パッケージのテストを再実行し、
すべて緑であることを確認済み（base 8 / hostserver 643 / core 456）。
