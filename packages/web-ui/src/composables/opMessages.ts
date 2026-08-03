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
 * **ACS とあえて揃えていない点**: ACS はメッセージがクリアされるまで文字入力を
 * 受け付けないが、本実装は受け付ける（不便なためユーザー判断）。クリア契機も
 * ACS の「ホスト通信 or カーソルキー移動」ではなく任意のキー操作とする。
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
 * データ待ち行列の常駐監視は**エントリを取り出して消す**（本番のコンシューマの取り分を奪う）。
 *
 * requirement の明示要求で、**開始時だけでなく監視中も常に出す**——
 * 誤って本番キューに掛けたことに後から気づけるようにするため。
 */
export const MSG_WATCH_CONSUMES = "監視はエントリを取り出して消します。本番のキューには掛けないでください";

/** ACS: "No room to insert data."（挿入ペーストが欄に収まらない。何も書き換えない） */
export const MSG_NO_ROOM = "挿入する余地がありません";

/**
 * ホストが応答しないまま待ち時間が尽きたときの通知。
 *
 * Attn / SysReq は**ホストが黙って無視することが正常にあり得る**（ATNPGM が既に前面のとき等）。
 * 無言で待ちを解くと「押したのに何も起きない」が不具合と区別できないので、起きたことを明示する。
 */
export const MSG_NO_RESPONSE = "ホストから応答がありませんでした";

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
  "kbd-inhibited": "この項目はキーボードから入力できません"
};

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

/** 5250 の操作員エラー 0021 相当。ACS: "Mandatory field not entered." */
export const MSG_MANDATORY_ENTER = "入力が必要な項目が入力されていません";
/** 5250 の操作員エラー 0022 相当。ACS: "Field must be filled." */
export const MSG_MANDATORY_FILL = "この項目はすべての桁を埋めてください";

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
