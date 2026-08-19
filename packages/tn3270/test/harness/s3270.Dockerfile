# 参照クライアント s3270（x3270 suite v4.1ga10・BSD-3-Clause）。
# **cp930 / cp939 を内蔵している**ので、日本語 DBCS の照合先として使える
# （`s3270 -v` の "DBCS host code pages" で確認できる）。
FROM ubuntu:24.04
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends s3270 && \
    rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/bin/bash","-lc"]
