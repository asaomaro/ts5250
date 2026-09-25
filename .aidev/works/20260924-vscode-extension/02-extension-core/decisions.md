# 決定記録

## D1: ウィンドウ内の複数パネルに対する参照カウントが architecture.md に欠けていた

- **背景**: `ServiceManager`（T7）の`windows`（ロックファイル）は**ウィンドウ単位**
  （`windowId`ごとに1エントリ）で参照を数える。一方、1つのVSCodeウィンドウで
  `.ts5250`パネルを複数開く（例: emulatorタブを3つ）ケースを考えると、各パネルが
  素朴に`acquire()`/`release()`を直接呼ぶと、**2つ目のパネルの`acquire()`は
  既存の`windows[windowId]`のタイムスタンプを更新するだけ**（新しいエントリには
  ならない）ため、**1つ目のパネルが`release()`すると即座に`windowId`のエントリが
  消え、2つ目のパネルがまだ使っているのにサーバーが停止してしまう**。
  architecture.md「ロックファイルの状態遷移」はウィンドウ間の調停だけを設計しており、
  同一ウィンドウ内の複数パネルという次元を見落としていた（T9実装中に発覚）。
- **決定**: `ServiceManager`はそのまま（ウィンドウ単位の調停に専念させる）。
  **`extension.ts`（T10）がウィンドウ内のローカルなパネル数カウンタを持ち**、
  0→1でだけ`ServiceManager.acquire()`を、1→0でだけ`release()`を呼ぶ
  ラッパー関数を`Ts5250EditorProvider`（T9）へ渡す。`Ts5250EditorProvider`自身は
  「acquire/releaseの1組の関数」を受け取るだけで、ローカル参照カウントの存在を
  知らなくてよい（依存注入で関心を分離する）。
- **理由・代替案**: 代替案として`ServiceManager`自体にパネル単位のネストしたカウントを
  持たせることも検討したが、`ServiceManager`の責務（ロックファイル＝プロセス間で
  共有される状態）に、**プロセス内でしか意味を持たないローカルな数**を混ぜることになり
  責務が曖昧になる。ローカルカウントは`extension.ts`のメモリ上の変数で足り、
  永続化する理由が無い
- **影響**: `Ts5250EditorProvider`のコンストラクタ引数を`ServiceManager`の直接注入ではなく
  `{ acquireService, releaseService }`の関数ペアに変更する。architecture.md
  「コンポーネント/モジュール」表の`ts5250EditorProvider.ts`の依存欄（`ServiceManager`）は
  この訂正を踏まえて読む（直接依存ではなく、`extension.ts`経由の間接依存になる）
