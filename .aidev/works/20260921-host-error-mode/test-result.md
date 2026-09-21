# テスト結果: ホストのエラー（WRITE ERROR CODE）でも、ACS と同じくエラー状態に入る

## 実行したもの
- コア全テスト 725 passed・サーバー全テスト 1454 passed（3 skipped）・web-ui の関係 35 ファイル 541 passed
- 本 work のテスト: `packages/tn5250/test/system-message-lifetime.test.ts`（通し番号 3 件）・`packages/web-ui/test/host-error-mode.test.ts`（5 件）

## 受け入れ基準ごとの判定
- AC1: pass — WEC でエラー状態に入り文字を拒否する。挿入モードは上書きに戻る。同じ文言の 2 回目（番号が違う）でも入り直す。
  **実機**（ACS）: ULKPGM の RANGE に 9 → inhibit=5・文字 3 は拒否・挿入モードが解けた（research F2）。当 PJ のコアは
  WTD・WEC・READ を受けて `systemMessage` に本文を載せた（`verify-host-error.mjs`）。
- AC2: pass — 右矢印・Tab で抜けると最下行のメッセージが消える。同じ番号のまま画面が更新されても出さない。
- AC3: pass — mutation: H1 エラー状態に入らない→4 件 / H3 抜けても隠さない→3 件 / H4 文言で見分ける→3 件が落ちた。
  **H2（WEC で挿入モードを解かない）は生き残った**——画面が届くたびに上書きへ戻す既存の監視が同じ働きをするため（D3）。

## 失敗の証跡
このラウンドでは失敗が発生していない。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実ブラウザでの確認は未実施（jsdom）。WRITE ERROR CODE TO WINDOW（0x22）は実機で観測できていない（D1）。
