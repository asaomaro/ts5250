# テスト結果: メッセージ待ち表示（MW）を出さない

## 実行したもの
```
$ cd packages/tn5250 && npx vitest run test/wtd-applier.test.ts test/alarm-and-query-size-session.test.ts
  Tests  41 passed (41)
$ cd packages/web-ui && npx vitest run test/status-bar.test.ts
  Tests  9 passed (9)
```
全量・lint・build はバッチの節目でまとめて回す（利用者の方針）。

## 受け入れ基準ごとの判定
- AC1〜AC3: pass。AC4: 下記 mutation。

## 失敗の証跡
このラウンドでは失敗が発生していない。

## mutation（条項 `verify-by-mutation`）——つなぎを 1 つずつ外す
```
1. CC2 の点灯ビットを外す      → Tests  3 failed | 38 passed (41)
2. セッションへの反映を外す    → Tests  1 failed | 40 passed (41)
3. スナップショットへ載せない  → Tests  1 failed | 40 passed (41)
4. 表示灯を出さない            → Tests  1 failed | 8 passed (9)
```
**2 と 3 はセッション層のテストが無ければ素通りしていた**——解析と表示だけ固定すると、
間が抜けても緑になる。

## 途中で踏んだこと
- **`--t-cyan` は未定義だった**。使うと色が付かない（生色でもない）。定義済みの `--t-turquoise` に替えた。

## 未検証の穴
- **実機で MW を点けさせていない**（自分のメッセージ待ち行列へ SNDMSG すれば出せる。要確認）。
smoke: /healthz ok, / が Web UI を返した (port 45595)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
