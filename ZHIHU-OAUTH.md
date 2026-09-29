# 知乎用户登录

应用 ID：`851`。已登记的回调地址必须精确保持为 `https://museum.chipai.cc/zhihu-callback`。App Key 只放在本地 `.dev.vars` 和 Cloudflare Secret 中，不提交 GitHub，不通过前端配置传递。

## 当前实现

- 首页“知乎登录”打开授权说明；用户主动确认后跳转知乎。
- Worker 在服务端交换授权码、请求 `https://openapi.zhihu.com/user`，建立随机会话。
- `AUTH_SESSIONS` 使用 SQLite Durable Objects，回调状态一次性原子消费，跨实例共享并自动过期清理。
- 浏览器仅收到 HttpOnly、Secure、SameSite=Lax 的随机会话 Cookie；服务端只保存用户基本资料及脱敏后的联系方式。完成本次登录后丢弃知乎 access token，不读取用户创作内容，不需要 Access Secret。
- 邮箱、手机字段可能为空，不影响登录。UID 在解析 JSON 时无损转为字符串。
- 退出只销毁本网站会话；尚无已确认的知乎撤销授权接口。会话有效期不超过知乎 token 有效期，最长 24 小时；过期后需用户主动重新登录。

## 发布步骤

当前 OAuth 修改建立在 Workers + R2 代码上。发布前核实原 R2 桶和全部 88 张图片已就绪，详见 `CLOUDFLARE.md`；本地预检通过不代表此前 R2 草稿已上线。

1. 登录正确的 Cloudflare 账户，确认 Worker `digitalmuseum` 已绑定 `museum.chipai.cc`。
2. 在该 Worker 的 **Settings → Variables and Secrets** 添加 Secret `ZHIHU_OAUTH_APP_KEY`，值使用邮件中的 App Key。本机已保存 `.dev.vars` 时，登录 Cloudflare 后运行 `node scripts/configure-zhihu-secret.mjs`，脚本通过标准输入上传密钥，不会把密钥放进命令行参数。也可以执行 `node node_modules/wrangler/bin/wrangler.js secret put ZHIHU_OAUTH_APP_KEY`，在提示中输入。
3. 提交代码，运行 `npm test`、`npm run build`、`npx wrangler deploy --dry-run`。部署使用 `npm run deploy`。`wrangler.jsonc` 会增加 `AUTH_SESSIONS` 绑定及首次 SQLite Durable Object 迁移；已有迁移标签必须保留。
4. Workers Builds 的构建命令使用 `npm run build`、部署命令使用 `npm run deploy`，移除 `--assets .`。生产 App Key 配置为运行时 Secret，不作为前端构建变量。
5. 从 `https://museum.chipai.cc` 点“知乎登录”，由用户本人完成知乎登录及授权；确认昵称、退出、会话过期、取消授权和手机页面表现。

只有登记域名可以完成登录。AI Works 若以第三方 iframe 展示本站，跨站 Cookie 限制可能影响会话；请在新标签页打开 `https://museum.chipai.cc` 完成登录，不将 Cookie 改为不安全的跨站默认值。

## 协议限制与验收边界

官方 Skill 的 `references/oauth.md` 记录历史回调不返回 `state`，并要求上线前确认该能力。本实现发送随机 `state` 并严格验证：缺少 state、Cookie 不匹配、过期、重复回调均拒绝，且不会调用 token 接口。没有“忽略 state”开关。如果真实回调仍不返回 state，请知乎开放平台确认并开启回传支持，再完成上线验收；不要通过关闭校验绕过。

回调接受 `authorization_code` 和兼容的 `code`；token 表单仍使用 `code`。可识别 `code: 20000` 成功响应及 data 包装。scope/PKCE/refresh token 未在当前资料定义，代码不编造参数或自动刷新流程。

用户基础信息契约来自官方 Skill 0.7.3 的 `hackathon-user-profile-api.md`。该文档明确标注通用邮件申请应用需以平台实际权限为准；应用 851 的真实响应仍需用户授权后联调。模型测试不会声称已经得到平台授权。

## 路由

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/api/auth/session` | GET | 查询登录状态与脱敏资料；不缓存 |
| `/api/auth/zhihu/start` | POST | 同源请求发起授权，设置短期关联 Cookie |
| `/zhihu-callback` | GET | 校验 state 并完成服务端登录；立即重定向移除 URL 授权码 |
| `/api/auth/logout` | POST | 同源退出，删除服务端会话及浏览器 Cookie |

本地 `.dev.vars` 只用于本机联调，已忽略 Git 且不进入 `dist`。不要上传该文件或带有 authorization_code、Cookie、用户 token 的网络抓包。日志无需记录回调查询参数。
