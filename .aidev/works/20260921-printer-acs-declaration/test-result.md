# テスト結果: プリンターの申告・ジョブの終わり・CLEAR への応答

## 実行したもの
- tn5250 `test/printer-session.test.ts`（9 件）・`test/telnet-printer.test.ts`（7 件）ほか関係分。全量は下の「節目」
- 実機（日本語機）: `scripts/verify-printer-dbcs-push.mjs` — pass=5 fail=0（I902・装置が 5553 に作り変えられた・CPA3303 で止まらない・
  帳票 1 件・日本語が載る）。`scripts/diag-printer-declare.mjs` で申告の組み合わせを並べた（research F2〜F4）
- PUB400: `scripts/verify-printer.mjs`（SBCS）— 全 PASS。`scripts/verify-printer-dbcs.mjs`（1399）— I902・帳票 1 件（日本語は置換。D1）

## 受け入れ基準ごとの判定
- AC1: pass — 4 通りの申告をバイト列で固定。交渉を通したテストで KBDTYPE・IBMSENDCONFREC が無いことも確かめた。
- AC2: pass — 日本語機で IGC 属性の DSPLIBL が帳票になった（「ライブラリー・リスト」ほか）。
- AC3: pass — 16 / 17 バイトの終わり・フラグ 0x08 の無い 17 バイトは終わりにしない・CLEAR で閉じて CLEAR_PROCESSED・
  応答の持ち越し・起動直後は無応答・opcode 1/2 以外は足さない。
- AC4: pass — mutation 10 通り（P-a〜P-j）すべて検出。

## 失敗の証跡

```
$ node --env-file=.env --env-file=.env.verify scripts/verify-printer-dbcs.mjs   # PUB400。位置合わせに答える前
  PASS 起動応答が I902（実際: I902）
CPA3394 "I" 返信
  FAIL スプールを 1 件以上受信（実際: 0）
```
装置が 5553 になったので、用紙の後に位置合わせ（CPA4044）も来る（日本語機と同じ）。スクリプトが CPA3394 にしか答えていなかった。
両方に答えるようにして届いた。届いた帳票の日本語は置換されていた（英語機。D1）。

## 全量
- tn5250 738 passed・server 1454 passed（3 skipped）・root の build・lint 通過。
- server は 1 回目に 13 件落ちた——4 つのテストが**フラグ 0x08 の無い合成の「ジョブの終わり」**（長さ 17）でプリンターを模していた。
  ACS の規則では終わりにならないので、実機の形（フラグ 0x08・本体 0x00）に直して全部通った。

```
$ (cd packages/server && npx vitest run)   # 1 回目
 FAIL  test/app-auth.test.ts > 認証・per-user 分離 > 認証 ON: 未認証で保護ルートは 401、login 後は Cookie で通る
AssertionError: expected 404 to be 200 // Object.is equality
      Tests  13 failed | 1441 passed | 3 skipped (1457)
```

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- ACS そのものを PUB400 に当てたときに日本語が置換されるか（送るバイト列は ACS と同じ）。
- 印刷先の失敗で応答を保留する（D3。別の work）。
- 帳票の先頭の 1 文字が「�」になる（SCS の 1 バイトの制御を印字文字として置いている。台帳の「【まとめ】SCS の解釈の差」）。
