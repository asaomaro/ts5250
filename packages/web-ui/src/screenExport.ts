/**
 * 今の画面を自己完結 HTML に落として保存する（エミュレータ画面の「HTML」ボタン）。
 *
 * **サーバーへ往復しない。** スナップショットは既にブラウザ側にあるので、
 * core の `renderScreenHtml` をその場で呼べば済む（スプールと違い取り直しが要らない）。
 *
 * ## 「表示している内容」を出す
 *
 * `renderScreenHtml` はホストのスナップショットをそのまま描くが、**画面には web-ui の
 * 表示設定が効いている**（表示コードの再解釈・SO/SI マーク）。素のまま書き出すと、
 * 画面には `F3=exit` と出ているのに HTML は `F3=ｵﾒｹﾎ` になる——カナ系ホスト（930/5026）を
 * 「英」で見ているときに実際に起こる。so、描く前にセルを表示設定で写し替える。
 *
 * **SO/SI マークはここでは触らない。** `renderScreenHtml` が SO/SI 桁を見て自分で `{ }` を
 * 置き、**ページ内のトグル（CSS だけ）で出し入れできる**ようにしている。こちらから渡すのは
 * 「開いたときに出ているか」（`shiftMarks`）だけ——画面と同じ状態で開くための初期値である。
 *
 * 写し替えは**表示に関わる分だけ**。配色（literal/semantic）と質感（CRT/flat）は持ち込まない
 * ——`renderScreenHtml` は自前の見た目を持っており、そこまで二重管理にすると
 * 「画面設定を変えたらエビデンスの色も変わる」ことになって証拠として読みにくい。
 */
import type { Cell, ScreenSnapshot } from "@ts5250/tn5250";
import { renderScreenHtml } from "@ts5250/tn5250/browser";
// 表示コード切替は狭い入口から（`ScreenGrid.vue` の同じ注記を参照）
import { katakanaChar, latinChar } from "@ts5250/ebcdic/katakana";
import { sessionsStore } from "./stores/sessions.js";
import { viewSettings, resolveSbcsView, type SbcsView } from "./stores/viewSettings.js";
import { isKatakanaCcsid } from "./hostCodePages.js";

/**
 * 表示コードの再解釈をスナップショットに焼き込む。**判定は ScreenGrid の `displayChar` と
 * 同じ**（非表示桁は触らない → 生バイトを対の表で読み直す）。ここがずれると
 * 「画面と書き出した HTML で字が違う」になる。
 */
function applyView(snap: ScreenSnapshot, sbcsView: SbcsView): ScreenSnapshot {
  if (sbcsView === "host") return snap; // 触る必要が無い
  const recode = (b: number): string => (sbcsView === "kana" ? katakanaChar(b) : latinChar(b));
  const cells = snap.cells.map((row) =>
    row.map((c: Cell) => {
      if (c.nonDisplay) return c; // 非表示桁は renderScreenHtml が伏せる
      // 読み直せるのは生バイトを持つ SBCS だけ（DBCS・属性桁・オーダー由来は元が無い）
      if (c.kind === "sbcs" && c.rawByte !== undefined) {
        return { ...c, char: recode(c.rawByte) };
      }
      return c;
    })
  );
  return { ...snap, cells };
}

/** ファイル名に使えない文字を落とす（`host-spools.ts` の `safeFileName` と同じ考え方） */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "screen";
}

/** ジョブ識別子の表示形（`番号/ユーザー/ジョブ名`。引けていなければ装置名だけ） */
function jobLabel(job: { name: string; user?: string; number?: string } | undefined): string | undefined {
  if (!job) return undefined;
  return job.number ? `${job.number}/${job.user}/${job.name}` : job.name;
}

/**
 * 今の画面を HTML にして保存する。スナップショットがまだ無ければ何もしない。
 *
 * @returns 保存したファイル名。何もしなかったときは undefined
 */
export function downloadScreenHtml(sessionId: string, now = new Date()): string | undefined {
  const s = sessionsStore.get(sessionId);
  if (!s?.snapshot) return undefined;

  const view = viewSettings.effective(sessionId);
  const sbcsView = resolveSbcsView(view.kana, isKatakanaCcsid(s.ccsid));
  const snap = applyView(s.snapshot, sbcsView);

  const host = s.meta?.host;
  const html = renderScreenHtml(snap, {
    capturedAt: now.toISOString(),
    sessionId,
    title: `${s.label} — 5250 画面`,
    ...(host ? { host } : {}),
    ...(jobLabel(s.job) ? { job: jobLabel(s.job)! } : {}),
    // 素のスナップショットと違う見え方で出したときは、その旨を残す（後から読む人のため）。
    // SO/SI はページ内で切り替えられるので、注記に残すのは表示コードだけ
    ...(sbcsView !== "host"
      ? { note: `表示設定を反映: 表示コード=${sbcsView === "kana" ? "カナ" : "英"}` }
      : {})
  }, { shiftMarks: view.sosi !== "none" });

  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `${safeFileName(s.label)}-${stamp}.html`;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}
