# レビュー記録: 01-foundation-telnet

## ラウンド 1（2026-08-15T09:10:19Z）

差分: 新規 `packages/tn3270/`（src 7 ファイル・test 4 ファイル・harness 2 ファイル）＋
既存 4 ファイルの小変更（`eslint.config.js` / `tsconfig.json` /
`packages/tn5250/test/dependency-direction.test.ts` / `scripts/README.md`）。

- [must] `src/telnet/telnet.ts` `handleOption` — **交渉の再応答でループしうる**。
  同じ `DO BINARY` が繰り返し届くと毎回 `WILL` を返していた。RFC 854 は「状態が変わらないなら
  応答してはならない」と定める（さもないと双方が肯定応答を返し続ける）。Hercules は各オプションを
  1 回しか送らないため実測では踏まなかったが、**踏んだときに黙ってループするのは最悪**。
  / 対応: **修正済**。応答済みの (方向, オプション) を `answered` に記録し 1 度だけ返すようにした。
  回帰テスト 2 件を追加（繰り返し DO / 知らないオプションの繰り返し拒否）。

- [should] `src/telnet/telnet.ts` `feed` — 初版は chunk が telnet 列の途中で切れると壊れる作りだった
  （`pendingIac` を立てるだけで消費していなかった）。**TCP はどこで切れるか分からず、
  分割されたときだけ壊れるのは再現しにくい**。
  / 対応: **修正済**。`pending` に持ち越す方式へ書き換え、
  「IAC だけ」「IAC DO だけ」「SB の SE 待ち」「レコード途中」の 4 パターンを回帰テストで固定した。

- [should] T10 の成果物の置き場を plan から変更した。`scripts/README.md` が
  「**ここは実機に当てるものだけ**」と明示しており、docker 環境の構築スクリプトは趣旨が違う。
  / 対応: `packages/tn3270/test/harness/testenv.sh` に置き、`scripts/README.md` からは参照のみ張った。
  tasks.md に変更理由を記録済。

- [nit] `eslint.config.js` の glob が `packages/core/src/**` を指したままで、
  `core → tn5250` の改名（`20260802-rename-ts5250`）に追随していなかった。
  `packages/core` は存在しないため **tn5250 に対する `node:*` 禁止ガードが効いていなかった**。
  皮肉にも同じ glob のすぐ上のコメントが「切り出すたびにガードが静かに外れる」と警告している。
  / 対応: **同じ変更の中で修正**（`core` → `tn5250`、ignores も同様）。
  違反は 0 件（`node:*` は `transport/tcp.ts` の 2 件のみで規約どおり）で、lint は緑のまま。
  **この work の範囲外の既存不具合**だが、まさに同じリストを編集するため同時に直した。

- [nit] `package.json` の `dependencies` から `@ts5250/ebcdic` を外した。
  依存方向テストが「宣言と実 import の**双方向一致**」を要求するため、
  まだ使っていない宣言は落ちる。**02 で実際に使うときに足す**。

### 検証

- `npm run build`（`tsc -b` ＋ web-ui の `vue-tsc`）: 緑
- `npm run lint`: 緑（**新たに tn5250 も対象に入った状態で**）
- 単体: tn3270 16 件（＋E2E 2 件は既定スキップ）
- E2E（`TN3270_E2E=1`・TK4- 実接続）: 18 件すべて緑
- **空振り検査**: E2E を存在しないポートに向けると 2 件とも落ちることを確認済み
  （実際にネットワーク経路を通っており、無条件に緑になっていない）
- 他パッケージへの影響なし: base 48 / ebcdic 83 / scs 25 / hostserver 872 /
  tn5250 451 / server 1176 / web-ui 1647 いずれも緑

### 未対応（後段へ送る）

- `DONT` / `WONT` を受けたときの合意取り下げは実装していない（3270 では実質来ない）。
  必要になったら 02 以降で足す。
