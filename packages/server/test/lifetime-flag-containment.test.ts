import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { code } from "../../web-ui/test/source-scan.js";

/**
 * **セッション寿命の判定が散らばらないことを固定する**
 * （`20260908-session-lifetime-rules-fold` AC2）。
 *
 * 前身の `20260908-session-survives-disconnect` では、4 つの規則を独立フラグの暗黙の連言として
 * 書いた結果、1 つの規則を答える判定が 12〜15 か所へ散った。review が 3 ラウンド続けて
 * 「直した項の隣が壊れる」を出した原因で、原因究明（同 work のデバッグ D1）の診断は
 * **個別の欠陥ではなく規則の置き場所**だった。
 *
 * **畳んだ直後だけ整っていても意味が無い**——次の変更で同じ状態に戻るなら投資が消える。
 * ここが CI で落ちることが、規則を 1 か所に保つ唯一の強制力になる
 * （`packages/server` は eslint の対象内だが、走査テストなら**クライアント側と同じ形**で
 * 書けるので、両側でこの形に揃えてある。web-ui は eslint の対象外）。
 *
 * 雛形は `log-independence.test.ts`——「各ファイルが実際にどちらを import しているか」を
 * 走査で固定する、同じ性質の不変条件。
 */
const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** `src` の全 `.ts` を（ファイル名, 中身）で返す */
function sources(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      // 区切りを `/` に寄せる（クライアント側の対と同じ。サブディレクトリを足したとき
      // Windows で `inside` の突き合わせが緩む側にずれるのを防ぐ）
      else if (e.name.endsWith(".ts"))
        out.push({ name: relative(srcDir, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8") });
    }
  };
  walk(srcDir);
  return out;
}


describe("セッション寿命の判定は 1 か所に閉じている", () => {
  /**
   * **畳んで消えたフラグ。** 復活したら、それは union の外に状態を持ち出したということ
   * ——`holder` / `hold` が「唯一の真実」でなくなる。
   */
  it("旧フラグ（holderToken / hadHolder / heldUntil）は src のどこにも無い", () => {
    const gone = ["holderToken", "hadHolder", "heldUntil"];
    const offenders = sources().flatMap(({ name, text }) =>
      gone.filter((flag) => new RegExp(`\\b${flag}\\b`).test(code(text))).map((flag) => `${name}: ${flag}`)
    );
    expect(offenders).toEqual([]);
  });

  /**
   * **`holdTimer` は「畳んで消えたもの」ではなく「畳んだ先に残るもの」。**
   *
   * design「AC2 の詳細」は 4 つとも「0 件」で縛ると書いているが、これだけは**タイマーの実体**
   * なので `HoldState`（`until` を持つ純粋な値）には入らない。`hold` が「猶予中か」を答え、
   * `holdTimer` はその猶予を実際に畳む口——**別のものなので消えない**。
   * だから 0 件ではなく**在ってよい場所を固定する**（`decisions.md` D18。`settled` の D15 と同じ扱い）。
   */
  it("holdTimer を触るのは session-manager.ts だけ", () => {
    const offenders = sources()
      .filter(({ name }) => name !== "session-manager.ts")
      .flatMap(({ name, text }) => (/\bholdTimer\b/.test(code(text)) ? [name] : []));
    expect(offenders).toEqual([]);
  });

  /**
   * **判定に使う状態は `session-manager.ts` の外に出さない。**
   *
   * `holder` / `hold` はエントリが持つ定義そのもの、`viewers` / `resident` は
   * それと組で読まれる。呼び出し側（`ws-handler` など）がこれらを直接読むと、
   * **`disposition()` を通さない 2 本目の判定**が生まれる——それが前身の失敗そのもの。
   */
  it("状態の欄（holder / hold / resident）は定義と規則の外で読まれない", () => {
    // **内側は 3 つ**——状態を持つ `session-manager.ts` と、それを引数で受けて答える
    // `session-lifetime.ts`（規則の定義そのもの）・`associated-printer.ts`（関連付けたプリンターを止めるか閉じるかの判断。
    // `20260921-associated-printer-session`）。design「AC2 の詳細」は `session-manager.ts`
    // だけを挙げるが、規則を別ファイルに切り出したのは architecture A1 の決定で、
    // そこが「このファイル以外に出ない」で素直に書けることを裏づけにしている。
    // `associated-printer.ts` は**エントリを持たず**、`session-manager.ts` が詰めた引数（`AssociatedPrinterState`）だけを読む純関数で、
    // `session-lifetime.ts` と同じ位置づけ——寿命の判定そのものではなく、表示に連動するプリンターの停止・破棄の判断（常駐は触らない）。
    const inside = new Set(["session-manager.ts", "session-lifetime.ts", "associated-printer.ts"]);
    // **`viewers` は対象外**（`decisions.md` D14）——`session-routes.ts` が管理画面向けの
    // 応答に載せており、それは寿命の判定ではなく報告。数えるのは**判定に使う状態**だけ。
    //
    // **分割代入は素通りする**（`const { hold } = e` は `.hold` を作らない）。ドットで
    // 固定しているサーバー側 3 本だけの限界で、クライアントの対（`\bsettled\b` など）は捕まえる。
    // ここでドットを外すと `SessionReservation.holder`（予約者の表示名）まで拾うので外せない。
    const fields = [/\.holder\b/, /\.hold\b/, /\.resident\b/];
    const offenders = sources()
      .filter(({ name }) => !inside.has(name))
      .flatMap(({ name, text }) => fields.filter((re) => re.test(code(text))).map((re) => `${name}: ${re.source}`));
    expect(offenders).toEqual([]);
  });

  /**
   * **`ws-handler` は「見に来ただけか」を自分で持たない。**
   * 役割は `link.role`（`ConnRole`）が持ち、処分は `disposition()` が答える。
   */
  it("ws-handler.ts に attached という状態は無い", () => {
    const wsHandler = sources().find((s) => s.name === "ws-handler.ts");
    expect(wsHandler, "ws-handler.ts が見つからない").toBeDefined();
    // 他の 4 本と同じ「違反の一覧」の形にする——真偽だけだと失敗時に場所が出ない
    const offenders = /\battached\b/.test(code(wsHandler!.text)) ? ["ws-handler.ts: attached"] : [];
    expect(offenders).toEqual([]);
  });

  /**
   * **後始末の判断を呼ぶのは接続を畳む場所だけ。** 別のファイルが呼び始めたら、
   * それは「別の場所でも寿命を決めている」ということ。
   *
   * **件数は数えない**（design「AC2 の詳細」）——正当な後始末経路が 1 つ増えただけで落ち、
   * 数字を上げるだけの作業になる。固定するのは「このファイル以外に出ない」ほう。
   */
  it("disposition() を呼ぶのは ws-handler.ts だけ", () => {
    const offenders = sources()
      .filter(({ name }) => name !== "ws-handler.ts")
      .flatMap(({ name, text }) => (/\.disposition\(/.test(code(text)) ? [name] : []));
    expect(offenders).toEqual([]);
  });
});
