/**
 * IBM i を見る機能の一覧（名前と一行説明）。
 *
 * ランチャー（`LauncherPane.vue`）のカードと、VSCode拡張の待機表示（`EmbedApp.vue`。
 * `20260924-vscode-extension` D19）で同じ文言を使うため、ここに1か所だけ置く
 * （写すと片方だけ直る。`paired-artifact-sync`）。
 */
/** ランチャーでは「このシステムの機能」としてヘッダーではなくここに並べる（セッションと同じ「タブを開く」操作だから） */
export const FEATURES = [
  { id: "list:jobs", name: "ジョブ", desc: "実行中・待機中のジョブを見る。保留・解放・終了もできる。" },
  { id: "list:objects", name: "オブジェクト", desc: "ライブラリー内のオブジェクトを一覧する。" },
  { id: "sql:query", name: "SQL", desc: "SELECT を実行して結果を見る。CSV でダウンロードできる。" },
  {
    id: "plan:explain",
    name: "実行計画",
    desc: "SQL の実行計画をグラフで見る。索引の助言も出る。一覧は特権が要る。"
  },
  {
    id: "transfer:data",
    name: "データ転送",
    desc: "表を CSV に落とす / CSV を表に取り込む。SQL を書かずに済む。"
  },
  {
    id: "msg:queue",
    name: "メッセージ",
    desc: "待ち行列を読む。**応答待ちの照会に答えられる**。送信もできる。"
  },
  {
    id: "pgm:call",
    name: "プログラム呼び出し",
    desc: "画面を経由せずに RPG / COBOL を呼ぶ。引数は型で書く。"
  },
  {
    id: "pcml:call",
    name: "PCML 呼び出し",
    desc: "コンパイラが吐いた `.pcml` から呼ぶ。**構造体と配列を名前で**扱える。"
  },
  {
    id: "cmd:prompt",
    name: "コマンド入力支援",
    desc: "CL コマンドの定義を引いて欄を並べる（実機の F4）。書き方を覚えていなくても打てる。"
  },
  { id: "list:users", name: "ユーザー", desc: "ユーザープロファイルと権限を一覧する。" },
  {
    id: "ifs:files",
    name: "IFS",
    desc: "IFS のフォルダを辿ってファイルを見る / 取り出す / 置く。"
  },
  {
    id: "dtaq:entries",
    name: "データ待ち行列",
    desc: "データ待ち行列にエントリを送受信・ピークする。作成・クリア・削除・属性も。"
  },
  {
    id: "spool:files",
    name: "スプール",
    // desc で push 型と区別する——プリンターセッションのタブと紛らわしいため
    desc: "出力待ち行列にある既存のスプールを検索して、中身を読む / PDF で保存する。"
  }
] as const;

/** 機能IDから一覧の項目を引く（無ければ undefined） */
export function featureOf(id: string): (typeof FEATURES)[number] | undefined {
  return FEATURES.find((f) => f.id === id);
}
