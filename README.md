# GitHub Star Release Telegram Worker

一个部署在 Cloudflare Workers 上的定时任务：周期性检查你 GitHub 已 Star 项目的最新 Release；当某个项目的最新 Release 发生变化时，通过 Telegram Bot 推送消息。

## 工作方式

- Cloudflare Cron Trigger 每小时触发一次 Worker。
- Worker 使用 GitHub API 拉取当前账号或指定用户的 starred repositories。
- Worker 逐个查询仓库的 latest release。
- Worker 使用 Cloudflare KV 保存每个仓库上一次见到的 release id。
- 如果 release id 变化，则调用 Telegram Bot API 发送消息。

首次运行只会初始化 KV 状态，不会把所有已有 Release 都推送一遍，避免刷屏。

## 准备

1. 创建 GitHub fine-grained token 或 classic token。
   - 查询自己的 Star：需要可访问 `GET /user/starred`。
   - 查询公开用户的 Star：也可以设置 `GITHUB_USERNAME`，使用 `GET /users/{username}/starred`。
2. 在 Telegram 中通过 BotFather 创建 Bot，获得 Bot Token。
3. 获取 Telegram `chat_id`：可以给 Bot 发一条消息后访问 `https://api.telegram.org/bot<token>/getUpdates` 查看。
4. 安装依赖：

   ```bash
   npm install
   ```

## 配置 Cloudflare

创建 KV namespace：

```bash
npx wrangler kv namespace create RELEASE_STATE
```

把输出的 namespace id 填入 `wrangler.toml` 的 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`。

设置 Worker secrets：

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

可选变量：

```bash
npx wrangler secret put GITHUB_USERNAME
npx wrangler secret put MAX_REPOS_PER_RUN
```

- `GITHUB_USERNAME`：不设置时检查 token 所属账号的 Star；设置后检查该公开用户的 Star。
- `MAX_REPOS_PER_RUN`：每次最多检查多少个 Star 项目，默认 `300`。

## 部署

```bash
npm run deploy
```

`wrangler.toml` 默认配置为每小时执行一次：

```toml
[triggers]
crons = ["0 * * * *"]
```

## 手动触发检查

部署后可以调用 `/check` 手动触发一次检查。为了避免被公开调用，请求需要带上和 `GITHUB_TOKEN` 相同的 Bearer token：

```bash
curl -H "Authorization: Bearer <GITHUB_TOKEN>" https://<your-worker>.<your-subdomain>.workers.dev/check
```

健康检查：

```bash
curl https://<your-worker>.<your-subdomain>.workers.dev/health
```
