# 要件: IFS テキストの CCSID 決定表（中身推定 → タグ → 手動切替）

## 背景 / 課題

`20260720-ifs-file-browser` で IFS を Web UI から扱えるようにしたが、
**テキストの復号は UTF-8 の 1 段だけ**で終わっている。spec が定めた決定表のうち
2 段目（ファイルの CCSID タグに従う）と 3 段目（利用者が手動で選ぶ）は実装していない。

| 範囲 | 状態 | 根拠 |
|---|---|---|
| 決定表① 中身が UTF-8 として読めればそれを採る | 実装済み | `packages/server/src/host-ifs.ts:225`（`TextDecoder("utf-8", { fatal: true })`） |
| 決定表② ファイルの CCSID タグに従う | **未実装** | `20260720-ifs-file-browser/02-server-api/decisions.md` D7 |
| 決定表③ UI から手動で文字コードを切り替える | **未実装** | 同 D7 / `03-web-ui/test-result.md:110` |
| 応答の `ccsid` / `detectedBy` | **未実装** | `20260720-ifs-file-browser/spec.md:188-190` が定めるが応答に無い |
| core が内容の CCSID タグを露出する口 | **無い** | `IfsConnection` は `readFile(path)` のみ（`ifs-connection.ts:148`） |
| `codecForCcsid` の対応範囲 | 37 / 273 / 930 / 939 / 1399（＋別名 931・5035・5026・290 系） | `packages/core/src/codec/codec.ts:196-203` |

現状 UTF-8 として読めないファイルは `content: null` ＋ `code: "UNSUPPORTED_ENCODING"` を返し、
UI は「文字コード未対応」としてダウンロードに逃がす（`ifsApi.ts:88`）。
**実機の日本語テキストは EBCDIC が主流**なので、多くのファイルがこの状態になっている。編集も UTF-8 のものに限られる。

D7 が実装を見送った理由は「黙って壊さないため」で、判断自体は妥当だった
（非 fatal な `TextDecoder` は U+FFFD の羅列を返し、それを編集して書き戻すと元ファイルが壊れる）。
足りないのは **内容の CCSID を知る手段**で、一覧応答の offset 73 は名前の CCSID（1200）であり内容の CCSID ではない
（`20260720-ifs-file-browser/research.md` F1-5 で実測確認済み）。

backlog: `.aidev/backlog/hostserver.md:186`

## 目的 / ゴール

IFS のテキストファイルを **文字コードに関わらず正しく表示・編集**できるようにする。
何を根拠に復号したか（`detectedBy`）を利用者に見せ、推定が外れたときは手動で正せるようにする。

## スコープ

### 対象

- core: ファイル**内容**の CCSID タグを取得する口を `IfsConnection` に足す
  - 第一候補は File Server の属性取得（ListAttrs で OA2 構造体を返させる）。**原典（JTOpen）の直読と実機検証が前提**
  - 取れない場合の代替は SQL `QSYS2.IFS_OBJECT_STATISTICS`
- server: `/api/host/ifs/read` に決定表②③を実装し、応答に `ccsid` / `detectedBy` を載せる
- server/core: `codecForCcsid` が未対応の CCSID の扱い（819 / 1208 / 850 / 943 系など）
- web-ui: プレビューで採用文字コードを表示し、手動で切り替えられるようにする
- 書き戻し（保存）を、読んだときと同じ文字コードで行う

### 対象外

- IFS 以外（SQL・スプール・DTAQ）の CCSID 対応
- 書き込み時に `dataCcsid` を明示してタグを正しく付ける改修（別課題。研究 F3 で判明した「自分で書いたファイルのタグが嘘」問題の根治）
- 文字コード変換つきのアップロード（アップロードは現状どおりバイト列のまま）
- バイナリ判定・プレビュー上限（backlog の別項目）

## 機能要件

1. テキスト読み取り時、**中身が UTF-8 として読めればそれを採る**（既存の挙動を維持。BOM があれば優先）
2. 読めなければ**ファイルの CCSID タグ**を引き、対応する codec で復号する
3. どちらでも読めない、または利用者が推定を否定した場合、**UI から文字コードを手動指定**して読み直せる
4. 応答は採用した `ccsid` と根拠 `detectedBy`（`"content"` / `"tag"` / `"manual"`）を返し、UI に表示する
5. 復号できない場合は現状どおり **黙って化けさせず**、ダウンロードか手動選択を促す
6. 保存は読んだときの文字コードで符号化して書き戻す（UTF-8 固定にしない）

## 非機能要件

- 一覧表示に余計な往復を増やさない（CCSID の取得は**ファイルを開くときだけ**行う）
- 巨大ディレクトリ（`/QSYS.LIB` = 21,192 エントリ）の一覧性能を落とさない
- CCSID テーブルの追加がバンドルを不必要に膨らませないこと（backlog `library-extraction.md:41` と同じ懸念）

## 受け入れ基準

- 実機（PUB400）の EBCDIC テキスト（CCSID 273 / 1399 等）が Web UI のプレビューで**正しく読める**
- 我々自身が書いた UTF-8 のファイル（タグは 850）が、タグに引きずられず**正しく読める**
- 推定が外れたとき、UI から文字コードを選び直して読み直せる
- 復号できない場合の案内が現状と同等以上（黙って U+FFFD を出さない）
- 編集して保存したファイルが、読んだときと同じ文字コードで往復する

## 未確定事項（→ research で解消する）

- File Server の ListAttrs で **OA2 構造体を返させて内容の CCSID を取れるか**
  （JTOpen の `IFSListAttrsReq` / `IFSListAttrsRep` / `IFSFileDescriptorImplRemote.getCCSID()` を直読して確認）
- 取れない場合、SQL `QSYS2.IFS_OBJECT_STATISTICS` 経路が実用に足るか
  （SQL 接続の要否・非 ASCII パスの `PATH_NAME` が CCSID 1208 で既存 SQL 層が復号できない制約）
- 実機の IFS に実在する CCSID の分布と、`codecForCcsid` 未対応分（819 / 1208 / 850 / 943 系）をどう復号するか
  （Node の `TextDecoder` でカバーできる範囲・`tools/gen-tables` で表を起こす範囲の切り分け）
- 手動選択の候補として UI に出すべき文字コードの一覧
