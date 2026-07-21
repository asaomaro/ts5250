# テスト結果（03-web-ui-dtaq）

## 自動テスト（実機なし）

- **web-ui 全体: 540 passed / 47 files**（新規 `dtaq-api.test.ts` 11 + `dtaq-pane.test.ts` 8）。
- `dtaq-api.test.ts`: 名前検証（`'` 入りを弾く＝インジェクションの芽）、`messageFor` が
  `KNOWN_ERROR_CODES` を網羅、fetch 差し替えで各関数、`listEntries` が SQL を組む前に不正名を弾く・
  行を写像する。
- `dtaq-pane.test.ts`: 入力ガード（キュー未指定で無効）、送信・ピーク・空・属性・一覧・エラー表示、
  **クリア→取り直し後もメッセージが残る回帰**（E2E で踏んだもの）。
- lint（eslint .）/ vue-tsc / vite build クリーン。

## 実ブラウザ E2E（`scripts/verify-browser-dtaq.mjs`・Playwright + 実機 PUB400）

build 済み web-ui を server で配信し、実ブラウザで通し確認（**キューは E2E が作って片付ける**）:

| 項目 | 結果 |
|---|---|
| パネルが開く | OK |
| キューを作成（FIFO・送信者情報あり） | OK |
| 送信 → ピークで中身が出る（送信者情報つき） | `hello-e2e` + `QZHQSSRV QUSER … USER` |
| 属性表示 | 最大 256 / FIFO / キー長 0 / 送信者情報 あり |
| 一覧（SQL 経由）に hex 付きで出る | `68656C6C6F2D6532…`（= hello-e2e） |
| クリア後は一覧が空になる | OK |
| 削除後の属性取得は 404 NOT_FOUND | status=404 code=NOT_FOUND |

**7/7 成功。**

## E2E が捕まえたもの（回帰として固定済み）

- **クリアの成功メッセージが消える**（decisions D3）。`onClear` が先に message を立ててから
  `onList` を呼び、`onList` 冒頭のリセットで即消えていた。単体では見落とし、実ブラウザで発覚。
- **stale bundle**（decisions D4）。ルート `tsc -b` は vite バンドルを作らないため、
  最初の E2E は新パネルの無い古い `dist` を配信していた。`npm run build -w @as400web/web-ui` を前置。

## 未検証 / 限界

- 一覧の text は EBCDIC 解釈の best-effort（サーバー SQL デコーダが CCSID 1208 非対応。decisions D1）。
  UTF-8/バイナリは hex 列か「受信」で確認する。UI に注記済み。
- キー付きキューの UI 送受信は基本操作のみ（key 文字列＋EQ 検索）。網羅は self-protocol の core/server で担保。
