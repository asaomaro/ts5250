# 仕様: サービス一覧の画面

## 概要

**定義が行、状態が列。** プリンターと待ち行列を**同じ表**に並べる——利用者にとっては
「サーバーで動き続けるもの」で 1 つの概念であり、種別は行の属性でしかない。

## 設計方針

### 1. 一覧は REST、操作は WS

**タブを開いても接続を増やさない。** サービスは「ブラウザが居なくても動くもの」なので、
見に行くために繋ぐのは筋が違う。一覧は `GET /api/printers` / `/api/watches`（#256）で足りる。

操作だけ WS を使う——監査（`withAudit`）と認可が WS 側に揃っており、
REST に第 2 の口を作ると**規則が 2 か所になる**。`open` を要さないメッセージだけなので
セッションは増えない。

状態は push を受けず、**操作のあと少し待って一覧を引き直す**（＋定期取得）。
押した結果が効いたかは、画面が覚えている値ではなく**サーバーに聞く**。

### 2. 見せる範囲を広げるのに `listSessions` は緩めない

サーバー設定は**読むのも admin だけ**（`assertProfileAccess`）。利用者の判断は
「見るだけは許す」なので、**狭い形だけを別の口で返す**。

```ts
export interface ServiceDef {
  ref: string; name: string; sessionType: SessionType;
  service?: boolean; autoStart?: boolean; hasOutput?: boolean; owner?: string;
}
```

**ホストもパスも装置名も入らない。** 開いてよい理由は「形が狭いから」であって、
「admin 判定を緩めたから」ではない——`listSessions` の規則は 1 文字も変えていない。

個人設定側は**従来どおり所有者だけ**（`canSeeService` の既定は `canSee`）。
サーバー設定のストアだけが `canSeeService` を `true` に上書きする。

### 3. 理由の文面は操作できる相手にだけ

`error`（`device PRT1 in use`）と `warnings`（自動出力の失敗）は
**サーバーのパスやホスト側の名前を含みうる**。状態そのもの（止まっている / 失敗した）は
誰にでも出し、**理由だけ** `canEditServer` で絞る。

### 4. 定義から始める口を足す

`printer-start` は「**登録済みのもの**の待ち受けを始める」意味なので、
**一度も開いていない定義には効かない**。監視の `watch-start` と同じ役割の
`printer-service-start` を足す。

`openPrinter` は `ref` で既存に繋ぐので、**1 通で両方に効く**——
一度も開いていない定義は作って開始、停止中の常駐は既存を返すので開始し直す
（`autoStart: false` で開き、そのあと明示的に `startPrinter`）。

**サービス ✅ の定義だけ受ける**（`resolve` が `service` を立てるのはサーバー設定由来のときだけ）。
個人設定のプリンターをここから常駐化できない＝信頼境界 5 層目のまま。

### 5. 「未起動」と「停止中」を分ける

実体が無い（一度も上がっていない）ものを「停止中」と書くと、**誰かが止めたように読める**。
実体があるかどうか（`id` の有無）で語を分ける。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `config-types.ts` | `ServiceDef` |
| `config-store.ts` | `listServiceDefs` / `canSeeService`（サーバーは常に true） |
| `config-resolver.ts` | `listServiceDefs` |
| `host-printers.ts` | 定義の出所を `listServiceDefs` に。理由を `canEditServer` で絞る。`editable` を返す |
| `app.ts` | `canEditServer` を渡す |
| `ws-messages.ts` / `ws-handler.ts` | `printer-service-start` |
| `stores/services.ts`（新規） | REST 取得 ＋ 操作用 WS |
| `components/ServicesPane.vue`（新規） | 一覧 |
| `paneLabels.ts` / `WorkspaceNode.vue` / `LauncherPane.vue` | `svc:` の登録 |

## 振る舞いの詳細

```
名前          種別          状態        起動  実績              操作
PRTSVC        🖨 プリンター  未起動      手動  出力あり          [開始]
帳票サーバー  🖨 プリンター  待ち受け中  自動  帳票 12 件（保持 50）[停止]
受注監視      👁 待ち行列    エラー      自動  エントリ 3 件      [開始]
                            not authorized
```

| 状況 | 振る舞い |
|---|---|
| 実体が無い | `未起動`。開始は `printer-service-start` / `watch-start` |
| 実体があり `stopped` | `停止中`。開始は `printer-service-start` / `watch-resume` |
| 操作できない相手 | ボタンを出さない。理由の文面も出さない |
| 定義が 0 件 | 作り方を書いた案内を出す |

## エラー処理 / 異常系

- 操作が断られた（権限・設定不備）→ WS の `error` を画面上部に出す
- 一覧の取得に失敗 → 同じ場所に出す。前回の一覧は残す（消すと何も分からなくなる）

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 動いていない定義も出る | 方針 1・5 |
| 一度も開いていない定義も開始できる | 方針 4 |
| 一般ユーザーは見えるが操作できない | 方針 2・3 ＋ `editable` |
| 警告・理由が一般ユーザーに出ない | 方針 3 |
| ビルド・lint・全テスト | `npm run build`（`vue-tsc` 込み）/ `npm test` |
