# 仕様: 何も無い状態からサービス開始までを通しで確かめる

## 検証の作り

**空のディレクトリでサーバーを起動する**——`.env` も `profiles.json` も無い状態を作るため。
引数は `start.sh` と同じ（`--auto-secret-key` ＋ `--web-root`、`--profiles` なし）。

実機の接続先だけは呼び出し側の環境変数から渡す（サーバーの作業ディレクトリには置かない）。

## 通しで詰まった箇所（＝この作業の修正）

### 立ち上げに失敗しても実体が残らない

`reconcileService` は `openPrinter({ ...opts, autoStart: true })` で**登録と開始を一度に**やっていた。
`openPrinter` は開始に失敗すると投げ、**エントリを残さない**。

結果、繋がらなかったとき（装置が使用中・TLS の設定違い・ホスト不達）に

- 一覧には定義が「**未起動**」とだけ出る
- 理由は**サーバーログにしか無い**

「設定したのに動かない」が画面から追えない——この機能で一番困る壊れ方である。

**登録してから開始する**形に直した（`printer-service-start` が既に採っている順序）:

```ts
const created = await deps.sessions.openPrinter({ ...openOpts, autoStart: false });
if (!t.autoStart) return { started: false };
await deps.sessions.startPrinter(created.id);  // 失敗しても `error` 状態が実体に残る
```

`startPrinter` は失敗時に `setPrinterState(entry, "error", 理由)` を立ててから投げるので、
**一覧に `error` と理由が出る**（理由は操作できる相手にだけ。`20260801-services-pane`）。

反映そのものは従来どおり投げない（保存を巻き添えにしない）。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 端から端まで通る | `verify-fresh-service-setup.mjs`（14 項目） |
| 失敗の理由が画面から追える | 上の修正 ＋ 単体テスト |
