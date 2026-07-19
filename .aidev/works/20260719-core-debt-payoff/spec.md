# 仕様: core の負債返済（3 件）

research の結論どおり、**5 件のうち 3 件だけ**返す。残り 2 件は理由つきで backlog に戻す。

## D1. `no-restricted-globals` を追加する

`eslint.config.js` の core ピュア層向けブロックに追加する。

```js
"no-restricted-globals": ["error",
  { name: "Buffer",       message: "…Uint8Array を使う（transport/・log.ts のみ許可）" },
  { name: "process",      message: "…" },
  { name: "setTimeout",   message: "…" },
  { name: "setInterval",  message: "…" },
  { name: "clearTimeout", message: "…" },
  { name: "clearInterval",message: "…" },
  { name: "__dirname" }, { name: "__filename" }, { name: "global" }
]
```

適用範囲は既存の `no-restricted-imports` と**同じ**（`packages/core/src/**`、
`transport/**` と `log.ts` は除外）。

**検証方法が要点**（requirement の受け入れ基準「機械的に検証できる」）:
違反コードを書けば落ちることを、**実際に lint を走らせて確かめる**。
ルールを足しただけで満足しない——2 回の retro が繰り返されたのは
「提案したが効いているか確かめていない」状態が続いたからである。

## D2. ロガーを注入可能にする

### 何が問題か

`core` の dependencies が `pino` のみ＝**ライブラリが利用側にロガーを強制している**。
codec を「依存ゼロ」で切り出したいのに、root エントリを値で触ると pino が入る。

### 設計 ★失敗モードに注意

research F2 のとおり、**server の 6 ファイル（`audit.ts` を含む）が core の `childLog` に
乗っている**。core を単純に no-op 既定にすると、**監査証跡が静かに消える**。
「ログが出ない」は気づきにくい失敗であり、これを設計で潰す。

**採る形: 依存の向きを逆にする。**

1. **core**: `log.ts` を pino 非依存にする。
   ```ts
   export interface CoreLogger {
     debug(message: string): void;
     info(message: string): void;
     warn(message: string): void;
     error(message: string): void;
   }
   /** 既定は何もしない。ライブラリは利用側にロガーを強制しない */
   export function setLogSink(factory: (bindings: Record<string, unknown>) => CoreLogger): void;
   export function childLog(bindings: Record<string, unknown>): CoreLogger;
   export const log: CoreLogger;  // 既存 API を維持
   ```
   - core が実際に使うのは **`log.debug` だけ**（14 箇所すべて。research F2）だが、
     インターフェースは 4 メソッドにする（`log` を再エクスポートしている以上、
     利用側が info/warn/error を呼べる必要がある）。
   - `pino` を core の dependencies から**外す**。

2. **server**: 自前のロガーを持つ（`packages/server/src/log.ts`）。
   pino を **server の dependencies に移す**。server の 6 ファイルは
   `@as400web/core` ではなく `./log.js` から `childLog` を取る。
   - → **server のログは core の注入状態に依存しなくなる**。
     `buildApp` だけを使うテストでも server 側のログは従来どおり動く＝**静かに消えない**。

3. **`main.ts`**: 起動時に `setLogSink` で core へ pino を注入する。
   これで hostserver の `log.debug` は従来どおり出る。

**この向きにする理由**: 「core が既定 no-op、server が自前で持つ」なら、
**消えうるのは core の debug ログだけ**で、しかもそれは本番では `main.ts` が注入する。
逆向き（server が core の注入に依存し続ける）だと、注入し忘れで監査ログが消える。
**消えて困る度合いが高いほうを、注入に依存させない。**

### 後方互換

`log` / `childLog` は `index.ts` から export され続ける（型が `Logger`→`CoreLogger` に変わるが、
利用側は `.info()` 等を呼ぶだけなので影響しない）。

## D3. `Tn5250Error` → `As400Error` へ改名（別名を維持）

- クラス名を `As400Error` にし、**`Tn5250Error` を別名として export し続ける**
  （`export { As400Error as Tn5250Error }`）。既存の 298 箇所は壊れない。
- `this.name` は `"As400Error"` にする。
- **core/src 内の使用箇所は新名に置換する**（自分のコードは新名に揃える）。
  server / tools は**別名のまま残してよい**——別名が生きていることの実証を兼ねる。
  ただし本作業で触るファイルは新名に寄せる。
- `SignonError` / `CommandError` / `SqlError` の継承元も新名にする。

> 名が体を表していない、というのが元の指摘（ホストサーバーは TN5250 ではない）。
> 別名を残すのは後方互換のためであって、**新旧が混在してよいという意味ではない**。
> 別名は「外部利用者向けの互換シム」と位置づけ、その旨をコメントに書く。

## やらないもの（backlog へ戻す）

### `ErrorCode` の整理

**backlog の前提が実測と食い違っていた。** 「19 種に無縁のものが混在」→ 実際は
**21 種で未使用は 0 件**。消す作業は存在しない。

実在する問題は別物: **`CONNECT_FAILED` が server 側で接続と無関係な用途に 11 箇所
流用されている**（限度到達・参照不正・users ファイルが読めない等）。
これは「core の型を整理する」ではなく「**server の 11 箇所の意味を決め直す**」作業で、
HTTP ステータス写像（`host-api.ts`）にも波及する。

→ backlog の記述を**実測に基づいて書き換えて**戻す。

### CCSID テーブルの同梱単位

18,900 行 / 1.17 MB が丸ごと付いてくるのは事実。ただし直すには遅延 import 化・
サブパス分割・生成物の形式変更のいずれかが要り、**ブラウザのバンドル方法に影響する**。
バンドルサイズを実測しながら進める独立作業にする（lint 追加や改名と混ぜない）。

→ backlog に、**測った数値つきで**戻す（`katakanaChar()` 1 関数のために全 5 テーブルが
到達可能になっている、という具体的な原因も記す）。

## 受け入れ基準

- [ ] `no-restricted-globals` が追加され、**ピュア層に `Buffer.from()` を書くと lint が落ちる**
      ことを実際に確認した
- [ ] `packages/core/package.json` の dependencies から `pino` が消えている
- [ ] `pino` が `packages/server/package.json` の dependencies にある
- [ ] server の 6 ファイルが server 自身の `log.ts` を使っている
- [ ] `main.ts` が `setLogSink` で core にロガーを注入している
- [ ] **注入しない状態でも server のログが出る**（＝監査ログが静かに消えない）ことをテストで固定
- [ ] `As400Error` が定義され、`Tn5250Error` が別名として使える
      （既存の `import { Tn5250Error }` が壊れない）ことをテストで固定
- [ ] core / server / web-ui の全テストが緑、`tsc -b` / lint / web-ui ビルドが通る
- [ ] やらない 2 件が、**実測値つきで** backlog に戻っている
