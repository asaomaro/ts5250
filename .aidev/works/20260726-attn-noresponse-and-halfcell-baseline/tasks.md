# タスク: Attn 窓の高さずれと、応答しない Attn で固まる問題

- [x] T1: `.half-cell` を `overflow: hidden` から `clip-path: inset(0)` へ（ベースラインを変えない）
- [x] T2: 実ブラウザで `.half-cell` と隣の文字のベースライン差が 0px であることを計測（依存: T1）
- [x] T3: core に `FLAG_KEY_TIMEOUT_MS = 5000` を置き、Attn / SysReq の既定待ちに使う（通常 AID は不変）
- [x] T4: `SessionState.notice` と `MSG_NO_RESPONSE` を足す
- [x] T5: `key-done` の `timedOut` で通知を立て、`sendKey` の先頭で消す（依存: T4）
- [x] T6: `EmulatorPane` がローカル通知と store 通知を束ねて `StatusBar` へ渡す（依存: T4）
- [x] T7: テスト — core の待ち時間／web-ui の通知表示と消去（依存: T3, T5, T6）
- [x] T8: 実機確認 — 2 回目の Attn で固まらない／窓の行がずれない（依存: T1〜T7）
