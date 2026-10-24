# dsh-shell-host#141 的 Docker sshd 挂具镜像：一条真实 ssh 往返的最小远端。
#
# 远端要满足 ADR-0017 decision 6 的裁决形状：POSIX-family login shell（/bin/sh）
# 加 POSIX 词表。而 remote-fs 的远端脚本额外依赖 GNU 扩展旗标（find -printf /
# realpath -m -z / dd iflag=skip_bytes / ln -T / mv -T / stat -L -c），busybox 的
# 同名工具不支持这些旗标 —— 所以 coreutils + findutils 必须装全，不能只靠 busybox。
# openssh 里带 sshd 与 ssh-keygen；专用非 root 用户 dsh（登录 shell /bin/sh），
# 让"权限拒绝"类失败注入（chmod 000）对 root 之外真实生效。
FROM alpine:3.20

# adduser -D 把账号置成锁定态（shadow 里是 `!`），sshd 连公钥登录也拒；
# 置 `*` = 保留"密码不可用"，账号本身放行公钥登录。
# 注意：注释不能写进 RUN 续行链中间——Dockerfile 注释会打断反斜杠续行（实测）。
RUN apk add --no-cache openssh coreutils findutils \
  && adduser -D -s /bin/sh dsh \
  && echo 'dsh:*' | chpasswd -e \
  && mkdir -p /run/sshd \
  && ssh-keygen -A \
  && sed -i -e 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
  && sed -i -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config

# 镜像不含任何测试密钥：授权公钥由挂具在容器启动后经 `exec -i` stdin 注入
# （tests/helpers/sshd-container.ts）。镜像因此是共享缓存键（tag
# dsh-sshd-live:test），内容只由本文件决定，并发 build 幂等。容器内 sshd
# 监听 22，宿主侧端口由挂具随机分配（-p 127.0.0.1:<随机>:22）。
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
