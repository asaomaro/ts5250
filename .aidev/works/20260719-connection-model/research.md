# 調査: 接続設定の分離（システム / セッション設定）

requirement.md の「未確定事項」4 件を事実で埋めることを目的に調査した。
調査は 4 本のサブエージェントに分割（サーバー保存経路 / 資格情報の消費者 / Web UI / MCP 影響）。

---

## 調査の問い

- Q1: 旧形式から作るシステム名をどう付けるか
- Q2: 同じ host の設定が複数あるとき、システムを 1 つにまとめるか分けるか
- Q3: MCP の引数をどう変えるか（**互換性不要と確定**。2026-07-19 ユーザー判断）
- Q4: UI の画面構成（**議論により決着済み**。下記「F7」）
- Q5: 接続設定を消費している箇所と、各々が実際に使うフィールドは何か
- Q6: 信頼境界（printer 出力設定）を新モデルでどう維持するか

---

## 判明した事実

### F1: 要件の前提はコードで裏付けられた

`host-lists.ts` の `openCommand`（host-lists.ts:112-125）が `CommandConnection.connect` に渡すのは
**`host` / `user` / `password` / `tls` の 4 つだけ**。`deviceName` / `screenSize` / `ccsid` / `port` は
読んでいない。ポートはコマンドサーバーの既定に委ねている。

requirement.md が言う「装置名を持つ設定が、それを無関係なサーバーの認証情報置き場にしている」は
推測ではなく観測可能な事実。

### F2: 解決関数が 2 つあり、同じ分岐が 4 箇所に重複している

| 関数 | 場所 |
|---|---|
| `ProfileStore.resolveConnectOptions(name, user, warn?)` | profiles.ts:323-370 |
| `ConnectionStore.resolveConnectOptions(id, user, warn?)` | connection-store.ts:224-248 |
| `ProfileStore.resolvePrinterOutput(name, user)` | profiles.ts:377-391 |

**共通ヘルパは存在しない**。「connection なら前者 / profile なら後者」の三項分岐が 4 箇所に散っている:
`ws-handler.ts:189-192` / `host-lists.ts:97-104` / `mcp-tools.ts:179-182` / `mcp-tools.ts:831-833`。

重複の結果、挙動が揃っていない（すべて事実）:

- `ConnectionStore` は `enhanced` をスキーマに持たないため、その解決だけ落ちる
- `warn` を渡すのは `ws-handler`（:85, :127, :191）のみ。`mcp-tools` 4 箇所と `host-lists` は渡さないため、
  **パスワード復号の失敗が無言で握り潰され**、自動サインオンなしに落ちる
- 排他チェックは `host-lists` にはあり（`sourceSchema` の `.refine()`、:32-34）、MCP には無く
  `connection` が黙って勝つ（mcp-tools.ts:208-212）

→ システムを単一の解決点にすれば、この重複ごと畳める。**分離の副次効果として重要**。

### F3: 保存形式の差分

| | profiles.json | connections.json |
|---|---|---|
| キー | `name`（Map のキー・一意） | `id` = `c-<uuid>`（name は重複可） |
| 資格情報 | `signon{ user, passwordEnv?, passwordEnc? }`（ネスト） | `autoSignon` / `signonUser` / `secretEnc`（フラット） |
| 所有者 | なし（admin 専用） | `owner` |
| printer 出力 | `printer{ autoPdfDir, autoPrint, pdfFontPath, pdfFontName, pageSize, fontSize }` | **スキーマに無い**（`.strict()` で拒否） |
| その他 | `enhanced` | `lastConnectedAt`（**呼び出し元 0 件のデッドフィールド**） |

暗号形式は共通: **AES-256-GCM、`v1:<ivB64>:<tagB64>:<ctB64>`**（secret-crypto.ts:78-84）。
`passwordEnc` と `secretEnc` はフィールド名が違うだけで同一形式・同一 `SecretCrypto`。
鍵は `AS400_SECRET_KEY`（無ければ `.env` へ 32 byte を自動生成、mode 0600）。

### F4: 実データは 3 プロファイル。**うち 1 つは資格情報を持たない**

`profiles.local.json`（値は読まずフィールドの有無のみ確認）:

| # | name | sessionType | signon | printer |
|---|---|---|---|---|
| 0 | `pub400` | **無し**（`effectiveType` で display に導出） | `user` + `passwordEnc` | — |
| 1 | `pub400-27x132` | `display` | `user` + `passwordEnc` | — |
| 2 | `pub400-printer` | `printer` | **無し** | `autoPdfDir` のみ |

いずれも `host` は同一、`port` / `enhanced` / `passwordEnv` は不在。`connections.json` は空配列。

**これは Q2 の答えを左右する**（後述）。UI モックでは「1 システム + 3 セッション」に畳んだが、
資格情報が一致しないレコードが混ざっているため、素朴な (host, tls, user) 一致では 2 システムに割れる。

### F5: 信頼境界は多層で守られている（新モデルで再現が必要）

printer 出力設定（`autoPdfDir` / `autoPrint` / `pdfFontPath`）の防御:

1. `connectionInputSchema` に**存在しない** + `.strict()`（connection-store.ts:21-36）→ 個人設定経由は 400
2. `canEditProfiles`（app.ts:86-90 = `(認証オフ or admin) && profiles.persistable`）配下のルートのみ到達
3. display 種別では常に破棄（profiles.ts:233）
4. 保存前検証 `validatePrinter`（app.ts:116-145）— `autoPdfDir` は存在確認、NG なら保存させない
5. 供給元は `resolvePrinterOutput`（profiles.ts:377-391）のみ。呼び出しは ws-handler.ts:135 と mcp-tools.ts:412

**`pdfFontPath` は `validatePrinter` の検証対象外**（app.ts:128/139 は 2 つのみ検査）。到達経路が
admin/認証オフに限られることで担保している。

### F6: MCP の表面はツールのみ。接続設定を取るのは 3 ツールだけ

- 全 **18 ツール**。`registerResource` / `registerPrompt` / `setRequestHandler` はリポジトリ全体で **0 件**
- 接続設定を指す引数を持つのは `open_session` / `open_printer_session` / `signon` の 3 つ
- `profile` = **設定名の文字列**、`connection` = **生成 ID `c-<uuid>`**（名前ではない。テストが明示検証）
- 優先順位は `connection` → `profile` → 直指定。**両方指定時のエラーは無く connection が黙って勝つ**
- **SQL / IFS / スプール一覧は MCP ツールとして未実装**（core と REST にはある）
- テストは `mcp-list-connections.test.ts` 1 本のみ。`open_session` 系の引数解決を検証する自動テストは無い

### F7: UI 構成は議論により決着（HTML モックあり）

同フォルダの `ui-proposal.html`（第 3 版）が確定案。要点:

| 決定 | 内容 |
|---|---|
| 階層 | システム（host・資格情報・既定 CCSID）が親、セッション（装置名・画面サイズ・CCSID 上書き）が子 |
| 設定画面 | **専用画面を作らない**。カードがその場で開いてフォームになる |
| 機能の配置 | ヘッダーではなく本体のランチャー。タブ帯の `＋` で再表示 |
| 管理画面 | 接続状況・ログも選択中システムに絞る。ログの範囲は広げられる（既定＝選択中システム） |
| ヘッダー | システム選択と利用者名のみ |
| システム切り替え | **タブは閉じない。隠すだけ**。接続本数をメニューに表示 |

### F8: Web UI にはタブのフィルタ層が存在しない

- `GroupNode.tabs` は **`string[]` の生 ID**（workspace.ts:11-16）。タブ専用の型は無い
- 種類の判別は**文字列プレフィックス**（`admin:` / `list:` / それ以外＝セッション ID）
- タブ ID は所属接続設定の情報を持たない。セッション ID → `sessionsStore.get(id)?.meta` で辿るしかない
- **`admin:*` / `list:*` タブはセッションを持たないため、現状は紐付け先が無い**

→ F7 の「システム切り替えでタブを隠す」には、タブ→システムの対応を持つ層の新設が要る。

### F9: 隣接する既存の不具合（今回触る経路にある）

1. **`mcp open_printer_session` が profile の `deviceName` を読まない**（mcp-tools.ts:406 は
   `input.deviceName` を無条件に渡す）。同経路の `ws-handler` は `co.deviceName` を使う（:121, :131）
   → MCP 経由だけ設定側の装置名が無視される
2. **`PaneTabs.vue` の `ADMIN_LABELS` に `list:*` が無い**（:14-18）。ラベルが `list:j` になり（:19-21）、
   閉じると `closeSession` へ流れる（:30-34）
3. `host-lists` は認可失敗も一律 **502**（:179-181）。`connections.ts` は FORBIDDEN→403 に写像（:18-24）
4. `HostListPane.vue:266` が未定義の `var(--border, #444)` を参照（他は `--line`）
5. `packages/server/README.md:18` が「MCP ツール（12）」— 実際は 18

---

## Q への回答

### A2: システムは (host, port, tls, user) で束ね、資格情報を持たない設定は吸収させる（Q2）

F4 のとおり `pub400-printer` は `signon` を持たない。素朴に (host, tls, **user**) で束ねると
「USER のシステム」と「資格情報なしのシステム」の 2 つに割れ、UI モックの前提（1 システム）と食い違う。

**採用する規則**:

1. 資格情報を持つ設定を `(host, port, tls, signonUser)` で束ねて**システムを作る**
2. 資格情報を持たない設定は、同じ `(host, port, tls)` のシステムが**ちょうど 1 つ**なら、そこに属させる
3. 0 個または 2 個以上なら、資格情報なしのシステムを別に作る（誤って他人の資格情報に結び付けない）

実データではこの規則で **1 システム + 3 セッション設定**になり、モックと一致する。
規則 3 は「同一 host に別ユーザーの設定が複数ある」場合の誤結合を防ぐための保守側の倒し方。

### A1: システム名は host から作り、衝突時のみユーザー名で修飾（Q1）

束ねる以上、設定名（`pub400` / `pub400-27x132` / `pub400-printer`）はシステム名に使えない（3→1）。

- 既定: `host`（例 `pub400.com`）
- 同じ host に複数システムができる場合のみ: `pub400.com (USER)` / `pub400.com (QSECOFR)`
- **セッション設定の名前は元の設定名をそのまま引き継ぐ**（`pub400` 等）。UI・スクリプトの参照が保たれる

### A3: `profile` / `connection` を捨て、`system` / `session` に置き換える（Q3）

互換性が不要になったため、最善形を採る。**現行の `profile` / `connection` という軸は「保管場所
（サーバー設定 / 個人設定）」であり、「システム / セッション」と直交している**——LLM に保管場所を
選ばせている状態で、概念軸として誤り。

```
open_session:          system? / session? / 直指定 / readOnly
open_printer_session:  system? / session? / 直指定
signon:                sessionId(必須) / system(必須)
（将来の SQL・IFS・一覧）: system(必須) のみ
```

- `session` は必ず親システムを持つので、**`session` 単独指定で資格情報まで解決できる**（一方向）
- `deviceName` は core で optional（session.ts:25）なので、**`system` 単独でも 5250 を開ける**（ホスト採番）
- 両方指定された場合は**食い違いをエラーにする**。現行の「黙って片方が勝つ」は requirement が
  問題視した混線の再生産になる
- 保管場所の区別は**サーバー側の名前解決とアクセス制御に隠す**。ただし profiles と connections で
  名前空間が衝突しうるため、一覧が返す `ref` は接頭辞つきの不透明トークンにする
- エラー文言 `host or profile required`（mcp-tools.ts:796）は `connection` を書き漏らしている。
  `system, session, or host required` に更新する

**命名の注意**: 既存の `list_sessions` は「開いているセッションの一覧」（mcp-tools.ts:264）。
セッション**設定**の一覧を足すなら名前が衝突する。

### A6: 信頼境界は「セッション設定がサーバー設定由来のときのみ」に読み替える（Q6）

現行は「`profile` 指定時のみ printer 出力を適用」（mcp-tools.ts:412）。新モデルでは
**個人セッション設定が printer 出力キーを持てない**制約（現 `connectionInputSchema` の `.strict()`）を
新スキーマでも維持する必要がある。ここが緩むと F5 の 1 層目が消える。

また、**システムは資格情報の集約点になる**ため、一覧 API が `signonUser` / `printer` を返さない
不変条件（mcp-tools.ts:329-330、テストで検証済み）を必ず引き継ぐ。緩めると一発で漏れる。

---

## 影響範囲

**同時に変えないと命名が食い違う 3 系統**（MCP だけ変えるのは不可）:

- MCP: `mcp-tools.ts`（:191-202, :227, :308-325, :377-385, :208-212, :392-402）
- WebSocket: `ws-messages.ts:10-12`, `ws-handler.ts`（:85, :127, :135, :191）
- REST: `host-lists.ts:102-103`, `connections.ts`, `app.ts`

**サーバー**: `profiles.ts` / `connection-store.ts`（新 `SystemStore` へ再編）, `secret-crypto.ts`（形式は不変）
**Web UI**: `stores/connections.ts` / `stores/sessions.ts` / `stores/workspace.ts`（タブ→システムの層を新設）,
`ConnectView.vue`, `HostListPane.vue`（`connectionsStore` を使わず fetch を直叩きしている）, `App.vue`, `PaneTabs.vue`
**スクリプト**: `scripts/verify-mcp.mjs:25`, `scripts/verify-ws.mjs:37`（**実行される E2E。引数名変更で壊れる**）
**ドキュメント**: README.md（特に **304-329 の「セッションの開き方」節は書き直しに近い**、263 と 532 の設定例、
340-370 と 490-500 の profiles.json 例）, `packages/server/README.md`, `AGENTS.md:124-150`,
`packages/core/README.md`, `packages/web-ui/README.md`, `packages/server/profiles.json.example`

**テスト**: `mcp-list-connections.test.ts` は全 7 ケースが要更新。
`profiles.test.ts` / `connection-store.test.ts` / `profiles-admin-only.test.ts` / `ws-handler.test.ts` も影響。

---

## 実現性 / リスク

- **実現可能**。暗号形式が共通（F3）なので、`passwordEnc` / `secretEnc` は**再暗号化なしで移行できる**
- 最大のリスクは**信頼境界の作り直し**（F5）。5 層あり、1 層でも落とすと printer 出力がユーザー入力から
  注入されうる。移行後に 5 層それぞれの再現をテストで確認すること
- 次のリスクは**移行規則の誤結合**（A2 規則 3）。同一 host に別ユーザーの設定がある環境で、
  資格情報なしの設定を誤ったシステムに繋ぐと、意図しない権限で接続する。保守側に倒す判断は妥当だが、
  移行結果を利用者に見せる手段（ログ or 初回起動時の要約）があるとよい
- Web UI のタブ層新設（F8）は既存構造に無い概念の追加。`admin:*` / `list:*` の扱いを先に決める必要がある

---

## spec への申し送り

1. **移行規則 A2 を仕様として明記する**（3 段階の束ね方）。実データで 1 システム + 3 セッションになることを受け入れ基準に
2. **F9 の 1 と 2 を今回のスコープに含める**。どちらも新モデルで必ず通る経路にあり、直さないと移行後も残る
   （3・4・5 は別テーマなので backlog へ）
3. **命名を 3 系統同時に変える**。MCP / WS / REST のいずれかだけでは食い違う
4. **`.strict()` による printer 出力の拒否**を新しい個人セッション設定スキーマでも維持する
5. **`warn` コールバックを新しい解決点で必ず配線する**（F2）。現状 5 経路中 3 経路で復号失敗が無言
6. `lastConnectedAt` は死んでいる（F3）。移行時に落とすか、実装するかを決める
7. 一覧 API が資格情報と信頼設定を返さない不変条件を、システム一覧にも引き継ぐ（A6）
