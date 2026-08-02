# テスト結果: 常駐プリンターが受け取った帳票を画面から読めるようにする

## 自動テスト

| 対象 | 結果 |
|---|---|
| `npm run build`（`tsc -b` ＋ **`vue-tsc`**） | PASS |
| `npm run lint`（eslint） | PASS |
| `npm test`（全パッケージ） | **3,560 passed / 0 failed** |

内訳: base 41 / ebcdic 83 / tn5250 681 / scs 25 / **server 948** / hostserver 415 /
**web-ui 1,357** / electron 10。

追加は **server +7**（941 → 948）、**web-ui +20**（1,337 → 1,357）。

### 追加したテスト

| ファイル | 何を固定したか |
|---|---|
| `server/test/printer-report-received-at.test.ts` | `deliverReport` が受信時刻を刻む / **帳票ごとに刻む**（溜まった分が同じ時刻で並ばない）/ **live の push にも同じ 1 個が渡る** / `waitSpool`（MCP）にも載る |
| `server/test/ws-printer-report-history.test.ts` | live の `report` に載る / **開き直すと閉じている間のぶんが時刻つきで届く** / 生バイトを載せない |
| `web-ui/test/printer-report-restore.test.ts` | 一覧に入る（捨てない）/ 時刻はサーバー由来 / 先頭を選ぶ / **未読 0** / 累計は落ちた分を含む / 空でも壊れない / live の素通し・累計 +1・未読 +1 / **`receivedAt` を送らないサーバー**（live は押す・配り直しは押さない） |
| `web-ui/test/printer-report-count.test.ts` | 同値なら括弧なし / **落ちた分があれば両方出す** / 累計が無ければ保持数に落とす |
| `web-ui/test/services-pane-open-printer.test.ts` | `開く` が出る / 押すと開く / **admin でなくても出る** / 既に開いていればタブへ移る / 定義が引けなければ出さない / 失敗は同じ行に出す |

### 回帰

`launcher-open-existing` / `launcher-watch`（13 件）を**抽出の直後に単独で**回した。
`openConfigured` への切り出しは振る舞い不変——ここが緑でないと、後で `ServicesPane` を
足したときに「ボタンで壊れた」のか「抽出で壊した」のか切り分けられない。

`printer-residency.test.ts`（attach 4 件・上限 3 件）も緑のまま。

## 実機検証（実機）

`scripts/verify-printer-report-history.mjs` — **13 passed / 0 failed**。

**`WsConnection` を通す**のがこの検証の要点。既存のプリンター系スクリプトは
`SessionManager` を直接叩くが、壊れていたのは**電文の層**なので、そこを通さないと
測ったことにならない。

```
### 1. ブラウザで開く（待ち受け開始）
  id=f6732810-… state=listening startupCode=I902 resident=true
  PASS printer-opened が返る / サービス ✅ なので常駐する / 最初は帳票 0 件
### 2. ブラウザを閉じる（WS 切断。待ち受けは続く）
  PASS push のフックが外れる / エントリは残る（常駐）
### 3. 閉じている間にスプールを流す
  受信した帳票: 1 件
  PASS ブラウザが居なくても受信する / **サーバーが受信時刻を刻んでいる**
### 4. 開き直す（別のブラウザ）
  printer-opened.reports=1 receivedTotal=1
  PASS **閉じている間に届いたぶんが電文に載る** / 累計が一致 / 本文が載っている
### 5. 受信時刻
  閉じた   = 2026-08-02T11:44:47.724Z
  受信     = 2026-08-02T11:44:48.845Z
  開き直し = 2026-08-02T11:44:51.310Z
  PASS 電文に receivedAt が載る
  PASS **閉じている間の時刻**である（開き直した時刻ではない）
  PASS 開き直しより前の時刻
OK — 13 passed, 0 failed
```

**時刻の検査は不等式で置いた**（`閉じた < 受信 ≦ 到着 < 開き直し`）。
「数値が入っている」だけだと、開いた時刻で押していても通ってしまう——
実際それが直す前の挙動だった。

後片付け: `finally` で `ENDWTR` ＋ `CLROUTQ`。既存の `PRT_TEST` を借り、装置は作らず消さず。
資格情報は `passwordEnv` で env のまま渡し、設定オブジェクトに平文を置いていない。

## 受け入れ基準

| 完了条件 | 結果 | 根拠 |
|---|---|---|
| 閉じている間の帳票が一覧に出る | PASS | `printer-report-restore`「一覧に入る」＋ 実機 4 |
| 受信時刻が実際に届いた時刻 | PASS | `printer-report-received-at`（帳票ごと）＋ 実機 5 の不等式 |
| 累計と保持の両方が読める | PASS | `printer-report-count`「両方出す」 |
| サービス一覧から開いて読める | PASS | `services-pane-open-printer`（開く・タブへ移る） |
| 既存分で未読バッジが光らない | PASS | `printer-report-restore`「未読は 0 のまま」 |
| 古いサーバーでも壊れない | PASS | `printer-report-restore`「受信時刻を送らないサーバー」2 件 |
| 実機で通す | PASS | 13/13 |

## 未検証の穴

- **50 件を超えて古い帳票が落ちた状態**は実機で作っていない（1 件流すのに 1 往復かかる）。
  落ちる側は `printer-residency.test.ts`（60 件投入）で、表示は
  `printer-report-count`（`receivedTotal: 62` / 保持 2）で押さえている。
- **ブラウザ実描画での確認はしていない。** `ServicesPane` の `開く` は jsdom で押している。
  今回は座標や高さの話ではないので実ブラウザ計測（`visual-offset` 系）は不要と判断した。
- 長時間（数時間〜数日）の常駐は測っていない（backlog の別行。今回のスコープ外）。
