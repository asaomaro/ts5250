# 仕様: attach と帳票バッファの上限

## 設計判断

### D1. attach の鍵は `ref` ＋ `owner`

監視の前例（`watch-registry.ts:178`）と同じ条件。**判定はサーバー側**——
画面側だけで見るとリロード直後に一覧が届いておらずすり抜ける（監視のコメントに実例）。

プリンターで必要な理由は監視と違う。監視は「消費が競合する」（2 本掛かると
エントリを取り合う）が、プリンターは**装置名がホスト上で排他**なので、
二本目がそもそも繋がらない。

### D2. attach では状態を変えない

**利用者が止めたものを、開き直しただけで勝手に再開しない。**
`autoStart` が効くのは**新規に登録するとき**だけ。

### D3. 帳票バッファの上限は 50

警告（20）より多いのは、**帳票が成果物そのもの**だから。ただし 1 件が数十 KB に
なりうるので無闇には増やさない。`autoPdfDir` があれば PDF がディスクに残るので、
**最後の砦はファイルの方**。

**落としたら `delivered` も一緒にずらす**——`waitSpool` が返す位置なので、
ずらさないと「まだ渡していない」を数え続けて配列の外を指す。

**累計（`receivedTotal`）は落ちた分も数える**。監視の `received` と同じ扱いで、
「何件来たか」を見失わないため。

### D4. attach 時にバッファ済みの帳票を全部渡す

`printer-opened.reports` に載せる。**上限があるので大きさは頭打ち**（最大 50 件）。
これが無いと「繋がったが閉じている間のものは見えない」になり、attach の意味が半分になる。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `session-manager.ts` | `ref` / `receivedTotal` 追加・attach 判定・`REPORT_LIMIT` |
| `ws-messages.ts` | `printer-opened` に `reports` と `receivedTotal` |
| `ws-handler.ts` | `ref` / `autoStart` を渡す・バッファを載せる |
| `printer-residency.test.ts` | attach 4 件・上限 3 件 |
| `verify-printer-startstop.mjs` | attach の実機確認を追加 |
