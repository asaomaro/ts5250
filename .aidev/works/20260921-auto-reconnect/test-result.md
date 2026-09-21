# テスト結果: ホストに切られたら、ACS と同じく自動で繋ぎ直す

## 実行したもの
- 全量 `npm test`（全ワークスペース）— すべて緑。**独立点検の対応後**: tn5250 **722**・server **1454**（3 skipped）・web-ui **2236**
  （対応前: 716 / 1451 / 2231）
- `npm run build`（root。web-ui の `vue-tsc` の test 込みを含む）・`npm run lint` — 通過
- 本 work のテスト: `packages/tn5250/test/auto-reconnect.test.ts`（8 件）・`packages/server/test/ws-host-reconnect.test.ts`（4 件）・
  `packages/web-ui/test/host-reconnect.test.ts`（5 件）・`type-ahead.test.ts`（繋ぎ直し中は溜めない 1 件）

## 受け入れ基準ごとの判定
- AC1: pass — 切られた直後に `reconnecting`（1 回目は即座）→ 新しい画面 → `reconnected`。繋がらない・交渉中に切られたら
  間隔を置いて試し続け、3 回目で繋がる。前の接続のメッセージ待ち表示を持ち越さない。
  **実機**: `SIGNOFF ENDCNN(*YES)` で約 0.05 秒後に新しいサインオン画面（3 回。うち 1 回は装置名 WEBSF0 に固定）。
  対照の `SIGNOFF`（ENDCNN(*NO)）・`DSCJOB` ではホストが接続を切らず、繋ぎ直しは起きなかった。
- AC2: pass — サーバーは `host-reconnecting`（回数・理由）と施錠した画面を送り、繋ぎ直せたら `host-reconnected` と新しい
  ジョブ名を送る。ブラウザは「繋ぎ直しています」を出し、送らない（フラグキーも）・溜めた先打ちを捨てる・繋ぎ直し中の打鍵を溜めない。
  **実機（サーバー経由）**: `key-done` → `host-reconnecting` → 施錠した `screen` → サインオン画面の `screen` →
  `host-reconnected` → `jobinfo`（`scripts/verify-ws-auto-reconnect.mjs`）。
- AC3: pass — 既定では繋ぎ直さない。自分から切ったら・待っている間に切ったら止まる。起動応答で拒否（8936）されたら 2 回目で諦める。
  ブラウザから開いた接続だけ ON（MCP は OFF）。
- AC4: pass — mutation: コア R1〜R7（7 通り）・配線 W1〜W7（7 通り）・独立点検の対応 Q1〜Q5（コア）・S1〜S4（サーバー）が
  すべて落ちた（Q4 は最初は生き残り、購読者の例外を拾ったことを警告で見る形にテストを強めて検出）。
  **独立点検の対応後に実機（サーバー経由）でもう一度確かめた**（`host-reconnecting` → `host-reconnected` → サインオン画面）。

## 失敗の証跡
このラウンドでは実装の失敗は発生していない。テストの書き方を 1 か所直した（`sendAid` は閉じたセッションと同じく同期で投げる）:

```
     × 繋ぎ直している間は送れない（Attn・SysReq も。送り先が無い） 4ms
As400Error: reconnecting to the host
      Tests  1 failed | 7 passed (8)
```

## 起動確認（smoke）
```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実ブラウザ（Playwright）での表示は未確認（ws の上での実機確認まで）。
- 無操作の切断（QINACTITV）・回線断での繋ぎ直しは実機で起こしていない（ENDCNN と同じ「確立後の切断」の経路）。
- 再接続のあと ACS が自動サインオンを送り直すか（未確認のまま。当 PJ はブラウザの直指定では資格情報を送らない）。
