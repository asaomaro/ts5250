# VT 検証用の telnet ホスト

VT の実装を**実アプリ相手に**確かめるための Linux ホスト。`vi` / `less` / `tmux` / `iconv` が入っている。

```sh
docker build -t ts5250-vt-telnetd scripts/vt-telnetd
docker run -d --name ts5250-vt -p 2331:23 ts5250-vt-telnetd
docker rm -f ts5250-vt        # 片付け
```

- **ポートは 2331**。2323 は同じホストの別プロジェクトが使っていた（実測）
- ログインは無い（`busybox telnetd -l /bin/bash`）。**検証用なので外に出さないこと**
- `TERM=xterm-256color` / `LANG=en_US.UTF-8`

`tmux capture-pane -p` を**突合の物差し**に使える（3270 で `s3270` を oracle にしたのと同じ役回り）。
