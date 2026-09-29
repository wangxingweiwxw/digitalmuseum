# 绘本数字博物馆

8 座博物馆，每馆 1 页概览 + 10 页展品或专题，共 88 页。支持树形目录、热点跳转、左右和上下滑动翻页，配有展品简介和知乎延伸阅读。

## Cloudflare 部署

Worker 名称：`digitalmuseum`。R2 桶名：`digitalmuseum-exhibits`。

网站代码托管在 GitHub；88 张展品图片从本地上传到 R2，GitHub 构建以 `worker/exhibit-manifest.json` 图片索引为准，无需上传图片。网页资源构建到 `dist/`，不会上传 `.git` 历史包。

Cloudflare Workers Builds 构建命令为 `npm run build`，部署命令为 `npm run deploy`。删除部署命令中的 `--assets .`。首次上线前需要创建 R2 桶并上传图片。

具体操作见 [Cloudflare 部署说明](CLOUDFLARE.md)。图片、桶和线上部署是否就绪，需以实际 Cloudflare 验证为准。

## 本地检查

```sh
npm ci
npm test
npm run build
npx wrangler deploy --dry-run
```

GitHub 克隆包含网页和图片索引，可能仅有部分旧图片；如需离线预览或上传图片，请使用包含完整 `assets/images/exhibits/` 的本地项目副本。展品配图为绘本示意，不能作为文物实物照片或精确复原图。

## 知乎登录

已实现知乎登录入口、服务端授权回调、账号展示和退出；回调为 `https://museum.chipai.cc/zhihu-callback`，App ID 为 `851`。App Key 使用 Cloudflare Secret，会话使用 SQLite Durable Objects。

配置和上线验收见 [知乎 OAuth 接入说明](ZHIHU-OAUTH.md)。本地测试使用模拟授权，真实知乎登录仍需上线联调，并确认平台回传 `state`；缺少该参数的回调会被拒绝。
