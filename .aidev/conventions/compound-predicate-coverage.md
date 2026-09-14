---
convention: compound-predicate-coverage
status: pending
introduced: 2026-09-13T23:10:58Z
source: .aidev/works/20260910-session-closed-ladder-interrupt/retro.md
scope: 新しい真偽値の合成述語(||・&&で2つ以上の判定を組み合わせる関数)を追加、または既存の合成述語に項を足す変更を含むタスクがあるwork
hypothesis: この条項の索引後に着手した work で、cross点検（またはタスク点検）が『新設・変更した合成述語(||/&&)の項に対応する単独テストが無い』を指摘する件数が、次の5 worksで0件になる
baseline: 直近2works連続でcross点検のみが同じ形の欠落を検出: (1) 20260910-session-reconnect-freezeのacceptsFrame第1項([should][conv:paired-artifact-sync]、タスク点検・design doc-checkを素通り)、(2) 20260910-session-closed-ladder-interruptのacceptsLifetimeSignal第1項([must][conv:-]、同じくタスク点検T2を素通り)。どちらも「片項に縮めても既存回帰が全数緑」という同じ実測で発覚し、severityはshould→mustに悪化した
verify_after: 5
---

# compound-predicate-coverage

<!-- 条項の本文。PJ ドキュメントへ移送(promote)するまではここが唯一の在処。 -->

## 規約

**新しい合成述語（`||`・`&&` で2つ以上の判定を組み合わせる真偽関数）を書いたら、各項を単独で
通す／落とすテスト（真理値表の各行のうち、少なくとも「その項だけが効いている行」）を、
その述語を追加・変更するタスク自身の中で書く。** cross 点検や独立レビュー任せにしない。

1. **述語のどの項を1つ欠かせても、書いたテストのどれかが赤くなること**を実装と同じタスクで
   確かめる。「片項に縮めても既存回帰が全部緑のまま」という状態を残さない。
2. **既存の合成述語に項を足す変更でも同じ**——足した項に対応するテストを足す。既存のテストが
   その項を通っていないなら、新しい項のテストを書く責任は足した側にある。
3. タスク単位の点検・design の doc-check だけでは見つからない実績がある（本条項の baseline の
   2 件とも、そこを素通りして cross 点検まで届いた）。cross 点検は最後の防波堤であって
   最初の検出手段にしないこと。

**なぜ条項にするか**: 2 works 連続で同じ形の欠落が起き、重大度も should → must へ悪化した。
片方は既存条項 `paired-artifact-sync`（対になる資産の複製）にタグ付けされたが、対象が違う
（複製ではなく、単一の合成述語の項の被覆漏れ）ため、もう片方は `[conv:-]` になった——
既存条項のどれにも収まらない独自の穴。

**判定**: `review.md` / タスク点検ログの、新設・変更した合成述語の項カバレッジ欠落に関する
`must`/`should` 指摘件数（cross 点検で見つかったものを含む）。

## 背景

`.aidev/works/20260910-session-closed-ladder-interrupt/retro.md` から起票。前 work
`20260910-session-reconnect-freeze` の cross 点検が `acceptsFrame` の第1項
（`isCurrentAttempt`）に対応する単独テストが無いことを見つけ（`[should][conv:paired-artifact-sync]`）、
本 work の cross 点検が新設した `acceptsLifetimeSignal` の第1項で**まったく同じ形**の欠落を
見つけた（`[must][conv:-]`）。両者とも「片項に縮めても全回帰が緑のまま」という同じ実測。

`.aidev/config.yml` に `docsRoots` が未設定のため、既存 PJ ドキュメントとの重複は
機械的に確認していない（`protocol-conventions.md`）。
