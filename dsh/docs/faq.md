# FAQ

## 关掉 dsh 窗口/进程，历史对话会消失吗？

**不会。** dsh 的会话是服务端持久化的：

- 每个会话在 `~/.dsh/sessions/<工作区>/session-<id>/` 下有仅追加的会话日志（默认 `session.v4.jsonl.zstd`，每批 append 后 `fsync`，官方 JSONL 后端每个批次即时持久化）。
- 关掉浏览器标签页：dsh 进程还在，会话不受影响（但会中断当前正在流式输出的那一轮）。
- 关掉终端 / kill 掉 dsh：已提交的对话都在磁盘上；下次在同一台 VM、同一用户、同一工作目录运行 `dsh`，侧边栏能看到并继续历史会话。
- 中断瞬间正在生成的那一轮：已提交前缀保留，不完整的尾部由恢复逻辑处理（丢弃撕裂帧/补 closer），最多丢当前未提交部分。
- 从未发过消息的空会话可能不落盘（会话是惰性实体化的），属正常。

### 会丢的情况

- 在 GUI 里删除会话，或手动 `rm -rf ~/.dsh/sessions`；
- 用户 home 被清空/VM 被重置重建；
- 换一台 VM：`~/.dsh` 在各自的本地 home（不是共享 NFS），**132 和 133 的历史互相看不到**；
- `dsh` 的工作区不同（在不同目录启动）时，会话按工作区分组展示。

### 数据位置

```
~/.dsh/
├── sessions/<工作区>/session-<id>/session.v4.jsonl.zstd   # 对话历史（仅追加）
├── sessions/<工作区>/session-<id>/session.lock            # 写锁
├── storages/session_projcache/                            # 投影缓存（可重建）
├── profiles/                                              # web/headless profile
├── attachments/                                           # 图片等附件（单独文件，日志只存引用）
└── .credentials.yaml                                      # 本机凭据（600）
```

> 若要跨 VM 保留历史，需要额外做 `~/.dsh` 的同步/备份，且不要把同一个 `~/.dsh` 同时给多台机器并发写（有 per-session 写锁，可能冲突）。

## 普通用户会通过 dsh 拿到 root 吗？

不会。dsh 以调用者身份运行（实测 agent 的 `id -u` 是普通用户 UID），启动器无 setuid、无 sudo，安装目录普通用户不可写；默认 bubblewrap 沙箱里 setuid 程序（sudo）不可用。用户本身若有 sudo，那是系统给的权限，与 dsh 无关；不要用 `sudo dsh` 启动。

## 模型 Key 会泄露吗？

真实 DeepSeek Key 只在 Open WebUI 后台；用户可见的是内网 OWUI 的共享 Key（`/eda/apps/deepseek/etc/dsh.env`，644）。详见 `security.md`。
