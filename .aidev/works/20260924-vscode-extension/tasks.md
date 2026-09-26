# タスク: VSCode拡張機能によるts5250画面のWebView表示（親・メタタスク）

## 実装方針

architecture.md の8項目を、producer→consumer の依存連鎖に沿って4つのsubtaskへ分割する。
親work自体はコードを書かない（subtask分割時の親の役割はrequirements〜tasksの上流工程と、
全subtask完了後の統合test・統合review・deliverに限られる。`protocol-subtask.md`）。

## 作業順序と依存関係

- `01-embed-ui`が最初（他への依存が無く、ブラウザ単体で目視確認できる＝最も不確実性が低い
  部分を先に固める）
- `02-extension-core`は`01-embed-ui`が提供する`embed.html`のURL/クエリ/メッセージ契約
  （architecture.md「メッセージプロトコル」）を消費する。ここが完了すると**エミュレータ**が
  エンドツーエンドで動く（`WsOpen`直接接続。design.md「設計方針3」訂正後）
- `03-sql-ifs`と`04-packaging`はどちらも`02-extension-core`に依存するが、互いには依存しない
  （並行して進められる）。**`03-sql-ifs`はフォルダ名に反しプリンター/スプール表示も担当する**
  ——design.md「設計方針3」訂正のとおり、プリンター/スプール表示もSQL/IFSと同じ
  system参照必須の経路（`own:<id>`登録）を通るため（`decisions.md` D3）
- 下の「依存」欄に従う（重複説明はしない）

## リスク / 留意点

- ロックファイル調停プロトコル（`02-extension-core`）は自前実装かつ他プロセスとの
  レースを含むため、`02`のtest工程で複数ウィンドウを模したシナリオ（同一globalStorageへの
  2プロセス同時acquire等）を明示的に確認する
- SQL/IFSの二重persist（`03-sql-ifs`）は`connections.json`への書き込みを伴う。test工程で
  「`.ts5250`の`passwordEnc`を書き換えたら`connections.json`側も追随するか」を確認する
- 実機接続確認（AC3）は`02-extension-core`のtest工程で`.env.verify`の検証環境に対して行う

## テスト方針

- 各subtaskのtest工程は**単独検証可能な範囲**（unit・契約モック）に限定する
  （`protocol-subtask.md`）
- 結合検証（拡張機能を実際にVSCodeへ読み込んでの動作確認・4subtask全体の統合動作）は
  **親の統合testに集約する**

## タスク

- [ ] T1: `01-embed-ui`サブタスクを作成し完了させる（embed.html/embed.ts/EmbedApp.vue/
      SettingsForm.vue。ブラウザ単体で`http://host:port/embed.html?app=...`を目視確認できる状態）
      対象: `works/20260924-vscode-extension/01-embed-ui/`（別tasks.mdで分解）
      依存: なし
      AC: AC1, AC2, AC-I2, AC-I3, AC-I4, AC-I5
- [ ] T2: `02-extension-core`サブタスクを作成し完了させる（vscode-extension骨格・
      ServiceManager・ExtensionSecretCrypto・Ts5250EditorProvider・shell HTML・
      メッセージプロトコル結線。**エミュレータ**（`WsOpen`直接接続）がエンドツーエンドで動く状態）
      対象: `works/20260924-vscode-extension/02-extension-core/`（別tasks.mdで分解）
      依存: T1
      AC: AC1, AC3, AC4, AC5, AC6, AC7, AC9, AC-I1, AC-I2
- [ ] T3: `03-sql-ifs`サブタスクを作成し完了させる（own:<id>登録・POST/PUT /api/systems
      連携。**プリンター/スプール表示・SQL・IFS**が動く状態。フォルダ名は`sql-ifs`だが
      プリンター/スプール表示も同じsystem参照必須の経路のためここで扱う。`decisions.md` D3）
      対象: `works/20260924-vscode-extension/03-sql-ifs/`（別tasks.mdで分解）
      依存: T2
      AC: AC1, AC8
- [ ] T4: `04-packaging`サブタスクを作成し完了させる（prepare-server.mjs・.vscodeignore・
      vsce package。.vsixが実際に入れる状態）
      対象: `works/20260924-vscode-extension/04-packaging/`（別tasks.mdで分解）
      依存: T2
      AC: なし
