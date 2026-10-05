# Deployment Guide

推荐使用 `npm run setup`。以下内容解释脚本执行的步骤和手工恢复方式。

## 1. Cloudflare resources

安装脚本会创建：

- 一个 Worker
- 一个 D1 数据库，binding 为 `JOB_FEED_DB`
- 一个非公开 R2 Bucket，binding 为 `JOB_FEED_RESUMES`

生成的 `.jobfeed/wrangler.generated.jsonc` 和 `.jobfeed/setup-state.json` 被 Git 忽略。脚本可重复运行；已有资源 ID 会被复用。

首次启用 R2 时 Cloudflare 会要求确认按量订阅。当前页面会显示免费额度，但超额可能计费；确认前请检查账户付款方式与最新价格。

## 2. Auth0

在 Auth0 创建 API：

- Identifier：安装脚本显示的完整 `https://...workers.dev/mcp`
- Signing Algorithm：RS256
- Permissions：`jobfeed:read`、`jobfeed:write`、`jobfeed:resume`

创建供 ChatGPT 使用的 OAuth Application。把 ChatGPT 插件连接页面显示的 callback URL 填入 Auth0 Allowed Callback URLs 和 Allowed Web Origins。将本人 Auth0 `user_id` 作为 `ALLOWED_USER_SUB` Worker secret。

MCP resource、Auth0 API Identifier 和 JWT audience 必须完全一致。修改 scopes 后需要在 ChatGPT 中重新授权。

## 3. ChatGPT

1. 创建私人远程 MCP server，URL 使用 `/mcp`。
2. 选择 OAuth，填入 Auth0 Client ID/Secret 和三个 scopes。
3. 连接后调用 `get_onboarding_state`。
4. 上传简历、检查画像并确认。
5. 在 Settings 保存推送设置，让 ChatGPT 创建每个 slot 对应的 Scheduled Task。

每个任务使用稳定名称 `Personal Job Feed · <slot_id>`。插件设置保存与 Scheduled Task 实际同步是两个状态，只有任务全部更新成功后才调用 `mark_schedule_synced`。

## 4. Existing installations

升级前建议从 Cloudflare 控制台确认 D1 Time Travel 可用。然后执行：

```bash
npm run upgrade
```

迁移会保留 Saved、已投、不感兴趣、备注和历史 feed，将旧版个人匹配字段复制到 `user_job_match`，并保留旧工具名作为兼容入口。

如果尚未创建 R2：

```bash
npx wrangler r2 bucket create <worker-name>-resumes
```

确保生成配置中的 bucket name 一致，再执行 `npm run upgrade`。

## 5. Diagnostics

```bash
npm run doctor
curl https://<worker>.workers.dev/health
curl https://<worker>.workers.dev/.well-known/oauth-protected-resource/mcp
```

`doctor` 会验证 Node 版本、Wrangler 登录、线上健康状态、OAuth resource 和 Auth0 discovery。
