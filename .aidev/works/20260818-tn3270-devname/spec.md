# 仕様

## D1: 装置名の渡し方はホストで変わる

| ホスト | 渡し方 |
|---|---|
| IBM i（NEW-ENVIRON を交渉する） | **NEW-ENVIRON の `DEVNAME` だけ** |
| それ以外（TK4- / z/OS） | 端末タイプに **`@名前`**（従来どおり） |

**両方に付けてはならない**——`@名前` は IBM i 2 台とも交渉が時間切れになる（実測）。

**断られたら理由を言う。** 受け入れるかはホストの設定次第で、断るホストは
**画面を送らずにソケットを閉じる**。素の `socket closed` では利用者が装置名に辿り着けないので、
閉じる理由に装置名を添える。

⚠ 見分けは「**画面に中身が届いたか**」で行う。レコードの有無では駄目——
断るホストも閉じる前に構造化フィールドの問い合わせを 1 つ送ってくる（実測）。

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
