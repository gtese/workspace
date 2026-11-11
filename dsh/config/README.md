# 配置说明

| 文件 | 用途 |
|---|---|
| `dsh.env.example` | 共享配置模板。真实文件部署在 `/eda/apps/deepseek/etc/dsh.env`（644），**不要提交真实 key** |
| `pki/tri-enterprise-root.pem` | 公司内部根证书（公开证书），用于 Node 访问 `*.tri.local` |

真实配置结构：

```sh
export DEEPSEEK_BASE_URL=https://chat.tri.local/api
export DEEPSEEK_API_KEY=sk-<共享的 Open WebUI API Key>
```

用户可在 `~/.config/dsh/env` 用同样格式覆盖（600 权限），例如换用自己的 OWUI key。
