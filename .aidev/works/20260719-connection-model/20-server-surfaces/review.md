# レビュー: 20-server-surfaces

## ラウンド 1（自己レビュー）

差分: 3 系統（MCP / WebSocket / REST）の切り替え、`config-routes.ts` 新設、旧 2 ストアと旧テスト 6 本の削除、
既存テスト 9 本の追従、E2E スクリプト 2 本、ドキュメント 6 本。

観点は「**旧ルートから移し替える際に落とした検査は無いか**」を最優先に置いた。
新機能のバグより、既存の防御が静かに消えることのほうが危険なため。

### must

**M1: 更新で資格情報が黙って消える**（`config-routes.ts` / `config-store.ts`）

一覧の応答には（当然）パスワードが含まれない。UI は「フォームをそのまま送り返す」形で更新するため、
`signon` に触れない更新が届く。新実装はこれを「signon 無し」と解釈し、**既存の資格情報ごと削除**していた。

旧 `ProfileStore.buildSignon` は `if (input.autoSignon === undefined) return keep;` で守っていた。
移し替えの際にこの規則を落としていた。

実際に再現を確認した:

```
公開表現: {"ref":"srv:s","name":"s","host":"h","autoSignon":true}
更新後の signon: null      ← 名前だけ変える更新でパスワードが消えた
```

**症状が悪質**な種類のバグで、保存は成功し、次に接続しようとして初めて
「なぜかサインオンされない」形で現れる。原因は追いにくい。

→ **修正**:
- `toSystemRecord` に既存を渡し、資格情報に触れていない更新では既存を保つ（`keep()`）
- `autoSignon: false` を明示したときだけ解除する（旧実装と同じ規則）
- 回帰テストを 3 件追加

**M2: 編集フォームのプレフィルが消えていた**（M1 の遠因）

旧 `/api/profiles` は `includeSignon: editable` で、編集者にだけ `signonUser` を返していた
（`PublicConnection` は所有者向けに常に返していた）。新実装は一切返さないため、
編集画面でユーザー名が空になり、利用者が「消えた」と思って入力し直す—— M1 と合わさると被害が増える。

→ **修正**: `listSystems(user, { serverSignon })` を追加。
サーバー設定は編集者のみ、個人設定は所有者にしか見えないので常に含める（旧挙動と一致）。
**パスワード機構（`passwordEnc` / `passwordEnv`）は形式を問わず返さない。**
MCP は既定 false のまま——機械向けの一覧に内部の値を渡さない（`mcp-config-tools.test.ts` で固定済み）。

### should

**S1: `host-lists` の 400 が 502 に化けていた**

新 `sourceSchema` は `system` と `session` の併記を正当な入力として認め、食い違いは解決時に
`CONFIG_ERROR` になる。旧実装は catch で一律 502 を返していたため、**入力の誤りが「上流障害」として
報告される**状態になった。

502 は「上流（IBM i）との通信に失敗した」意味に限るべきなので、`statusOf()` を追加し
`connections` 側と写像を揃えた（FORBIDDEN→403 / SESSION_NOT_FOUND→404 /
CONFIG_ERROR・CONNECT_FAILED→400 / それ以外→502）。

research F9-3 で「別テーマなので backlog」としていた項目だが、**今回の変更で新たに 400 が 502 に
化ける経路を作った**以上、後回しにできないと判断を変えた。

### nit

なし。

### 確認したが問題なしと判断した点

- `open_printer_session` の `deviceName` 修正（親 spec B8-1）は実機で確認済み（`WEBEMU01` が適用された）
- `stripOwner` / `stripSource` が入力を**弾かずに無視**するのは、UI が一覧の応答をそのまま
  送り返せるようにするため。所有者・保管場所はいずれもリクエストの文脈から決まる
- `/api/sessions-config` という経路名は `/api/sessions`（実行中セッションの管理 API）と衝突するため。
  美しくはないが、衝突を避ける方が重要
- 削除した旧テスト 6 本は、いずれも新モデルでの等価物を用意した
  （`config-routes.test.ts` / `mcp-config-tools.test.ts` / `config-store.test.ts` / `config-resolver.test.ts`）

### ドキュメントで判明した既存の誤り（今回の変更とは無関係）

委譲した調査で判明した分も含め、記録として残す。

- `packages/server/README.md` が「MCP ツール（12）」と書いていたが、実際は 19。
  プリンター・スプール系 5 本が一度も追記されていなかった
- ルート README の「18」も 1 件古かった
- README が「`connection` → `profile` → `host` の優先順位」と書いていたが、
  新実装は食い違いをエラーにする。実際の挙動に書き換えた
- `packages/web-ui/README.md` が存在しない `settings` ストア（localStorage 接続設定）を説明していた。
  localStorage 廃止時から陳腐化していた

## 結果

must 2 件・should 1 件をこのラウンドで修正。lint・build 緑、テスト 986 件緑（回帰テスト 3 件を追加）。
差し戻しは行わない（指摘者と修正者が同一で、修正が同一ラウンド内に収まったため）。

## 次工程への申し送り

- **Web UI はこの時点で壊れている**（想定内）。`stores/connections.ts` が `/api/connections`、
  `ConnectView.vue` / `HostListPane.vue` が `/api/profiles` を叩いており、いずれも登録されていない。
  `30-web-ui` で追従する
- M2 で追加した `signonUser`（プレフィル用）は、`30-web-ui` の編集フォームで使う
- プリンターセッションの実機確認は PUB400 の制約（特別権限 `*NONE`）で不可。親の統合 test でも同様
