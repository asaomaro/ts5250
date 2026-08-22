# 計画: `@ts5250/vt`

## 分割の判断

**subtask 層は使わない。** 1 PR に収まる粒度で、層ごとに順に積める（下から作れば
上は常に動く土台の上に乗る）。tn3270 のときと同じ構成。

## 順序（下から積む）

| # | 内容 | 依存 |
|---|---|---|
| 1 | `device-env` を `@ts5250/base` へ移し、`tn5250` / `tn3270` を切り替える（D2） | — |
| 2 | パッケージの骨（`package.json` / `tsconfig` / 依存方向テスト） | 1 |
| 3 | `text/codec.ts` — 復号・符号化（D8） | 2 |
| 4 | `protocol/parser.ts` — DEC ANSI 状態機械（D3） | 2 |
| 5 | `screen/buffer.ts` — セル格子・スクロールバック・代替画面（D4/D6/D7） | 2 |
| 6 | `screen/terminal.ts` — 命令の実行（CSI/ESC/SGR/モード。D5/D10） | 4,5 |
| 7 | `input/keys.ts` — 打鍵の符号化（D9） | 2 |
| 8 | `telnet/` — 交渉（D11） | 2 |
| 9 | `transport/` ＋ `session/` — 繋いで回す（D12） | 6,7,8 |
| 10 | `trace/` — 記録と再生（D13） | 9 |
| 11 | 実機検証スクリプト（Linux / pub400） | 9 |

各段で単体テストを書き、緑にしてから次へ進む。

## 検証環境

- **Linux**: `docker run -d --name ts5250-vt -p 2331:23 ts5250-vt-telnetd`
  （`scripts/vt-telnetd/Dockerfile` としてリポジトリに置く）
- **IBM i**: pub400（**実機は VT を出せない**。research 1.2）

## リスク

- **実機で IBM i 側の実機確認ができない**。pub400 1 台になる。
  3270 で「1 台で一般化して間違えた」ので、**IBM i 固有の結論は pub400 限定と明記する**。
- **pub400 の QMAXSIGN は 5、実機は 3**。サインオン失敗の試行を重ねない。
- 手を入れる既存パッケージは **`base` / `tn5250` / `tn3270`（device-env の移動のみ）**。
  最初の独立コミットにして切り離せるようにする。
