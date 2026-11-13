# VSCode 拡張機能への Node.js 同梱

2026-11-13。Node.js 26.13.1 の公式バイナリーを OS/CPU 別 VSIX に同梱する。
対応は win32-x64 / win32-arm64 / darwin-x64 / darwin-arm64 / linux-x64 / linux-arm64。
Node.js 自体の OS/libc 動作条件は引き続き必要。起動時ダウンロードと利用者の PATH 上の Node は不要。

## 実装と配布

- `scripts/prepare-runtime.mjs` は公式 `v26.13.1/SHASUMS256.txt` から確認した固定 SHA-256 で取得物とキャッシュを検証する
- 公式アーカイブから実行ファイルと LICENSE だけを取り出し、`server-stage/runtime/` へ置く。入力中のパスを展開先には使わない
- `scripts/package.mjs` が同じターゲットで同梱物と VSIX のプラットフォーム指定を作り、生成後に `verify-package.mjs` で内容を照合する
- 配布版の `resolveNodePath` は同梱実行ファイルの絶対パスを返す。外部 Node は `ts5250.nodePath` に明示した場合だけ使う
- 同梱 Node の更新でも古いサーバーを再利用しないよう、既存の buildId に runtime.json を含める
- キャッシュ・ステージ・VSIX は Git に入れない。実行ファイルのライセンスは各 VSIX に含める

## ローカル検証

- 全6種類の実 VSIX を作成し、対象 OS/CPU・実行ファイルの SHA-256・LICENSE・VSIX の TargetPlatform 一致を確認
- Unix 向け VSIX の実行ファイルに実行権限が保存されていること、キャッシュのアーカイブが入らないことも ZIP メタデータから確認
- Linux x64 の実 VSIX を別ディレクトリへ展開し、PATH を空の一時ディレクトリへ向けて ServiceManager から同梱 Node だけで起動。`/proc/<pid>/exe` で実際の子の実行ファイルも同梱パスと一致すると確認
- 上記サーバーで `/healthz` と `/embed.html` が 200。IBM i へは接続しない。終了時に子プロセスと一時データを片付ける
- 拡張機能の全16ファイル・187件、build、typecheck、root lint/build が成功
- 回帰注入：チェックサム一致判定を反転すると配布物テストが失敗。配布版/開発版の Node 選択を反転すると選択・起動設定テストが失敗。復元後にビルド・型検査と実 VSIX の起動を再確認

CI では Ubuntu / Windows / macOS で各ホスト向けの VSIX を生成し、同梱 Node による PATH 非依存の起動・画面配信を行う。
ARM64 の異なる OS の実機、VSCode GUI からのインストール操作、IBM i 接続はローカルでは未確認。アーカイブの整合性・形式検証を、その OS での実行確認の代わりには扱わない。
