# 仕様

## D1: 装置名の渡し方はホストで変わる

| ホスト | 渡し方 |
|---|---|
| IBM i（NEW-ENVIRON を交渉する） | **どちらも送らない**（どちらも接続を壊す・実測） |
| それ以外（TK4- / z/OS） | 端末タイプに **`@名前`**（従来どおり） |

⚠ **当初は「IBM i には `DEVNAME` だけ」と決めていたが、実測で覆った。**
`DEVNAME` を送ると IBM i は交渉後に**黙ってソケットを閉じる**。
`@名前` の方は交渉が時間切れになる。**どちらの道も無い。**

**黙って無視しない。** 設定したのに効かないのは、理由が見えないと追えないので、
装置名が指定されていて使えないときは**警告を出す**。

## D2: 判定は telnet 層の中で持つ

端末タイプを送るのは telnet 層なので、そこが持つ `sawNewEnviron` を使う。
セッション層の `isIbmI` は**同じ事実の言い換え**で、層をまたいで参照しない。

`DO NEW-ENVIRON` でも `SB NEW-ENVIRON SEND` でも立てる（**早い方に間に合わせる**）。

## D3: サーバーは素通しする

`Open3270Options` に `deviceName` を足し、`onOpen3270` が
**保存済み設定（`connect.deviceName`）と直指定（`msg.deviceName`）の両方**から渡す。
5250 側の `onOpen` と同じ順（直指定が優先）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `tn3270/src/telnet/telnet.ts` | `DO` でも印を立てる ／ `@名前` を付ける条件 |
| `server/src/tn3270-manager.ts` | `Open3270Options.deviceName` |
| `server/src/ws-handler.ts` | 設定・直指定から渡す |
