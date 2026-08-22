FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      busybox-static vim-tiny less ncurses-bin ncurses-base locales tmux procps coreutils \
 && sed -i 's/^# *\(ja_JP.UTF-8\|en_US.UTF-8\)/\1/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/vim.tiny /usr/local/bin/vi
ENV LANG=en_US.UTF-8 TERM=xterm-256color
EXPOSE 23
CMD ["busybox","telnetd","-F","-l","/bin/bash","-p","23"]
