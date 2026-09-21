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
