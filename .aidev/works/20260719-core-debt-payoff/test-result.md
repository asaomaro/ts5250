# テスト結果

## 自動テスト

```
tsc -b                             通過
eslint .                           クリーン
npm run build -w @as400web/web-ui  通過（vue-tsc 込み）
vitest core    47 files / 484 tests（新規 6）
vitest server  29 files / 271 tests（新規 5）
vitest web-ui  36 files / 393 tests（変更なし）
```

## T2: lint ルールが実際に効くことの確認 ★この作業の要点

**ルールを足しただけで満足しない。** 2 回の retro が繰り返されたのは
「提案したが効いているか確かめていない」状態が続いたからなので、実際に確かめた。

| 確認 | 方法 | 結果 |
|---|---|---|
| 違反を検出するか | ピュア層に `Buffer.from()` / `process.env` / `__dirname` を書いて lint | ✅ **3 件検出** |
| 除外範囲が効くか | `transport/` に `Buffer.from()` を書いて lint | ✅ **通る**（許可されている） |
| 既存コードへの影響 | `eslint .` | ✅ **0 件**（下記の調整後） |

プローブ用ファイルは確認後に削除した。

### 途中で見つけたこと: retro の列挙が不正確だった

最初に retro のとおり `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` も
禁止したところ、**既存コードが 11 件落ちた**（`session/session.ts` と
`session/printer-session.ts` のネゴシエーションのタイムアウト）。

**`setTimeout` は Node 固有ではなく、ブラウザにも標準の Web API である。**
このルールの目的は「ブラウザで動かない依存を防ぐ」ことなので、移植性のあるタイマーを
塞ぐのは目的に合わない。**retro の提案をそのまま適用せず、目的に照らして外した**
（`Buffer` / `process` / `__dirname` / `__filename` / `global` / `require` を禁止）。

`Buffer` と `process` の違反は**既存コードに 0 件**だった。ピュア層が
「Node の Buffer に依存しない」とコメントを書いて手で避けていた実測（research F1）と一致する。

## ロガーの依存の向き

**素直に no-op 化すると監査証跡が静かに消える**という失敗モードを設計で潰したので、
それをテストで固定した（`packages/server/test/log-independence.test.ts`）。

- 注入していない状態でも **server のロガーは pino の実体を持つ**（`level` / `isLevelEnabled` がある）
- core の `childLog` は薄いラッパで、pino の API を持たない（＝別物であることの確認）
- core は注入前は黙り、`isDebugEnabled()` が `false`（重い整形を省ける）
- **先に取得したロガーにも後からの注入が効く**（利用側はトップレベルで束縛するため）

### 実起動での確認

`LOG_LEVEL=debug` でサーバーを起動し、PUB400 へ実接続して SQL を実行した。

```
1 "component":"hostserver-db"      ← core のログ（注入経由）
5 "component":"hostserver-signon"  ← core のログ（注入経由）
1 "component":"hostserver-sql"     ← core のログ（注入経由）
1 "component":"hostserver-start"   ← core のログ（注入経由）
1 "component":"audit","op":"list_systems"  ← server のログ（注入に依存しない）
```

**core 側の debug が注入経由で出ており、監査ログも出ている**ことを実物で確認した。

## 依存の移動

- `packages/core/package.json` の `dependencies` は**空になった**（pino が唯一の依存だった）
- `packages/core/dist` に `pino` の import は**残っていない**
- `pino` は `packages/server/package.json` の dependencies に移った

## 後方互換（改名）

作業中に **`index.ts` の re-export まで一括置換してしまい、旧名 `Tn5250Error` が外へ出なくなった**。
server 全体が型エラーになって気づいた——**これは静かに壊れる種類ではなかったが、
公開 API の互換は人手の注意ではなく型で守るべき**なので回帰テストを追加した:

- 旧名と新名が同一のクラス（`toBe`）
- 旧名で作ったものが新名の `instanceof` を通る（逆も）
- サブクラス（`SqlError`）も両方の `instanceof` を通る
- `name` は新名 / `code` / `message` / `cause` を保持

## 未検証の範囲

- **`npm ls pino` によるツリー確認は未実施**（ワークスペースの hoisting により
  ルートの node_modules に pino がある状態は変わらないため、
  「core を単体で publish したときに pino が付いてこない」ことは package.json の記述で判断した）
- ライブラリとして実際に切り出して外部プロジェクトから使う検証（本作業の対象外）
