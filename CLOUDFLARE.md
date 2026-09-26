# Cloudflare Workers + R2 部署

本次报错来自把仓库根目录作为静态资源目录：208 MiB 的 `.git/objects/pack/*.pack` 被上传，超过 Workers 单文件 25 MiB 限制。它是 Git 历史文件，不是网站图片。不要把 `.git` 上传到 R2。

当前配置只发布构建生成的 `dist/`：15 个网页资源约 626 KB；88 张展品图片约 74.8 MB 通过私有 R2 桶提供。页面继续使用原有 `/assets/images/exhibits/...` 地址，Worker 在服务端读取 R2，不需要公开桶、配置图片域名或在前端放密钥。GitHub 构建以已提交的 `worker/exhibit-manifest.json` 索引为准，无需提交图片；即使仓库已有部分旧图片，也不会覆盖索引或进入静态资源包。本机保留完整图片供上传和离线使用。

## 首次部署

需要 Node.js 22 或更高版本、已启用 R2 的 Cloudflare 账户。这里的配置和脚本已经准备好，尚未创建远程桶或发布 Worker。

1. `wrangler.jsonc` 已对应 GitHub 仓库 `wangxingweiwxw/digitalmuseum`：Worker 名称为 `digitalmuseum`；R2 桶名为 `digitalmuseum-exhibits`。如果使用已有的其他桶，请修改 `r2_buckets[0].bucket_name`。
2. 在项目根目录运行：

```powershell
npm ci
npx wrangler login
npx wrangler r2 bucket create digitalmuseum-exhibits
npm run r2:plan
npm run deploy:r2
```

桶名若已修改，创建命令使用修改后的名称；已有桶则跳过创建。`deploy:r2` 先上传全部图片，成功后才发布 Worker，任何上传失败都会停止。重复上传使用相同内容哈希键，修改过的图片使用新键，旧版本图片不会被覆盖。脚本不会删除桶中的旧图片。

如果账户没有开通 R2，先在 Cloudflare 控制台开通；存储和读取按账户套餐计费。

## GitHub 自动部署设置

在 Cloudflare 项目的 Workers Builds 设置中，将根目录指向本项目所在目录，然后设置：

| 设置 | 值 |
| --- | --- |
| 构建命令 | `npm run build` |
| 部署命令 | `npm run deploy` |
| 静态资源目录 | 由 `wrangler.jsonc` 指定为 `./dist` |

删除原命令中的 `--assets .`、`--assets /opt/buildhome/repo` 等参数，否则会覆盖正确的目录配置。不要把仓库根目录作为静态资源目录；这里使用的是 Worker 项目，不是 Pages 项目。

把 `package.json`、`package-lock.json`、`wrangler.jsonc`、`worker/index.mjs`、`worker/exhibit-manifest.json`、Cloudflare 脚本、`.gitignore` 和 `.assetsignore` 连同 88 页网页文件提交到 GitHub。`dist/`、`node_modules/`、`.cloudflare/` 和 `assets/images/exhibits/` 不提交。只有网页资源会进入 `dist`。

自动构建使用的 Cloudflare API token 需要本账户的 **Workers Scripts Edit** 和 **Workers R2 Storage Edit** 权限，使用自定义域名路由时还需相应路由权限。在 Cloudflare 的构建设置中配置凭据；不要写入 GitHub 文件或聊天。若 CLI 不能确定账户，在构建环境设置 `CLOUDFLARE_ACCOUNT_ID`。

首次上线前，必须从包含全部图片的本地项目运行 `npm run r2:upload -- --remote`。每次换图后同样先从本机上传，再提交更新后的 `worker/exhibit-manifest.json` 和网页文件。GitHub 自动部署使用 `npm run deploy`，不重复上传图片；不要在不含图片的 GitHub 构建环境中使用 `deploy:r2`。

## 本地校验和预览

```powershell
npm test
npm run build
npx wrangler deploy --dry-run
npm run r2:upload -- --local
npm run dev
```

本地上传仅写入本地模拟 R2，不会修改线上桶。只运行 `npm run r2:upload` 默认展示计划，不执行上传；远程上传需传 `--remote`。

预览启动后，在另一个终端运行 `node scripts/verify-cloudflare.mjs http://127.0.0.1:8787`，可检查 15 个网页资源、88 张图片的实际 HTTP 返回值与 SHA-256，并检查 HEAD、304 和私有文件路径的 404 响应。验证结果写入 `reports/cloudflare-verification.json`。也可以把参数改为已部署的 HTTPS 网址，验证线上版本。

构建只复制白名单网站文件，并在复制时检查 25 MiB 上限；`.git`、报告、压缩包和展品图片均不进入静态资源目录。根目录 `.assetsignore` 是额外防护，正确的 `./dist` 配置仍是必要条件。构建统计和上传清单可在本地 `.cloudflare/build-manifest.json` 查看。

图片返回 ETag、Last-Modified 和缓存头；浏览器缓存 5 分钟，边缘缓存一天。边缘缓存键包含图片哈希，更新部署不会混用旧图片。404 不会伪装成 HTML 页面。回退到旧 Worker 版本时，只要保留旧 R2 对象，旧图片仍然可用。

官方说明：[静态资源目录和忽略规则](https://developers.cloudflare.com/workers/static-assets/binding/)、[Worker 绑定 R2](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)。
