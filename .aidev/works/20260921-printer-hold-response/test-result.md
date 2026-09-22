# テスト結果: 出力に失敗したら応答を止める

## 実行したもの
- tn5250 のプリンターのテスト 3 ファイル 37 passed（`printer-session.test.ts` に respondAfter 5 件）
- server のプリンターのテスト 32 ファイル 502 passed（`printer-hold-response.test.ts` 10 件）
- web-ui のプリンターのテスト 18 ファイル 214 passed（`printer-pane-held.test.ts` 2 件）。型検査（`vue-tsc`）
- 実機（PUB400）: `scripts/verify-printer-hold.mjs`（core。2 回）、`scripts/verify-printer-hold-server.mjs`（server）pass=8 fail=0
- 全量・lint・build は節目でまとめて回す。

## 受け入れ基準ごとの判定
- AC1: pass — ジョブの終わり・CLEAR で閉じたジョブの応答を待つ・拒否でも応答・待っている間のレコードは溜める。サーバーで失敗したら応答しない。
- AC2: pass — 再試行で成功したら応答・また失敗したら止めたまま・成功した PDF は書き直さない・取消で応答・OFF ならすぐ・切断で手放す・ws の配線。
- AC3: pass — 画面のバーとボタン、実機で止めている間 WTR・応答で消える。
- AC4: pass — mutation K-1〜K-3・S-1〜S-7・W-1 の 11 通りすべて検出。

## 失敗の証跡

```
$ npx vitest run test/printer-hold-response.test.ts   # 1 回目
 FAIL  … > **接続が切れたら止めていた帳票は手放す** … AssertionError: expected { …(3) } to be undefined
 FAIL  … > ws … TypeError: Cannot set property sessionId of #<WsConnection> which has only a getter
      Tests  2 failed | 8 passed (10)
```
テストの作りの誤り（偽の転送が切断を知らせない・`sessionId` は getter）。直した。

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 46241)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 止めている間にホストが取り消したとき（ENDWTR *IMMED・HLDSPLF *IMMED）の振る舞い（PUB400 では権限が無い。手元の実機の SBCS プリンターでは試していない）。
- 自動印刷（`lp`）の失敗での実機の確認（PDF の失敗で確かめた。印刷はテストの環境で `lp` が失敗する形で単体だけ）。

## ラウンド 2（節目の独立点検の差し戻し後）
- 節目の全量（2026-09-21・`20260921-acs-default-keys` と 4 件の点検の修正をまとめて）: root の `npm run build` / `npm run lint` / `npm run build -w @ts5250/web-ui` すべて exit 0。
  `npm test`: base 53・ebcdic 100・hostserver 991・scs 71・server 1484（3 skipped）・tn3270 254（38 skipped）・tn5250 771・vt 202・web-ui 2349・gen-tables 10 passed
  （計 6,285 passed / 0 failed / 41 skipped）。1 回目は server の `zip-writer.test.ts` が時間上限で落ちた（下の証跡。今回の変更とは無関係のテストで、比較を軽くし上限を明示した）。
- 点検の指摘の修正を外す mutation 22 通り（`scratchpad/mut-r6.py`）: すべて検出。
- 点検役の再現テスト（欠陥があることを確かめる形）R1〜R6 は、修正後のコードで落ちる＝欠陥が消えた。R7（lp が固まる）は時間切れが 120 秒なので 1.5 秒の観測では変わらない。
- 実機（PUB400・core）: `scripts/verify-printer-hold-drop.mjs` を 2 回（research F6）。
- 実機（PUB400・server。`npm run build` のあと）: `scripts/verify-printer-hold-server.mjs` に「止めている間に停止 → 開始」の区間を足して **pass=14 fail=0**——
  停止で `dropped`・スプールは RDY・保存先を作って開始し直すと送り直され PDF ができ、応答でスプールが消えた（上の core の 2 回と別の経路での 3 回目）。

### 失敗の証跡（ラウンド 2）
点検役の再現テスト（リポジトリ外の scratchpad）の報告。修正前の HEAD での観測:

```
R1 transformTo:"*HP4" + autoPdfDir → ジョブの終わりで held。再試行 3 回とも held のまま、NO_ERROR は 1 回のまま
R2 held → stopPrinter → push 0 件、画面の畳み込みは held:true のまま、retry は /no held/
R3 ジョブの終わりの直後に stopPrinter → そのあと heldOutput が定義された。retry で pdf.ok=true、NO_ERROR は 1 回のまま
R4 held → 自動出力 OFF → heldOutput が残り、retry で pdf.ok=true
R5 PDF 成功・印刷失敗 → retry で印刷成功 → spoolId の最後の状態に pdf キーが無い
R6 held → updatePrinterOptions で保存先を直す → retry は held のまま、heldOutput.config.autoPdfDir は古い値
R7 固まる偽の lp → 1.5 秒待っても NO_ERROR は 1 回、heldOutput 無し、cancel は /no held/
```

修正後に同じ再現テストを流した出力:

```
$ npx vitest run --config vitest.config.mts   # scratchpad/rv2
     × R5 / × R6 / × R1 / × R2 / × R3 / × R4
 Tests  6 failed | 1 passed (7)
```

節目の全量の 1 回目（server）:

```
     × 大きめのデータでも往復する 8269ms
 FAIL  test/zip-writer.test.ts > 外部の unzip が受け付けること > 大きめのデータでも往復する
Error: Test timed out in 5000ms.
```
単独では 1.4 秒で通る。server の全量をもう一度流しても 5.9 秒で落ち、今回足した 3 つのテストファイルを外すと通った（負荷平均 15。同居するほかのセッション）。
外部の unzip を呼ぶテストなので上限を 30 秒と明示し、30 万要素の `toEqual` を `Buffer.compare` にした。そのあと server の全量は 1484 passed。
