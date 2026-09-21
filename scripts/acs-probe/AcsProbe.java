import com.ibm.eNetwork.ECL.ECLField;
import com.ibm.eNetwork.ECL.ECLFieldList;
import com.ibm.eNetwork.ECL.ECLOIA;
import com.ibm.eNetwork.ECL.ECLPS;
import com.ibm.eNetwork.ECL.ECLSession;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.Set;

/**
 * ACS のコア（{@code acshod2.jar} の HACL/ECL）を GUI 無しで実機に当て、手順ファイルどおりに打鍵して、
 * ACS 側の画面・カーソル・入力禁止の状態を出す（`scripts/acs-probe.mjs` から起動する）。
 *
 * <p><b>なぜ要るか:</b> 「ACS ならどう見えるか」は、これまで利用者に ACS を起動してもらわないと測れなかった。
 * HACL の公開 API（{@code ECLSession} / {@code ECLPS} / {@code ECLOIA}）を呼べば、ACS のデータストリーム処理
 * （{@code DS5250} / {@code PS5250}）そのものを実機に当てられる（`20260919-backlog-acs-triage` research F0-2）。
 * 取れるのは<b>コアの挙動</b>だけで、GUI 固有の経路（打鍵が {@code ECLPS.SendKeys} を通るか等）は取れない。
 *
 * <p>これは HACL を呼ぶだけの自作コードで、ACS のコードは含まない。jar は利用者の手元のものを
 * クラスパスで渡す（AGENTS.md「ライセンスと出典」: 原典をリポジトリに取り込まない）。
 *
 * <p>引数: {@code <手順ファイル> <接頭辞>}。資格情報は環境変数 {@code <接頭辞>_HOST/_USER/_PASSWORD} から読み、
 * <b>引数にも出力にも載せない</b>。{@code ${LIB}} は {@code <接頭辞>_LIB} に置き換える。
 * 要る JDK は 17 以上（switch の矢印形を使う）。
 *
 * <p>終了コード: 0 = 手順を最後まで流した / 2 = 手順の誤り（実機に繋ぐ前に止める） / 3 = 接続できない・サインオンできない /
 * 4 = 途中で止まった（例外・エラー）。<b>0 は最後まで流れたときだけ</b>返す（`20260919-backlog-acs-triage` review ラウンド 2:
 * 例外の種類やサインオンの失敗で偽の合格を出さない）。
 */
public class AcsProbe {
  /**
   * 出力は UTF-8・改行は LF に固定する。OS 既定の文字コード（C ロケールの ASCII・日本語 Windows の MS932）で
   * 出すと、受け取る `acs-probe.mjs` が UTF-8 として読むので日本語が化ける（`20260919-backlog-acs-triage` review ラウンド 1）
   */
  private static final PrintStream OUT = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
  private static final PrintStream ERR = new PrintStream(new FileOutputStream(FileDescriptor.err), true, StandardCharsets.UTF_8);
  private static ECLPS ps;
  private static ECLOIA oia;
  /** 通信状態（`GetCommStatus`）と実際に効いている自動再接続の設定を dump に出すため */
  private static ECLSession sess;

  /** 手順の誤り（未定義の命令・引数の書式・未設定の変数）。流す前に止めるため、実機に繋ぐ前に検査する */
  private static final class StepError extends Exception {
    StepError(String m) { super(m); }
  }

  /** 空でない行・カーソル（1 始まりの行,桁）・入力禁止・挿入モードの状態を出す。DBCS は 1 文字が 2 桁ぶん重複して出る（TEXT_PLANE の仕様） */
  private static void dump(String label) throws Exception {
    int rows = ps.GetSizeRows(), cols = ps.GetSizeCols();
    char[] buf = new char[rows * cols + 1];
    ps.GetScreen(buf, rows * cols, ECLPS.TEXT_PLANE);
    int pos = ps.GetCursorPos();
    OUT.print("=== " + label + " cursor=" + ((pos - 1) / cols + 1) + "," + ((pos - 1) % cols + 1)
        + " inhibit=" + oia.InputInhibited() + " insert=" + oia.IsInsertMode() + commInfo() + "\n");
    for (int r = 0; r < rows; r++) {
      String line = new String(buf, r * cols, cols);
      if (!line.isBlank()) OUT.print(String.format("%02d|%s", r + 1, line.replaceAll("\\s+$", "")) + "\n");
    }
  }

  /**
   * 通信状態と、**実際に効いている** `autoReconnect`（private なのでリフレクションで読む）。
   * 設定を渡しただけでは効いたか分からない——効いていないのに「再接続しなかった」と読むと
   * 陰性と取り違える。
   */
  private static String commInfo() {
    if (sess == null) return "";
    String ar = "?";
    try {
      java.lang.reflect.Field f = com.ibm.eNetwork.ECL.ECLConnection.class.getDeclaredField("autoReconnect");
      f.setAccessible(true);
      ar = String.valueOf(f.getBoolean(sess));
    } catch (Exception e) {
      ar = "読めず(" + e.getClass().getSimpleName() + ")";
    }
    return " commStatus=" + sess.GetCommStatus() + " started=" + sess.IsCommStarted() + " autoReconnect=" + ar;
  }

  /** 入力禁止が解けるまで（最長 15 秒）待ち、さらに ms 待つ。応答が複数レコードに分かれる画面のため、解けた直後には読まない */
  private static void settle(long ms) throws Exception {
    long end = System.currentTimeMillis() + 15000;
    while (oia.InputInhibited() != 0 && System.currentTimeMillis() < end) Thread.sleep(50);
    Thread.sleep(ms);
  }

  /**
   * サインオン画面の最初の 2 つの入力欄（利用者名・パスワード）に<b>欄として直接</b>書いて Enter を押す。
   * 打鍵で送らない理由は 2 つ（`20260919-backlog-acs-triage` review ラウンド 1）:
   * 10 文字の利用者名は欄を埋めて自動送りでパスワード欄へ進み、続く Tab で 1 欄ずれる。
   * {@code SendKeys} は {@code [...]} をキーの名前として解釈するので、{@code [} を含むパスワードが化ける。
   * どちらも誤ったパスワードとして QMAXSIGN を消費する。
   */
  private static boolean signon(String user, String password) throws Exception {
    ECLFieldList fl = ps.GetFieldList();
    fl.Refresh();
    ECLField first = null, second = null;
    for (ECLField f = fl.GetFirstField(); f != null; f = fl.GetNextField(f)) {
      if (f.IsProtected()) continue;
      if (first == null) first = f;
      else { second = f; break; }
    }
    if (first == null || second == null) throw new IllegalStateException("サインオン画面の入力欄が見つかりません");
    // 欄への直接書き込みは打鍵の経路を通らず、欄の大文字化が掛からない（推測）。利用者名は IBM i では常に大文字。
    // パスワードは、英小文字の無いコードページ（930 / 5026 / 290 の SBCS）では大文字にする——そのままだと
    // 英小文字が別の文字に化ける。大文字小文字を区別する機械（QPWDLVL 2/3）は、37 などで繋ぐこと（README）
    first.SetString(user.toUpperCase(Locale.ROOT));
    second.SetString(NO_LOWERCASE.contains(env("PROBE_CODEPAGE", "930")) ? password.toUpperCase(Locale.ROOT) : password);
    ps.SendKeys("[enter]");
    settle(1500);
    // **成否を確かめる。** 非表示の入力欄（パスワード欄）が残っていれば、まだサインオン画面か、
    // パスワードの変更を求められている。続きの手順を打つと、誤った試行が積み上がる（QMAXSIGN）
    fl.Refresh();
    for (ECLField f = fl.GetFirstField(); f != null; f = fl.GetNextField(f)) {
      if (!f.IsProtected() && !f.IsDisplay()) return false;
    }
    return true;
  }

  /** SBCS に英小文字の無いコードページ（日本語カタカナ系） */
  private static final Set<String> NO_LOWERCASE = Set.of("930", "5026", "290");

  private static String env(String name, String fallback) {
    String v = System.getenv(name);
    return v == null || v.isEmpty() ? fallback : v;
  }

  /** 手順を読み、命令名と `${LIB}` の有無を実機に繋ぐ前に確かめる（誤りを流してから気づくと、実機に半端な操作が残る） */
  private static List<String> loadSteps(String path, String lib) throws Exception {
    List<String> lines = Files.readAllLines(Paths.get(path), StandardCharsets.UTF_8);
    for (int i = 0; i < lines.size(); i++) {
      String line = lines.get(i).strip();
      if (line.isEmpty() || line.startsWith("#")) continue;
      String[] t = line.split(" ", 2);
      String cmd = t[0];
      String arg = t.length > 1 ? t[1].strip() : "";
      String at = (i + 1) + " 行目: ";
      // 引数の書式も接続前に確かめる。サインオンの後で数値の誤りに気づくと、SIGNOFF せずに止まる
      switch (cmd) {
        case "signon", "dump" -> { }
        case "keys" -> { if (arg.isEmpty()) throw new StepError(at + "keys の後に送る文字列が要ります"); }
        case "settle" -> { if (!arg.isEmpty() && !arg.matches("\\d+")) throw new StepError(at + "settle の引数はミリ秒の整数: " + arg); }
        case "sleep" -> { if (!arg.matches("\\d+")) throw new StepError(at + "sleep の引数はミリ秒の整数: " + arg); }
        case "setcursor" -> { if (!arg.matches("\\d+\\s*,\\s*\\d+")) throw new StepError(at + "setcursor の引数は 行,桁: " + arg); }
        default -> throw new StepError(at + "未定義の命令 " + cmd);
      }
      if (line.contains("${LIB}") && lib.isEmpty()) throw new StepError((i + 1) + " 行目: ${LIB} を使うが <接頭辞>_LIB が未設定（.env.verify）");
    }
    return lines;
  }

  public static void main(String[] args) {
    if (args.length < 2) {
      ERR.print("usage: AcsProbe <steps> <prefix>\n");
      System.exit(2);
    }
    String prefix = args[1];
    String lib = env(prefix + "_LIB", "");
    List<String> steps;
    try {
      steps = loadSteps(args[0], lib);
    } catch (Exception e) {
      ERR.print("手順の誤り: " + e.getMessage() + "\n");
      System.exit(2);
      return;
    }

    Properties p = new Properties();
    p.put(ECLSession.SESSION_HOST, env(prefix + "_HOST", ""));
    p.put(ECLSession.SESSION_HOST_PORT, env("PROBE_PORT", "23"));
    p.put(ECLSession.SESSION_TYPE, ECLSession.SESSION_TYPE_5250_STR);
    // 既定のコードページは `acs-probe.mjs` が接頭辞で決めて渡す（PUB400 は英小文字のある 37。930 の SBCS には英小文字が無い）
    p.put(ECLSession.SESSION_CODE_PAGE, env("PROBE_CODEPAGE", "930"));
    // 2 = 24x80 / 5 = 27x132（HOD の psSize。`query-reply.ts` の注記と同じ値）
    p.put(ECLSession.SESSION_PS_SIZE, env("PROBE_SCREEN_CODE", "2"));
    // 装置名は既定では指定しない（ホストに採らせる）。新規の名前は自動構成が効かない実機がある
    String dev = env("PROBE_DEVNAME", "");
    if (!dev.isEmpty()) p.put(ECLSession.SESSION_WORKSTATION_ID, dev);
    // **自動再接続**（既定は指定しない＝ECL の既定 false）。ECL のコアは `SESSION_AUTORECONNECT`
    // を既定 false で読むが、ACS の GUI が使う HOD の bean（`HODDefaults`）は true にしている。
    // 切断後の挙動を ACS の GUI に寄せて測るときだけ `PROBE_AUTORECONNECT=true` を渡す
    String ar = env("PROBE_AUTORECONNECT", "");
    if (!ar.isEmpty()) p.put("SESSION_AUTORECONNECT", ar);

    // 最後まで流れたときだけ 0 にする（途中で何が起きても、既定は「途中で止まった」）
    int code = 4;
    ECLSession s = null;
    try {
      s = new ECLSession(p);
      sess = s;
      s.StartCommunication();
      ps = s.GetPS();
      oia = s.GetOIA();
      long end = System.currentTimeMillis() + 20000;
      while (!s.IsCommStarted() && System.currentTimeMillis() < end) Thread.sleep(100);
      // **繋がらないまま手順へ進まない**——空の画面を dump して 0 で終わると、失敗が合格に見える
      // **自動再接続の実効値は、接続が確立してから立てる。** 接続開始の処理が設定から
      // 読み直して上書きするので、`StartCommunication` の前に立てても false に戻る
      // （プロパティ `SESSION_AUTORECONNECT` 経由も、事前のリフレクションも、dump で false と確認）。
      // ACS の GUI は HOD の bean（`HODDefaults` の autoReconnect=true）で有効にしているので、それに寄せる
      if ("true".equals(ar) && s.IsCommStarted()) {
        java.lang.reflect.Field f = com.ibm.eNetwork.ECL.ECLConnection.class.getDeclaredField("autoReconnect");
        f.setAccessible(true);
        f.setBoolean(s, true);
      }
      if (!s.IsCommStarted()) {
        ERR.print("接続できませんでした（20 秒）。ホスト・ポート・ネットワークを確かめてください\n");
        code = 3;
        return;
      }
      settle(1500);
      for (String raw : steps) {
        String line = raw.strip();
        if (line.isEmpty() || line.startsWith("#")) continue;
        String[] t = line.split(" ", 2);
        String arg = t.length > 1 ? t[1] : "";
        switch (t[0]) {
          case "signon" -> {
            if (!signon(env(prefix + "_USER", ""), env(prefix + "_PASSWORD", ""))) {
              ERR.print("サインオンできませんでした（パスワード欄が残っている。資格情報・期限切れ・プロファイルの状態を確かめてください）\n");
              code = 3;
              return;
            }
          }
          case "keys" -> ps.SendKeys(arg.replace("${LIB}", lib));
          case "settle" -> settle(arg.isEmpty() ? 800 : Long.parseLong(arg));
          case "sleep" -> Thread.sleep(Long.parseLong(arg));
          case "setcursor" -> {
            String[] rc = arg.split(",");
            ps.SetCursorPos(Integer.parseInt(rc[0].trim()), Integer.parseInt(rc[1].trim()));
          }
          case "dump" -> dump(arg);
          default -> throw new StepError("未定義の命令 " + t[0]); // loadSteps で弾いているので来ない
        }
      }
      code = 0;
    } catch (Throwable e) {
      // `Exception` だけでは `Error`（NoClassDefFoundError 等）が素通りし、既定の 4 のまま黙って終わる。
      // 例外の文言にホストが載ることがある。伏せるのは `acs-probe.mjs` の役目（ここでは出すだけ）
      ERR.print("途中で止まりました: " + e + "\n");
      code = 4;
    } finally {
      // **例外でも必ず切る**——HACL は非デーモンのスレッドを持ち、切らないと JVM が残る
      try {
        if (s != null) s.StopCommunication();
        Thread.sleep(500);
      } catch (Exception ignored) {
        // 片付けの失敗は終了コードに含めない
      }
      System.exit(code);
    }
  }
}
