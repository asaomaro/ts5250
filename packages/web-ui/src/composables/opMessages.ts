import type { ErrorCode } from "@ts5250/base";
import type { RejectReason } from "./fieldValidate.js";

/**
 * 操作員メッセージ（クライアント側で出すもの。ホストの `systemMessage` とは別枠）。
 *
 * **日本語で出す。** 元にした ACS の操作員メッセージは英語だが、利用者は日本語の実機
 * （実機）を日本語 UI で使っており、ホスト由来のメッセージ（「機能キーは使用できません。」等）
 * だけが日本語で、こちら発のメッセージだけ英語だと出所の違いが読み手の混乱になる。
 * 対応する ACS 原文は各定数の脇に残す（挙動を突き合わせるときの手がかり）。
 * 文体は `MSG_NO_RESPONSE` に合わせ、です・ます調・句点なしで揃える。
 *
 * ~~**ACS とあえて揃えていない点**: ACS はメッセージがクリアされるまで文字入力を
 * 受け付けないが、本実装は受け付ける（不便なためユーザー判断）。クリア契機も
 * ACS の「ホスト通信 or カーソルキー移動」ではなく任意のキー操作とする。~~
 * → **ACS に揃えた**（利用者の判断・2026-09-21。`20260921-operator-error-mode`）。操作員エラー
 * （`isOperatorError`）では文字・Backspace・Delete を拒否し、カーソル移動・AID・Reset・クリックで
 * 抜ける（実機で測った規則）。情報の通知だけは従来どおり次のキーで消える。
 *
 * ScreenGrid（欄内）と EmulatorPane（欄外＝保護領域）の両方から使うため、
 * 定数はここに 1 か所だけ置く。**新しい操作員メッセージもここへ足す**——
 * 散らばると翻訳・文体の揃えを取りこぼす。
 */
/** ACS: "Cursor in protected area of display." */
export const MSG_PROTECTED = "カーソルが保護された区域にあるため入力できません";

/** オプション欄の選択肢（画面の凡例から作る一覧）のラベル */
export const MSG_OPT_HINTS = "オプションの選択肢";

/**
 * `EDTMSK` で分割された日付欄・時刻欄に出す選択部品のラベル。
 *
 * **どの区間が年・月・日かは画面に書かれていない**（ホストは分解の形しか送らない）ので、
 * ピッカーは**解釈中の書式を見出しに出す**（`MSG_DTP_FORMAT`）。違えば直接打鍵に切り替えられる。
 */
export const MSG_DATE_PICKER = "日付の選択";
export const MSG_TIME_PICKER = "時刻の選択";
/** 見出しに出す「この書式として入力します」の言い回し。`{f}` に `YYYY/MM/DD` 等が入る */
export const MSG_DTP_FORMAT = (f: string): string => `${f} として入力します`;
/** 区切りが画面に出ておらず日付か時刻か決められないときのタブ */
export const MSG_DTP_TAB_DATE = "日付";
export const MSG_DTP_TAB_TIME = "時刻";
/** 時刻を確定してピッカーを閉じるボタン（時・分・秒が独立していて 1 列では値が決まらないため要る） */
export const MSG_DTP_CONFIRM = "確定";
/** 今日 / 現在時刻へ戻すボタン */
export const MSG_DTP_TODAY = "今日";
export const MSG_DTP_NOW = "現在時刻";
/** 年月送り */
export const MSG_DTP_PREV_MONTH = "前の月";
export const MSG_DTP_NEXT_MONTH = "次の月";

/**
 * データ待ち行列の常駐監視は**エントリを取り出して消す**（本番のコンシューマの取り分を奪う）。
 *
 * requirement の明示要求で、**開始時だけでなく監視中も常に出す**——
 * 誤って本番キューに掛けたことに後から気づけるようにするため。
 */
export const MSG_WATCH_CONSUMES = "監視はエントリを取り出して消します。本番のキューには掛けないでください";

/**
 * **プリンターの出力に失敗して、ホストへの応答を止めている**（`20260921-printer-hold-response`）。
 * ACS と同じく、利用者が再試行か取消を選ぶまで印刷完了を返さない——その間スプールはホストに残る
 */
export const MSG_PRINTER_HELD = "出力に失敗したため、ホストへの印刷完了の応答を止めています（再試行か取消を選んでください）";
/** 再試行のボタン（失敗した出力だけをやり直し、できたら応答する） */
export const MSG_PRINTER_RETRY = "再試行";
/** 取消のボタン（応答を返す。ホストは印刷済みとみなし、SAVE(*NO) のスプールは消える） */
export const MSG_PRINTER_CANCEL = "取消（印刷済みとして応答）";
/** 取消した帳票の状態 */
export const MSG_PRINTER_CANCELED = "取消しました（ホストは印刷済みとみなしました）";

/** ACS: "No room to insert data."（挿入ペーストが欄に収まらない。何も書き換えない） */
export const MSG_NO_ROOM = "挿入する余地がありません";

/**
 * ACS のエラー 0022（`PS5250.processFieldPlusMinusAndExit`）: Field− は符号付き数値・数値専用の欄でしか使えない
 * （継続欄も不可）。値は変えず、欄も出ない（実機の ACS で確認。`20260921-numpad-field-sign`）
 */
export const MSG_FIELD_MINUS_INVALID = "この項目では Field− キーは使用できません";

/**
 * **操作員エラーか**（`20260921-operator-error-mode`）。ACS はこれらで `error_mode` に入り、
 * キーボードを施錠する（`PS5250.setErrorCode` → `ECLOIA.InputInhibited() == 5`）。
 * 情報の通知（表示設定の順送り・日付の選択など）は**施錠しない**ので含めない。
 */
export function isOperatorError(text: string): boolean {
  return (
    text === MSG_NO_ROOM ||
    text === MSG_FIELD_MINUS_INVALID ||
    text === MSG_PROTECTED ||
    text === MSG_DUP_DISALLOWED ||
    text === MSG_FIELD_EXIT_REQUIRED ||
    text === MSG_FIELD_EXIT_KEY_INVALID ||
    // ME / MF / 自己点検も ACS は `setErrorCode` でエラー状態に入る（`20260921-mandatory-check-acs`）
    text === MSG_MANDATORY_ENTER ||
    text === MSG_MANDATORY_FILL ||
    text === MSG_SELF_CHECK ||
    (Object.values(MSG_BY_REASON) as string[]).includes(text)
  );
}

/**
 * ホストが応答しないまま待ち時間が尽きたときの通知。
 *
 * Attn / SysReq は**ホストが黙って無視することが正常にあり得る**（ATNPGM が既に前面のとき等）。
 * 無言で待ちを解くと「押したのに何も起きない」が不具合と区別できないので、起きたことを明示する。
 */
export const MSG_NO_RESPONSE = "ホストから応答がありませんでした";

/**
 * **ブラウザ ↔ ts5250 サーバーの接続そのものが切れた**ときの通知。
 *
 * ホストとの切断（`closed` メッセージ）と別に要る。あちらはサーバーが理由を添えて
 * 教えてくれるが、こちらは **WebSocket が黙って閉じるだけ**でメッセージが届かない
 * （サーバーの再起動・回線断・プロキシのアイドル切断）。何も出さないと、応答待ちの
 * 表示だけが残って「ホストが遅い」と見分けが付かない（実機報告）。
 *
 * **5250 表示セッションでは使わない**——そちらは繋ぎ直しに入るので、諦めたときに
 * `MSG_RECONNECT_GAVE_UP` を出す。使うのは繋ぎ直しの対象外（プリンター）だけで、
 * そこでは開き直す以外に手が無い。
 */
export const MSG_CONNECTION_LOST = "サーバーとの接続が切れました（開き直してください）";

/**
 * VT の切断表示に添える理由（`VtPane` が「切断されました——…」の後ろに出す）。
 *
 * 文言を分けているのは、**先頭に「切断されました」が付く**ため——
 * `MSG_CONNECTION_LOST` をそのまま渡すと「切断されました——…接続が切れました」になる。
 * ホスト側の切断（サーバーが理由を添えて送ってくる）と見分けが付くよう、
 * 切れたのがサーバーとの間であることだけを言う。
 */
export const MSG_VT_CONNECTION_LOST = "サーバーとの通信が切れました（開き直してください）";

/**
 * **繋ぎ直しを諦めたときの通知**（`20260908-session-survives-disconnect`）。
 *
 * 転送が繋がらないまま試行が尽きた場合に出す。**押せば効く手を添える**——
 * OIA に手動の繋ぎ直しが出ているので、それを指す。
 *
 * サーバーが「そのセッションはもう無い」と答えた場合（猶予切れ・他人のもの）は
 * ~~こちらではなくサーバーの理由をそのまま出す~~ → **`wsErrorNotice` が code から作る見出し**
 * （`20260920-field-error-no-value` decisions D2。サーバーの message は出さなくなった）。
 * 待てば直るのか、待っても無駄なのかは利用者が知りたいことが違うので、
 * `SESSION_NOT_FOUND` / `SESSION_CLOSED` の見出しを `NOTICE_BY_ERROR` に持たせて区別を残している。
 */
export const MSG_RECONNECT_GAVE_UP = "サーバーに繋ぎ直せませんでした（再接続で試し直せます）";

/** 手動の繋ぎ直しボタンのラベル（OIA に出す） */
export const MSG_RECONNECT_RETRY = "再接続";

/**
 * 繋がっていないあいだに送ろうとしたときの通知。
 *
 * **黙って捨てない**（`WsClient.send` は OPEN でなければ捨てる）。捨てるだけだと
 * 「押したのに何も起きない」になり、不具合と区別が付かない。
 * 打ちかけの入力はそのまま残るので、繋がってから押し直せばよい。
 */
export const MSG_NOT_CONNECTED = "サーバーと繋がっていないため送信できません";

/**
 * **ホスト側のセッションが終わっている**ときの通知。
 *
 * `MSG_NOT_CONNECTED` と分けるのは、**切れている場所が違う**ため。あちらはブラウザ ↔
 * サーバーで、繋ぎ直せば戻る。こちらはサーバー ↔ ホストが終わっていて、
 * 待っても戻らない（開き直すしかない）。
 */
export const MSG_SESSION_ENDED = "セッションは終了しています（開き直してください）";

/**
 * **ホストに切られて、自動で繋ぎ直している**ときの通知（`20260921-auto-reconnect`）。
 * ACS と同じく 1 回目は即座に、以後 20 秒おきに試す。繋ぎ直せたら新しいサインオン画面が出る。
 * `MSG_SESSION_ENDED` と違い、**待てば戻る**ことを伝える。
 */
export const msgHostReconnecting = (attempt: number): string =>
  attempt <= 1 ? "ホストとの接続が切れたため繋ぎ直しています" : `ホストとの接続が切れたため繋ぎ直しています（${attempt} 回目）`;

/*
 * **応答待ちが長引いたことは、こちらからは言わない**（`session-controller` の `setBusy`）。
 *
 * 一時期ここに `MSG_WAITING_LONG`（「ホストの応答を待っています（Attn / SysReq で中断できます）」）を
 * 置いていたが、**ACS にも実機にもそんなメッセージは無い**——応答待ちに出るのは OIA の
 * `X SYSTEM` だけで、何秒たっても黙って待つ。この一覧の定数はどれも ACS 原文を併記できる
 * ＝**打鍵への反応**なのに、これだけが利用者の操作と無関係に出ていた。ホストが出している
 * 進捗表示（`MSGTYPE(*STATUS)`）まで押しのけるので、消した（利用者の指摘）。
 */

/**
 * 予約（HLLAPI の `Reserve`）で入力が止まっていることを示す。
 *
 * **誰が触っているかを出す。** 「入力できません」だけだと不具合と区別できない。
 */
export const msgReserved = (by: string): string => `${by} が自動操作中です`;
/** 予約を強制解除する非常口の説明（自動化が落ちて解除されないとき用） */
export const MSG_RESERVE_BREAK = "解除して操作する";

/**
 * PC コマンド（`STRPCCMD`）の実行通知。
 *
 * ホストが 5250 の画面に隠して送ってくるので、**何も出さないと「勝手に何かが動いた」
 * ようにしか見えない**。実行の有無と結果を必ず知らせる。実行先（このPC / サーバー）は
 * 通知に含めず、詳細はセッション情報の一覧で見せる（通知が長くなりすぎるため）。
 */
export const MSG_PC_COMMAND_RUNNING = "PC コマンドを実行しています";
export const MSG_PC_COMMAND_DONE = "PC コマンドを実行しました";
export const MSG_PC_COMMAND_FAILED = "PC コマンドの実行に失敗しました";
/** 既定は無効。**ホストへの応答は返している**ので、画面は進むが実行はされていない */
export const MSG_PC_COMMAND_DISABLED = "PC コマンドの実行は無効になっています";
export const MSG_PC_COMMAND_DENIED = "PC コマンドが許可リストに一致しません";

/** 欄の型に合わない文字を弾いたときの理由表示（ACS 原文は各行のコメント）。 */
export const MSG_BY_REASON: Record<RejectReason, string> = {
  // ACS: "Field requires numeric characters."
  numeric: "数字項目には数字しか入力できません",
  // ACS: "Field data must be alphanumeric."
  alphanumeric: "この項目には半角文字しか入力できません",
  // ACS: "Double-byte character required as input."
  "dbcs-required": "この項目には全角文字しか入力できません",
  // ACS: "Field requires alphabetic characters."
  "alpha-only": "この項目には英字しか入力できません",
  // ACS: "Data not allowed in this field."（DDS 35 桁の `I` = Inhibit keyboard entry）
  "kbd-inhibited": "この項目はキーボードから入力できません",
  // ACS: "Only a sign is allowed in this position."（符号付き数値欄の最終桁＝符号桁）
  "sign-position": "符号桁には数字を入力できません（符号は - / + キーで入れます）"
};

/**
 * **送信が拒否された理由を操作員に見せる。** ホスト応答待ちを解くだけで黙っていると、
 * 「Enter を押したのに何も起きない」＝不具合と区別が付かない
 * （実機で数字専用欄に `.` を打ってから Enter を押すと、`FIELD_TYPE` で 1 バイトも
 * 飛ばないまま画面が固まったように見えていた）。
 *
 * ~~頭に日本語の要約を置き、**元のメッセージも残す**——どの欄のどの値かは元の文にしかない。~~
 * → **サーバーの message は出さない**（`20260920-field-error-no-value` decisions D2）。
 * その message には**打鍵した値が入りうる**——マクロの秘密を型の合わない欄へ再生すると、
 * **復号済みの平文がここから画面へ出ていた**（同 research F1。`AGENTS.md`「秘密の扱い」の
 * 「API/ブラウザには平文も暗号文も返さない」）。
 *
 * 「どの欄か」は**サーバーが message に入れた位置**（`field at (20,7)`）だけを拾って添える。
 * 値は拾わない。
 */
/**
 * **見出しは code ごとに 1 つ。** message を出さなくしたので（decisions D2）、
 * **ここに無い code は「エラーが起きました」の一行だけ**になる。
 * `Partial<Record<…, string>>` で `@ts5250/base` の語彙に結んでおくと、
 * 綴りの間違いはコンパイルで止まる（review ラウンド 3 の指摘）。
 * **全 code を埋めることは求めない**——埋めるべきかは「その code が ws で利用者に届くか」で決まる。
 *
 * **`INTERNAL_ERROR` は `ErrorCode` に無い**——`ws-handler.ts` が
 * `err instanceof As400Error ? err.code : "INTERNAL_ERROR"` で**その場で作る**文字列で、
 * 語彙には登録されていない（この型付けで初めて分かった）。利用者にはこの経路が届くので
 * 見出しが要る。語彙に入れるかは `@ts5250/base` の話なので、ここでは union に足すだけにする。
 */
const NOTICE_BY_ERROR: Partial<Record<ErrorCode | "INTERNAL_ERROR", string>> = {
  // **繋ぎ直しの終わり方として一番普通の 2 つ**（`20260908-session-survives-disconnect`）。
  // 起票当時は「入れておかないと『エラー: session 3f2a…-… not found』という**生の英語＋UUID**が
  // 操作員に残る」だった。**いまは message を出さないのでそうはならない**（出るのは
  // 「エラーが起きました」。`20260920-field-error-no-value` decisions D2）——
  // 見出しが要る理由は変わって、**既定文では「開き直せばよい」と分からない**こと
  // （`"gone"` では再接続ボタンも出さないので、案内はこの一行だけ）
  SESSION_NOT_FOUND: "セッションは既に終了しています（開き直してください）",
  FORBIDDEN: "このセッションを操作する権限がありません",
  FIELD_TYPE: "入力できない文字があるため送信しませんでした",
  FIELD_OVERFLOW: "欄の桁数を超えているため送信しませんでした",
  FIELD_PROTECTED: "保護された欄には入力できません",
  FIELD_NOT_FOUND: "指定された欄がありません",
  KEYBOARD_LOCKED: "キーボードがロックされています",
  READ_ONLY_SESSION: "閲覧専用のセッションです",
  SESSION_RESERVED: "他の使い手が自動操作中です",
  // **message を出さなくしたので、見出しの無い code は「エラー」だけになる。**
  // 素の英語が消えるぶん、ここに無い code は何も手掛かりが残らないので足す
  // （`20260920-field-error-no-value` decisions D2）
  // `PROTOCOL_ERROR` は `packages/base/src/errors.ts` では**ホスト側のプロトコル逸脱**
  // （未知のオーダー・壊れたレコード）で、「利用者が直せる問題に使ってはならない」と定義されている。
  // ws に届くぶんは送れないキーの拒否が大半だが、**語彙の定義に合わせて原因を断定しない**言い方にする
  // （`20260920-field-error-no-value` の cross 点検の指摘）
  PROTOCOL_ERROR: "この操作は受け付けられませんでした",
  CONFIG_ERROR: "設定に誤りがあるため実行できません",
  SESSION_CLOSED: "セッションは閉じています（開き直してください）",
  SESSION_LIMIT: "同時に開けるセッションの上限に達しています",
  NOT_FOUND: "指定されたものが見つかりません",
  // **プリンターの開始・停止はその場で接続を張る**ので、接続系の失敗がこの口へ届く
  // （`session-manager.ts` の `startPrinter`。`20260920-field-error-no-value` review ラウンド 4）。
  // 見出しが無いと「エラーが起きました」の一行になり、8925（装置が使用中）のように
  // **code 自体が診断になっている**ものまで潰れる
  SESSION_REJECTED: "ホストが接続を断りました（装置名が使用中かもしれません）",
  CONNECT_FAILED: "ホストに接続できませんでした",
  NEGOTIATION_TIMEOUT: "ホストとの接続手順が完了しませんでした",
  TLS_CERT_INVALID: "ホストの証明書を確認できませんでした",
  INTERNAL_ERROR: "サーバー側で想定外の問題が起きました"
};

/**
 * その code の見出し。**テストはリテラルではなくこれを参照する**
 * （`AGENTS.md`「定数は 1 か所へ置き、テストは文言リテラルではなく定数を参照する」）。
 */
export const noticeFor = (code: ErrorCode | "INTERNAL_ERROR"): string =>
  // 同じ表は同じ引き方で引く（`wsErrorNotice` と揃える）
  Object.hasOwn(NOTICE_BY_ERROR, code) ? NOTICE_BY_ERROR[code]! : MSG_UNKNOWN_ERROR;

/** 見出しの無い code のときに出す。**サーバーの文言は出さない** */
export const MSG_UNKNOWN_ERROR = "エラーが起きました";

/**
 * サーバーの message から**欄の位置だけ**を拾う。
 *
 * 形は core が `field at (行,桁)` で統一している
 * （`packages/tn5250/src/screen/field-validate.ts` の `where()` と
 * `packages/tn5250/src/screen/buffer.ts` の `FIELD_PROTECTED`）。
 * **値は拾わない**——そもそも message に入らないが、ここで拾う対象を位置だけに限ることで、
 * 将来また値が混ざっても画面には出ない（`20260920-field-error-no-value` decisions D2）。
 */
/** 欄の位置の言い方。**テストはこれを参照する**（`AGENTS.md`「定数は 1 か所へ」） */
export const fieldAtLabel = (row: number | string, col: number | string): string =>
  `${row} 行 ${col} 桁の欄`;

function fieldAtOf(message: string): string | undefined {
  const m = /field at \((\d+),(\d+)\)/.exec(message);
  return m ? fieldAtLabel(m[1]!, m[2]!) : undefined;
}

/**
 * サーバーの message から**弾かれた理由**を拾う。
 *
 * `FIELD_TYPE` には 4 つの理由（数字だけ / 英字だけ / 全角だけ / コードページ外）があるのに、
 * code は 1 つしか無い。見出しだけにすると「入力できない文字があるため送信しませんでした」に
 * 畳まれ、**何をどう直せばよいかが分からない**（requirements FR2「位置**と**なぜ弾かれたか」、
 * US1。`20260920-field-error-no-value` review の指摘）。
 *
 * **拾うのは閉じた語彙だけ**——`message` を部分文字列として通すのではなく、
 * **こちらが知っている定型句に一致したときだけ**対応する日本語を返す。
 * サーバーの文がそのまま画面へ出る経路を作らないので、D2 の「message を出さない」は保たれる。
 * 定型句は `packages/tn5250/src/screen/field-validate.ts` が作る
 * （契約は `packages/web-ui/test/field-at-contract.test.ts` が走査で固定している）。
 */
/** コードページで表せない文字。**CCSID 番号は出さない**（利用者には意味が無い） */
export const MSG_OUTSIDE_CCSID = "この項目では使えない文字が含まれています";

const REASON_PHRASES: readonly (readonly [string, string])[] = [
  ["accepts digits only", MSG_BY_REASON.numeric],
  ["accepts alphabetic characters only", MSG_BY_REASON["alpha-only"]],
  ["accepts double-byte characters only", MSG_BY_REASON["dbcs-required"]],
  // コードページ外は `MSG_BY_REASON` に対応が無い（打鍵時の検査には無い理由）ので個別に持つ
  ["cannot hold characters outside CCSID", MSG_OUTSIDE_CCSID]
];

function reasonOf(message: string): string | undefined {
  return REASON_PHRASES.find(([phrase]) => message.includes(phrase))?.[1];
}

/**
 * **message から拾ってよい code**（`20260920-field-error-no-value` review ラウンド 4）。
 *
 * 位置も理由も **core の欄検証が作った文言にしか無い**。code を見ずに拾うと、
 * **反射の残っている経路でクライアントが表示文を選べる**——
 * `{"type":"printer-stop","sessionId":"field at (9,9) accepts digits only"}` は
 * `SESSION_NOT_FOUND: printer session field at (9,9) accepts digits only not found` になり、
 * 画面には「数字項目には数字しか入力できません（9 行 9 桁の欄）」が出ていた（実測）。
 *
 * **拾う対象を閉じた語彙に絞るだけでは足りない**（語彙に一致する文字列は client が作れる）。
 * **どの code のときに拾うか**まで閉じて初めて、出る文言がこちらの決めたものになる。
 * 反射そのものを塞ぐのが根治だが、**塞ぎ漏れが 1 本でもあると表示が乗っ取られる**ので、
 * こちら側でも閉じる（二重防御。D2 の精神をこの層にも当てる）。
 */
const CODES_WITH_FIELD_DETAIL = new Set(["FIELD_TYPE", "FIELD_OVERFLOW", "FIELD_PROTECTED"]);

export function wsErrorNotice(code: string, message: string): string {
  // **`Object.hasOwn` で引く**——素のオブジェクトリテラルなので、`code` が `constructor` /
  // `toString` だと継承プロパティ（関数）が返り `??` が効かない。`code` はサーバー生成なので
  // 今は届かないが、**戻り値が文字列であること**を型ではなくここで閉じる
  const head = Object.hasOwn(NOTICE_BY_ERROR, code)
    ? NOTICE_BY_ERROR[code as ErrorCode | "INTERNAL_ERROR"]!
    : MSG_UNKNOWN_ERROR;
  // **欄の検証が作った文言のときだけ中身を見る**（上の `CODES_WITH_FIELD_DETAIL` の注記）
  if (!CODES_WITH_FIELD_DETAIL.has(code)) return head;
  // **理由があれば見出しより理由を出す**——「入力できない文字がある」より
  // 「数字しか入力できません」のほうが、利用者が次に何をすればよいか分かる
  const body = reasonOf(message) ?? head;
  const at = fieldAtOf(message);
  return at ? `${body}（${at}）` : body;
}

/**
 * ホストが「入力必須」「全桁充填」と指定した欄が満たされていないときの通知（FFW の
 * `MANDATORY_ENTER` / `MANDATORY_FILL`）。
 *
 * **ホストはこれを検証しない**（実機で実測。空のまま Enter を送っても素通りした）ので、
 * 端末が止めなければ DDS に `CHECK(ME)` と書いたアプリの意図が丸ごと無視される。
 */
/**
 * Dup が許されない欄で Dup を押したときの通知（5250 の操作員エラー 0019 相当）。
 * ホストが `DUP_ENABLE`（FFW 0x1000）を立てた欄でしか使えない。
 * ACS: "Dup key not allowed in this field."
 */
export const MSG_DUP_DISALLOWED = "この項目では複写キーを使用できません";

/**
 * ACS のエラー 0020（実機の文言は「このフィールドには実行キーは許されていない。」）。
 * 右寄せ・符号付き数値の欄に打ったまま、欄を出ずに実行キーを押した（`needsFieldExit`）。
 * **出方を添える**——ACS は出し方を言わないが、Field Exit を知らない利用者は抜け方が分からない。
 */
export const MSG_FIELD_EXIT_REQUIRED = "この項目では実行キーを使用できません（Field Exit か Tab で項目を出てください）";

/**
 * ACS のエラー 0018（`PS5250.processCharKeyStroke` の `setErrorCode(24)`＝0x18）。実機の ACS の文言は
 * 「フィールドを終了するために使用したキーが正しくない。」（`scripts/acs-probe/field-exit-full.txt` の場合 C）。
 * Field Exit が必須の欄（右寄せ・符号付き数値・FER）を最終桁まで打ち、**そこでさらに文字を打った**。
 * ACS は欄を出たものとして扱い（`fieldExited`）、次の文字は「欄を出るのに使えないキー」として拒否する。
 */
export const MSG_FIELD_EXIT_KEY_INVALID = "この項目は最終桁まで入力されています（Field Exit か Tab で項目を出てください）";

/**
 * ME（必須入力）。**ACS のエラー 0007**（`PS5250.processAIDCode` の `setErrorCode(7)`）。
 * ~~5250 の操作員エラー 0021 相当~~（番号の誤り）。実機の ACS の文言は「入力必須フィールドである。
 * データを入力しなければなりません。」。ACS: "Mandatory field not entered."
 */
export const MSG_MANDATORY_ENTER = "入力が必要な項目が入力されていません";
/**
 * MF（必須埋め）。**ACS のエラー 0014**（`setErrorCode(20)`＝0x14）。~~0022 相当~~（番号の誤り）。
 * 実機の ACS の文言は「全桁入力フィールド。終わりまで入力しなければなりません。」。ACS: "Field must be filled."
 */
export const MSG_MANDATORY_FILL = "この項目はすべての桁を埋めてください";
/** 自己点検欄（CHECK(M10)/CHECK(M11)）の検査桁が合わない。**ACS のエラー 0015**（`setErrorCode(21)`＝0x15） */
export const MSG_SELF_CHECK = "この項目の検査数字が正しくありません";

/**
 * **このタブのシステムが設定から消えた**（`20260802-tabs-own-system`）。
 *
 * タブは 1 つのシステムへの窓なので、その先が無くなったら**止めて理由を出す**。
 * 黙って別システムへ要求を飛ばさないこと、そして黙って閉じない（書きかけの内容ごと
 * 消える）ことの両方を満たす扱い。
 */
export const MSG_SYSTEM_GONE =
  "このタブのシステムは設定から削除されました。操作できません。";

// ---- 実行計画（Visual Explain 相当。`20260802-sql-visual-explain`） ----

/**
 * 採取モードのラベル。
 *
 * **「実行しない」と書かない。** IBM i には文を実行せずに計画だけ得る経路が無く
 * （research F7: prepare だけでは最適化記録が 0 件、最適化は open の時点で起きる）、
 * `no-rows` は**行を返さないだけで文はホストで実行される**。
 * できないことを匂わせる文言にすると、更新系でも安全だと誤解される。
 */
export const MSG_PLAN_MODE_RUN = "実行して計画";
export const MSG_PLAN_MODE_NO_ROWS = "行を返さず計画";
export const MSG_PLAN_MODE_NO_ROWS_HINT =
  "結果行を返さずに計画だけ取ります（文はホストで実行されます。SELECT 系のみ）";
export const MSG_PLAN_MODE_RUN_HINT = "文を実行してから計画を取ります";

/** 索引の作成は取り消せない。**文を見せてから確認する** */
export const MSG_PLAN_CREATE_INDEX_CONFIRM =
  "この索引を作成します。ホスト上の変更で取り消せません。実行してよろしいですか";

/** プランキャッシュを参照できないとき、履歴側へ逃がす案内 */
export const MSG_PLAN_CACHE_FALLBACK = "このアプリで採った計画は「実行履歴」から見られます";

/** 未対応の記録種別。**警告にしない**（毎回出ると版数差の信号が埋もれる） */
export const MSG_PLAN_UNKNOWN_RECORDS = "この計画に含まれる未対応の記録種別";

/** 保存の上限で古いものを落としたとき。**黙って消さない** */
export const MSG_PLAN_SAVE_DROPPED = "保存の上限を超えたため、古い計画を削除しました";

/**
 * ブラウザに書き出せなかったとき。**「保存しました」で終わらせない**
 * ——次に開いたときに黙って消えていることになる。
 */
export const MSG_PLAN_SAVE_NOT_PERSISTED =
  "この計画をブラウザに保存できませんでした（容量が上限に達している可能性があります）。JSON で書き出してください";

/**
 * タブグループの一括クローズ。**枚数を示してから確認する**（`20260804-tab-groups`）——
 * タブ 1 枚の ✕ と違って**まとめて消える**うえ、5250 セッションを含むと切断まで起きる。
 * 取り消せない操作は文言で中身を見せてから確認する（`MSG_PLAN_CREATE_INDEX_CONFIRM` と同じ考え方）。
 */
export const msgCloseTabGroup = (n: number): string =>
  `${n} 枚のタブを閉じます。接続中のセッションは切断されます`;
