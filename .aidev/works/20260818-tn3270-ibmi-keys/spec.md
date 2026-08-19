# 仕様

## 設計方針

### D1: 見分けは交渉の事実で持つ

```ts
/** ホストが NEW-ENVIRON を交渉したか。**実測: IBM i は出す / TK4- ・z/OS は出さない** */
get negotiatedNewEnviron(): boolean
/** 上を根拠にした「IBM i とみなす」の判断 */
get isIbmI(): boolean
```

**`isIbmI` を「TN3270E か」で代用しない**——IBM i は `DO TN3270E` を出さない（実測）。

`negotiatedNewEnviron` を素の事実として持ち、`isIbmI` はその解釈として別に置く。
将来ほかの手がかりが要るときに、事実の方を汚さないため。

### D2: F キーの送信はセッションに置き、**非同期**にする

```ts
/** 5250 の F キー（1〜24）を送る。IBM i では `PA1` ＋ `PFn` の 2 往復になる */
async sendFunctionKey(n: number, opts?: { timeoutMs?: number }): Promise<void>
```

施錠の状態を持っているのは `Tn3270Session` なので、解錠待ちもここに置く。
**解錠が来なければ時間切れで断る**（既定 5 秒。実測 31 ミリ秒に対して十分な余裕）。
黙って握ると「キーを押したのに何も起きない」になり、原因にたどり着けない。

### D3: 判断は 1 か所（サーバー）

画面側（`aidFor3270`）は **3270 用の読み替えをやめる**。
ホストが IBM i かを知っているのはサーバーだけで、画面が別の表を持つと必ずずれる。

サーバーは押されたキーを次のどれかに落とす:

| 画面のキー | IBM i | メインフレーム |
|---|---|---|
| F1〜F12 | **`PA1` ＋ `PFn`** | 素の `PFn` |
| F13〜F24 | 素の `PFn` | 素の `PFn` |
| PageUp / PageDown | **素の `PF7` / `PF8`** | 素の `PF7` / `PF8` |
| Attn | `PF9` | 断る |
| SysReq | `PF11` | 断る |
| Help | `PF1` | 断る |
| Print | `PF4` | 断る |
| Enter / Clear / PA1〜PA3 | そのまま | そのまま |

**断るときは理由を言う**——「3270 端末にはありません」ではなく
「このホスト（メインフレーム）では割り当てが無い」と分かる文言にする。

### D4: メインフレームの挙動は 1 バイトも変えない

`isIbmI` が false のときの経路は**いまと同じ**。
TK4- 相手の既存試験が**無変更で通ること**をもって確かめる。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `tn3270/src/telnet/telnet.ts` | NEW-ENVIRON を交渉したかを覚える |
| `tn3270/src/session/session.ts` | `negotiatedNewEnviron` / `isIbmI` / `sendFunctionKey` |
| `server/src/tn3270-adapt.ts` | 押されたキー → 送るものの決定（表 D3） |
| `server/src/ws-handler.ts` | 決定に従って送る（非同期の枝ができる） |
| `web-ui/src/session-controller.ts` | 3270 用の読み替えをやめる |

## 完了条件との対応

| 受け入れ基準 | どこで |
|---|---|
| 交渉から IBM i を見分ける | `session.test.ts` ＋ 実機 |
| 実機で F3 / F4 / F12 / F13 | `scripts/verify-3270-keys.mjs` |
| ページ送り | 同上 |
| Attn / SysReq / Help / Print | `tn3270-adapt` の単体 |
| メインフレームは素の PFn | 既存の TK4- 試験が無変更で通る |
| 実ブラウザ | `scripts/verify-browser-3270-keys.mjs` |
