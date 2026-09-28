# テスト結果: HLLAPI の AID の前の検査

## 実行したもの
- server `test/hllapi.test.ts` — 109 passed（AID の前の検査 14 件を足し、止まった後のカーソルを Enter で見ていた 3 件を「次の字の行き先」で見る形に直した——Enter は MF の違反で止まるようになったため）
- 全量: tn5250 1,105 passed／server 1,660 passed・3 skipped／web-ui 2,864 passed。`npm run lint`・`npm run build` exit 0
- mutation 15 通り（`scratchpad/mut-aid.json` 13・`mut-aid2.json` 2）——すべて KILLED
- 実機（社内機）: `scripts/verify-hllapi-tab-mandatory.mjs` — pass=21 fail=0（2 回。AID の 4 場合を足した）

## 受け入れ基準ごとの判定
- AC1: pass — ACS 場合 5・9 と同じく MF に AB で Enter・CA03 は止まる。実機: rc=5・ADJPGM のまま・次の字は 7,20 へ（`XB`）。単体で CA キー・カーソルの無い欄（場合 7）
- AC2: pass — 単体（欄頭へ戻る・カーソルの無い欄は見ない）
- AC3: pass — ACS 場合 2・3・1・8 と同じ。実機: 素の欄に打って Enter は止まり ME 欄へ（11,20 に `X`）、CA03 は送って抜ける、未変更の Enter は rc=0。単体で除外キー（Clear・Attn・SysReq・Test Request）・継続欄・保護・施錠中

## 失敗の証跡
このラウンドでは実装の失敗は発生していない。変更の直後、既存のテスト 3 件が落ちた（止まった後に `@E` でカーソルを見ていた。`@E` は MF の違反で止まるのが正しい）:

```
     × **MF に途中まで打って @T は止まる**——欄頭に戻り rc=5、後ろの Enter は送らない 15ms
     × **欄頭からの @B（前の欄へ出る）は止まる**、欄の途中からの @B（同じ欄の先頭へ戻る）は止まらない 6ms
     × **@0（ホーム位置が欄の外）も止まる** 4ms
      Tests  3 failed | 92 passed (95)
```

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴
- 「何も打たずに @E」は rc=0 だけで、ホストへ届いたかは画面から区別できない（ADJPGM は Enter で描き直すだけ）
- Print・PA1〜3 を ACS の `processAIDCode` が検査するかは原典で確かめていない（ペインと同じく検査する）
- エラー 32（欄を出ずに AID）は見ない（台帳）
