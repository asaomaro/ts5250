# 要件: Windows 実機でテスト一式を緑にする

## 背景

`20260823-pccmd-windows-verify` で PC コマンドの回帰を Windows で自動化したとき、
**`packages/server` が 11 件赤いまま**であることが分かり、
`.aidev/backlog/windows-test-run.md` に原因つきで起票した。

赤いまま放置すると、**Windows で回した人が「元から落ちている」と流すようになり、
本当の退行が混ざっても気づけない**。Windows は「配布形（Electron 版）が実際に通る
OS 固有経路」（`cmd.exe` 経由のコマンド実行・印刷・PDF フォント探索）を持つので、
ここが読めないのは高くつく。

## 目的

**Windows 実機で `npm test` / `npm run lint` / `npm run build` を緑にする。**
ただし**製品の振る舞いは変えない**——落ちているのはテスト側の前提だと
起票時に確認しているので、それを直す。

## 完了条件

- [ ] 全 workspace のテストが Windows で緑（skip は理由が説明できるものだけ）
- [ ] `npm run lint` ・ `npm run build`（web-ui の vue-tsc 込み）が緑
- [ ] **Linux 側を壊していない**（判定の追加は `skipIf` で、既存の経路は触らない）
- [ ] skip にしたものは**何が確かめられていないか**が読めば分かる
- [ ] backlog の 11 件が根拠つきで閉じ、**新たに見つかったものも記録される**

## 非目標

- Windows を CI に載せること（backlog に残す）
- 製品コードの変更（`.gitattributes` は**チェックアウトの宣言**で製品の振る舞いではない）
