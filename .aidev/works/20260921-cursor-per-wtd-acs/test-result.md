# テスト結果: カーソルの位置を WTD ごとに決める

## 実行したもの
- tn5250 全テスト 744 passed（旧い「IC が無ければ cursorSet=false」を前提にした 6 件を書き換え、新規 8 件）。server 1453 passed（下の 1 件は無関係の時間切れ）。
  web-ui のカーソル・復元関係 6 passed
- 実機: 9 画面すべてで ACS と一致（`scripts/verify-cursor-screens.mjs` と `scripts/acs-probe/cursor-screens.txt`）。QSH の出口も 21,7 で一致
  （`scripts/verify-read-only-cursor.mjs`）。分かれたレコード（SPLIT）は 5,20 → 7,20 になった

## 受け入れ基準ごとの判定
- AC1: pass — SPLIT 7,20・SPLITN 5,20（ACS と同じ）。単体とセッションを通したテストで固定。
- AC2: pass — メインメニュー 20,7・DSPFMT 7,4・DSPFMT の後 20,7・WRKOBJ 8,2・SNDMSG 5,37・WRKSPLF 3,21・SPLIT 7,20・SPLITN 5,20・窓 9,13。
- AC3: pass — mutation 7 通りすべて検出（READ で動かす・IC を持ち越さない・既定位置を置かない・欄が無いとき・0x40・IC と MC・SOH）。

## 失敗の証跡

```
$ node --env-file=.env --env-file=.env.verify scripts/verify-cursor-screens.mjs   # 1 回目（原典の「解錠中は動かさない」を入れた版）
=== dspfmt cursor=1,1 records=40,11 | 40,11 | 11,52
```
ACS は 7,4。原典の条件を入れると DSPFMT で食い違ったので外した（decisions D2）。

```
$ (cd packages/server && npx vitest run)
     × 大きめのデータでも往復する 5281ms
      Tests  1 failed | 1453 passed | 3 skipped (1457)
```
zip の書き出しのテストが全量を並べた負荷で 5 秒の時間切れ。単独では 15 件とも通る。この変更とは無関係。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- 解錠中に届く WTD（CLEAR も SOH も CC1 の施錠も無いもの）で ACS がカーソルを動かすか（decisions D2）。

## ラウンド 2（節目の独立点検の差し戻し後）
- 節目の全量（2026-09-21・5 件をまとめて）: root の `npm run build` / `npm test` / `npm run lint` / `npm run build -w @ts5250/web-ui` すべて exit 0。
  base 52・ebcdic 100・hostserver 991・scs 71・server 1456（3 skipped）・tn3270 254（38 skipped）・tn5250 761・vt 202・web-ui 2328・
  gen-tables 10 passed（計 6,225 passed / 0 failed / 41 skipped）。
- 点検の指摘の修正を外す mutation（V-1〜V-10 と V-5b の 11 通り）: すべて検出。このラウンドの対象は V-1（復元で IC を戻さない → 2 件が落ちる）。

### 失敗の証跡（ラウンド 2）
点検役の再現テスト（リポジトリ外の scratchpad）の出力。修正前の HEAD での観測:

```
restored home {"row":12,"col":33} / cursor after plain WTD {"row":12,"col":33}   # 主画面の IC は 8,13
```
