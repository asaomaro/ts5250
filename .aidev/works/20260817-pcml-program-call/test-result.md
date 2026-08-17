# 試験結果

## 実機（SR-OSAKA）

### 1. `PGMINFO(*PCML)` が通るか — **通る**

`scripts/research-pcml-osaka.mjs`。RPG IV を作り、コンパイル時に PCML を吐かせた。
タグは **819**、1,086 バイト。全文は `research.md` A に採ってある。

### 2. 宣言どおりのバイト並びか — **8 PASS / 0 FAIL**

`scripts/research-pcml-layout-osaka.mjs`。**PCML の宣言だけを頼りに生バイトで組んで**呼んだ。

```
REC は 29 バイト（packed(7,0)=4 + char(20)=20 + packed(9,4)=5）
  PASS IONUM = 12.34 × 2 = 24.68
  PASS REC.ID = 7                      ——構造体は連結**である**
  PASS REC.NM = "REC:HELLO"
  PASS REC.RATE = 1.5000
  PASS ITEMS = AAA,BBB,CCC,DDD          ——配列は反復**である**
  PASS CNT = 4
  PASS BIG = 9000000000                 ——int(8) は 8 バイト
  PASS AMT = 1.00 + 1 = 2.00
```

### 3. 記述から名前だけで呼べるか — **15 PASS / 0 FAIL**

`scripts/verify-pcml-osaka.mjs`。**生バイトを 1 つも組まない**。記述は IFS から読む。

```
### 1. IFS から記述を読む: /home/***/pcmltst.pcml
  タグ=819 / 1086 バイト
  PASS PCMLTST の記述を読めた / 項目が 7 つ / REC が構造体として展開された
### 2. 名前だけで呼ぶ
  PASS 呼び先は ASAOLIB/PCMLTST（path から解いた）
  PASS 引数は 7 本
  PASS 呼び出しが成功
### 3. 名前で読む
  PASS PCMLTST.IONUM = 24.68        PASS PCMLTST.REC.ID = 7
  PASS PCMLTST.REC.NM = REC:HELLO   PASS PCMLTST.REC.RATE = 1.5000
  PASS PCMLTST.ITEMS(1..4) = AAA,BBB,CCC,DDD
  PASS PCMLTST.CNT = 4              PASS PCMLTST.BIG = 9000000000
  PASS PCMLTST.AMT = 2.00           PASS 入力専用の PCMLTST.INTXT は返らない
15 PASS / 0 FAIL
```

### 4. 実ブラウザ（Playwright → 実 IBM i）— **19 PASS / 0 FAIL**

`scripts/verify-browser-pcml-osaka.mjs`。画面の操作だけで一通り。

```
OK PCML ペインが開く / 記述からプログラムを選べる / path から呼び先が読める
OK **構造体が入れ子で並ぶ** — PCMLTST.REC.ID, PCMLTST.REC.NM, PCMLTST.REC.RATE
OK **配列が件数ぶん並ぶ（1 始まり）** — ITEMS(1)…ITEMS(4)、(5) は出ない
OK 型と長さが添えられる / **符号つき整数として出る**
OK 呼び出しが成功する — 成功（戻り 0） 呼び先 ASAOLIB/PCMLTST
OK IONUM=24.68 / REC.ID=7 / REC.RATE=1.5000 / CNT=4 / BIG=9000000000 / AMT=2.00
OK REC.NM=REC:HELLO / ITEMS(1..4)=AAA,BBB,CCC,DDD / 入力専用は結果を持たない
OK **どの項目が悪いか画面に出る** — PCMLTST.IONUM: 数値として読めません: ""
19/19 成功
```

**この検証で 1 つ直した。** 最初は最後の 1 件が落ちた——`数値として読めません: ""` とだけ出て、
**どの欄か分からない**。10 進の変換は値しか知らないので、`encodeArgValue` が呼び名を前置するようにした。
構造体の中では、値だけを見せられても探せない。

## 自動テスト

| 対象 | 件数 |
|---|---|
| `hostserver`（`pcml-parse` 25 / `pcml-layout` 22 を含む） | **917 passed** |
| `server`（`host-pcml` 12 を含む） | **1,188 passed** |
| `web-ui`（`pcml-pane` 13 を含む） | **1,660 passed** |
| その他（base / ebcdic / tn5250 / tn3270 / tools） | 617 passed |
| 合計 | **4,382** |

`npm run build`（`vue-tsc` を含む）・`npm run lint` ともに緑。

### 1 件だけ、この作業と無関係に落ちる

`web-ui` の `tab-visibility.test.ts`「全タブを畳んでも…」が **5 秒で時間切れ**になる回がある。

**原因はこの機械の負荷**——同じ箱で別のプロジェクト
（`/workspaces/stock-price-predication`）の vitest が 12 コアを 15 時間占有していた
（`load average 21`）。この試験は `App.vue` ごと組み立てるので重い。

- **単独では 3/3 通る**（正しい作業ディレクトリで実行した場合）
- 触っていないファイルで、`pcml:` とは無関係（`sql:query` と `ifs:files` しか使わない）
- 負荷が下がった回では `server` も `web-ui` も緑になっている

⚠ **`npx vitest run --root packages/web-ui` をリポジトリ直下から叩くと、別に 3 件落ちる。**
`browser-entry.test.ts` / `fkey-legend.test.ts` が**作業ディレクトリからの相対路**でファイルを読むため
（`/workspaces/ts5250/src` を見に行って ENOENT）。**試験の問題ではなく叩き方の問題**なので、
`npm test`（各パッケージを自分の場所で走らせる）で確認すること。

## ついでに直した既存の不具合

`npm test` が **exit 1** で終わっていた（`main` でも同じ）。原因は
`packages/hostserver/test/host-connection-stream.test.ts` の偽サーバーで、
**ソケットの `error` を拾っていない**こと。検証が接続を途中で閉じるので ECONNRESET が上がり、
Node の未処理例外になっていた。**全件緑なのに 1 で終わる**ので、
「テストが通っている」と言えない状態だった。`main` の作業ツリーを別に用意して
**この作業の変更が原因ではない**ことを確かめたうえで、1 行足して塞いだ。
