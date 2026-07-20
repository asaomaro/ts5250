# 統合検証結果: IFS ファイルブラウザ（親 work）

3 つの subtask（01-core-listfiles / 02-server-api / 03-web-ui）はいずれも単独で
review 通過済み。ここでは **subtask 横断の結合**を検証する。

## 全パッケージのテスト

| 対象 | 結果 |
|---|---|
| core | 713 passed |
| server | 400 passed |
| web-ui | **521 passed** |
| tools | 4 passed |
| 合計 | **1,638 passed / 0 failed** |
| `npm run lint` | 指摘なし |
| `npm run build -w @as400web/web-ui`（`vue-tsc` 込み） | 型エラーなし |

## 契約整合（3 層の境界）

第三者エージェントに 4 つの境界を実コードで突き合わせてもらった。

| 境界 | 判定 |
|---|---|
| 1. 型の共有（`IfsListResult` / `IfsEntry`） | 整合。core → `browser.ts` re-export → web-ui が同じ型。`hasMore` / `canContinue` / `nextRestartId` を server が素通し、web-ui が 3 つとも読む |
| 2. エラーコードの往復 | **食い違い 1 件（修正済み）**。下記 |
| 3. 上限値の一貫性 | 整合。413 の本文フィールドが型・値とも往復 |
| 4. パスの扱い | 整合。ルート・末尾スラッシュ・ワイルドカード付与が 3 層で噛み合う |

### 境界 2 の食い違いと修正（統合テスト固有の欠陥）

**web-ui の文言化が `NOT_FOUND` / `ACCESS_DENIED` を知らず、その 2 コードだけ
英語＋rc の生文言（`File not found (rc=2)`）が利用者に出ていた。**
さらに一覧とプレビューの経路は `describe()` を通らず `e.body.error` を直接使っていたため、
全コードで英語が出る余地があった。

これは **subtask 単独テストでは原理的に出ない**。03 のテストは server の応答をモックで作るので、
自分の分岐に合わせたモックを渡していた。server が実際に返すコードと UI の分岐を
突き合わせて初めて見える（decisions D12）。

修正: 文言化を `ifsApi.ts` の `messageFor` に集約し、全 3 経路が `e.message` を使う。
**server が返す「利用者が対処できる」全コードを実コードから列挙し、UI が全部日本語にできることをテストで固定**
（インフラ障害系 502/400 は意図的にサーバー生文言へフォールバック——他のホストパネルと同じ方針）
（`ifs-error-messages.test.ts`）。`NOT_FOUND` を消す変異・`KNOWN_ERROR_CODES` から抜く変異の
両方が落ちることを確認。

## 通しの動作（実ブラウザ → server → core → 実機 PUB400）

`scripts/verify-browser-ifs.mjs` を最新ビルドで実行。**15/15 成功**（編集・保存を含む）。
実ブラウザから実機 IFS まで、3 層が結線されて動く:
ツリー（開閉・現在地）/ 一覧 / プレビュー（テキスト・PDF・画像を `naturalWidth` で実描画確認）/
ダウンロード / zip（展開一致）/ アップロード / 削除 / 辿れない場所の案内 /
**削除失敗が NOT_FOUND を返す**（英語漏れの回帰）。

## backlog へ送るもの（deliver で明示）

いずれも spec に含まれるが今回は実装しない。理由は各 decisions に記録済み。

- **CCSID の決定表**（02 D7）。現状 UTF-8 で読めないテキストは `content: null` で
  「文字コード未対応」の案内。**実機の日本語テキスト（EBCDIC）の多くはこの状態**
- ~~テキスト編集・保存~~ → **実装した**（統合 review で気づき、ユーザー判断。03-D13）。
  UTF-8 で読めたテキストに限る（CCSID 未対応のため）
- **プレビューのサイズ上限・ヌルバイト判定**（spec 193-207。03 D11）
- **IFS のディレクトリ削除（rmdir）**。listFiles / mkdir は実装、rmdir は対象外
- 上限「値」そのものの UI 表示（超過した実測値は出るが、上限 20MB / 5MB は非表示）

## backlog hostserver.md:177 の消化

「IFS のディレクトリ操作と、`DEFAULT_CHUNK` を超える複数ブロック読み書きの検証」:
- 複数ブロック読み書き → research で 4MB まで実機検証（SHA-256 一致）
- ディレクトリ操作 → listFiles（一覧）と mkdir（作成）を実装・実機検証。
  rmdir（削除）は残す
deliver 時にチェックを入れる。

## spec の受け入れ基準の充足

「アップロードと**編集・保存**が実機で反映される」——
アップロード・編集・保存すべて実装し、実ブラウザ E2E で確認済み（編集は UTF-8 のみ）。
requirement でユーザーが選んだ全項目（一覧・プレビュー・取得・zip・アップロード・
編集保存・フォルダ作成・削除）が揃った。
