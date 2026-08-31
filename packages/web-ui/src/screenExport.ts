/**
 * 今の画面を自己完結 HTML に落として保存する（エミュレータ画面の「HTML」ボタン）。
 *
 * **サーバーへ往復しない。** スナップショットは既にブラウザ側にあるので、
 * core の `renderScreenHtml` をその場で呼べば済む（スプールと違い取り直しが要らない）。
 *
 * ## 見え方は**焼き込まず、切り替えられる形で渡す**
 *
 * 画面には web-ui の表示設定が効いている（表示コードの再解釈・SO/SI マーク）。素のまま
 * 書き出すと、画面には `F3=exit` と出ているのに HTML は `F3=ｵﾒｹﾎ` になる——カナ系ホスト
 * （930/5026）を「英」で見ているときに実際に起こる。
 *
 * かつてはここでセルを写し替えて**焼き込んで**いたが、いまは `renderScreenHtml` が
 * **両方の読みを HTML に入れ、ページ内の CSS トグルで差し替える**。SO/SI も同じで、
 * 印は向こうが置き、非表示 → 薄目 → 濃目 を読み手が選べる。
 *
 * だからここから渡すのは**開いたときの状態**だけ——画面と同じ見え方で開くための初期値である。
 * ホストの CCSID を知っているのはこちらだけなので、「そのまま描いた字がどちらの読みか」
 * （`sbcs.host`）も併せて渡す。
 *
 * 渡すのは**表示に関わる分だけ**。配色（literal/semantic）と質感（CRT/flat）は持ち込まない
 * ——`renderScreenHtml` は自前の見た目を持っており、そこまで二重管理にすると
 * 「画面設定を変えたらエビデンスの色も変わる」ことになって証拠として読みにくい。
 */
import { renderScreenHtml, type SbcsReading } from "@ts5250/tn5250/browser";
import { sessionsStore } from "./stores/sessions.js";
import { viewSettings, resolveSbcsView } from "./stores/viewSettings.js";
import { isKatakanaCcsid } from "./hostCodePages.js";

/** ファイル名に使えない文字を落とす（`host-spools.ts` の `safeFileName` と同じ考え方） */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "screen";
}

/**
 * ファイル名に入れる時刻。**ブラウザのローカル時刻**で作る。
 *
 * 以前は `toISOString()`＝UTC だった。日本から保存すると 9 時間ずれた名前が付き、
 * **いつ撮った画面かを名前で追えない**——保存した HTML を並べて突き合わせる使い方なので、
 * ここがずれると効かない。
 *
 * 形は `YYYY-MM-DDTHH-MM-SS` のまま保つ。**ロケール書式（`toLocaleString`）は使わない**
 * ——`/` や `:` はファイル名に使えない環境があり、桁揃えもロケール次第で崩れて
 * **名前順が時刻順にならなくなる**。合わせるのは時刻の値であって書式ではない。
 *
 * 中身の `capturedAt` は UTC（`Z` 付き）のまま。あちらは機械が読む事実なので、
 * オフセットが明示された形のほうがよい。
 */
function localStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
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
  const hostIsKatakana = isKatakanaCcsid(s.ccsid);
  // ホストが返した字そのものがどちらの読みか。`resolveSbcsView` の `host` はこれを指す
  const hostReading: SbcsReading = hostIsKatakana ? "kana" : "latin";
  const sbcsView = resolveSbcsView(view.kana, hostIsKatakana);

  const host = s.meta?.host;
  const html = renderScreenHtml(s.snapshot, {
    capturedAt: now.toISOString(),
    sessionId,
    title: `${s.label} — 5250 画面`,
    ...(host ? { host } : {}),
    ...(jobLabel(s.job) ? { job: jobLabel(s.job)! } : {}),
    // 見え方はどれもページ内で切り替えられるので、注記には残さない
    // ——「この HTML はこう見えている」を固定する意味が無くなった
  }, {
    shiftMarks: view.sosi,
    sbcs: { host: hostReading, initial: sbcsView === "host" ? hostReading : sbcsView },
    // 画面と同じ字で開く。**候補に無い名前なら標準へ落ちる**（環境で選んだフォントは
    // 読み手の機械に無いことがあるので、配布 HTML は自前の候補しか指名しない）
    font: view.font
  });

  const stamp = localStamp(now);
  const name = `${safeFileName(s.label)}-${stamp}.html`;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}
