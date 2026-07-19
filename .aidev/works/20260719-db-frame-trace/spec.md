# 仕様: ホストサーバーのフレームトレース

## D1. マスクするのは CP 0x1105 のみ（実測して確認）

`datastream.ts:39-50` の CP は 10 個。**秘密を載せるのは `password: 0x1105`（パスワード置換値）だけ**。

- `seed`（0x1103）: クライアント/サーバー乱数。**設計上そのまま線上を流れる**もので、
  置換値がマスクされていれば乱数だけからパスワードは導けない → マスクしない
- `userId`（0x1104）: ユーザー名。秘密ではない（ログの `component` にも出る種類の情報）
- 他（version / ccsid / jobName 等）は秘密ではない

**推測せず全 CP を数えて確認した**（requirement 要検討 1）。

## D2. ★requirement で見落としていたリスク: 応答本文に業務データが載る

**マスクだけでは足りない。** SQL の応答フレームには**取得した行データそのもの**が入る。
つまり `LOG_LEVEL=debug` にすると、**照会した業務データが平文で stderr に出る**。

これは「資格情報の漏洩リスクは無い」（backlog の記述）では済まない話で、
**診断のために入れた機能が情報の出口になる**。requirement の要検討 1 は
「秘密を載せる CP が他に無いか」しか問うていなかったが、**問題は CP ではなく本文**だった。

**対処**:

1. **既定で出さない**。トレースは `LOG_LEVEL=debug` のときだけ動く
   （既定は `info`。作業 3 の `isDebugEnabled()` で整形コストごと省く）
2. **値を既定 64 バイトで切る**。切ったら `…(+N bytes)` と**明示する**（黙って切らない）。
   フレームの構造（LL/CP の並び）は保たれるので、切り分けにはこれで足りる
3. **README と JSDoc に「debug では応答本文が出る」と明記する**。
   知らずに本番で debug にする人を減らす

> これは「デバッグログにデータが出るのは当たり前」という話ではある。
> だが**当たり前だから書かなくてよい**とはしない——実際 backlog は
> 「資格情報の漏洩リスクは無い」で止まっており、本文のことは誰も書いていなかった。

## D3. 適用範囲: 20 バイトヘッダー形式の 5 箇所。DDM は入れない

`signon.ts` の private な `traceFrame` を `hostserver/frame-trace.ts` に移し、
**同じ形式を使う 5 箇所**（signon / server-connect / db / command / netprint / ifs）で共有する。

**DDM は入れない**（requirement 要検討 2）。フレーム形式が違い（2 バイト長・6 バイトヘッダー）
別実装が要る。**作業 4 の直後に触るリスク**——DDM は今日書いたばかりで実機検証も
最小限しか通していない——を取る価値が、この作業の中では低い。backlog に残す。

## D4. API

```ts
/** 20 バイトヘッダー＋LL/CP 形式のフレームを 1 行に整形する（debug 用） */
export function formatFrame(
  direction: "send" | "recv",
  frame: Uint8Array,
  opts?: { maxValueBytes?: number }
): string;

/** log.isDebugEnabled() を見てから整形する。呼び出し側の定型を減らす */
export function traceFrame(
  log: CoreLogger,
  direction: "send" | "recv",
  frame: Uint8Array
): void;
```

`formatFrame` を**純関数として分ける**のは、マスクと切り詰めを単体テストで固めるため。

## 受け入れ基準

- [ ] 5 箇所すべてで送受信が debug に出る
- [ ] **CP 0x1105 が `<masked N bytes>` になる**（単体テスト＋実機ログの目視）
- [ ] 長い値が切られ、**切ったことが分かる**表記になっている
- [ ] `LOG_LEVEL` が debug でないとき整形が走らない
- [ ] README に「debug では応答本文（業務データ）が出る」旨を書く
- [ ] `tsc -b` / lint / 既存テスト緑
- [ ] **実機のログを実際に読んで**、切り分けに使える内容か確かめる
