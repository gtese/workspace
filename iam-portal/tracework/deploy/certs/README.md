# 证书放置说明

本目录用于存放 TLS 证书。**私钥文件不纳入版本库**（见仓库根目录 `.gitignore`），
需要在部署主机上单独放置。

## 需要准备的文件

| 文件名 | 内容 | 是否入库 |
|---|---|---|
| `man.tri.local.crt` | `*.tri.local` 通配证书完整链（fullchain） | 可选（公钥） |
| `man.tri.local.key` | 通配证书私钥 | **绝不入库** |
| `tri.local_ca.crt` | 企业根 CA 证书（用于校验与信任链） | 可选（公钥） |

> 文件名沿用 `man.tri.local` 是历史命名，实际内容是 `*.tri.local` 通配证书，
> 同时覆盖 `work.tri.local` 与 `man.tri.local`。

## 放置步骤

在部署主机上执行：

```bash
cd /opt/rnd-timesheet/deploy/certs

# 1. 从域控/IT 取得证书文件，放置到本目录
#    - 通配证书 fullchain: man.tri.local.crt
#    - 通配证书私钥:      man.tri.local.key
#    - 企业根 CA:         tri.local_ca.crt

# 2. 设置私钥权限（必须）
chmod 600 man.tri.local.key
chmod 644 man.tri.local.crt tri.local_ca.crt

# 3. 校验证书与私钥是否匹配
crt_mod=$(openssl x509 -noout -modulus -in man.tri.local.crt | openssl md5)
key_mod=$(openssl rsa  -noout -modulus -in man.tri.local.key | openssl md5)
[ "$crt_mod" = "$key_mod" ] && echo "✓ 匹配" || echo "✗ 不匹配"

# 4. 查看有效期
openssl x509 -noout -subject -dates -in man.tri.local.crt
```

## 安装到系统

`deploy.sh install` 会自动完成证书安装：

```bash
sudo bash /opt/rnd-timesheet/deploy/deploy.sh install
```

它会：
1. 复制证书到 `/etc/pki/tls/certs/` 与 `/etc/pki/tls/private/`
2. 把企业根 CA 安装到系统信任库（`update-ca-trust`）
3. 校验证书与私钥匹配
4. 配置 nginx 并 reload

## 证书续期

证书到期前（当前至 2028-10-21）替换：

```bash
cd /opt/rnd-timesheet/deploy/certs
cp 新证书 man.tri.local.crt
cp 新私钥 man.tri.local.key
chmod 600 man.tri.local.key

sudo bash /opt/rnd-timesheet/deploy/deploy.sh install
```

## 常见问题

**Q: 仓库里没有私钥，新机器部署会失败吗？**

会。这是有意的安全设计。私钥属于高敏凭据，不应随代码分发。
新环境部署时需从 IT 或密钥管理系统单独获取。

**Q: 可以用自签名证书测试吗？**

可以，但需修改 `deploy/nginx-man.tri.local.conf` 中的证书路径，
且客户端会告警。生产环境必须使用域控签发的证书。