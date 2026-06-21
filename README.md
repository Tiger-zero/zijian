# GitHub Star Release Telegram Worker

一个部署在 Cloudflare Workers 上的定时任务：周期性检查你 GitHub 已 Star 项目的最新 Release；当某个项目的最新 Release 发生变化时，通过 Telegram Bot 推送消息。

## 工作方式

- Cloudflare Cron Trigger 默认每 5 分钟唤醒一次 Worker。
- Worker 会读取环境变量 `CHECK_INTERVAL_MINUTES`，只有到达你配置的检查周期后才真正请求 GitHub。
- Worker 使用 GitHub API 拉取当前账号或指定用户的 starred repositories。
- Worker 逐个查询仓库的 latest release。
- Worker 使用 Cloudflare KV 保存每个仓库上一次见到的 release id，以及上一次实际检查时间。
- 如果 release id 变化，则调用 Telegram Bot API 发送消息。

首次运行只会初始化 KV 状态，不会把所有已有 Release 都推送一遍，避免刷屏。

## 必填环境变量

| 变量 | 建议类型 | 说明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | Secret | GitHub token，用于读取 Star 列表和 Release 信息。 |
| `TELEGRAM_BOT_TOKEN` | Secret | Telegram BotFather 给你的机器人密钥。 |
| `TELEGRAM_CHAT_ID` | Secret | 接收消息的 Telegram 私聊、群组或频道 chat id。 |

## 可选环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CHECK_INTERVAL_MINUTES` | `60` | 实际检查周期，单位分钟。例如 `10` 表示每 10 分钟检查一次。 |
| `MAX_REPOS_PER_RUN` | `300` | 每次最多检查多少个 Star 项目。 |
| `GITHUB_USERNAME` | 空 | 不设置时检查 token 所属账号的 Star；设置后检查该公开用户的 Star。 |
| `USER_AGENT` | `github-star-release-telegram-worker` | GitHub API User-Agent。 |

> 注意：Cloudflare Cron Trigger 本身不能直接由运行时环境变量动态改变。因此 `wrangler.toml` 使用较频繁的 `*/5 * * * *` 唤醒 Worker，再由 `CHECK_INTERVAL_MINUTES` 控制实际检查频率。修改 `CHECK_INTERVAL_MINUTES` 后不需要改代码。

## 准备

1. 创建 GitHub fine-grained token 或 classic token。
   - 查询自己的 Star：需要可访问 `GET /user/starred`。
   - 查询公开用户的 Star：也可以设置 `GITHUB_USERNAME`，使用 `GET /users/{username}/starred`。
2. 在 Telegram 中通过 BotFather 创建 Bot，获得 Bot Token，并配置为 `TELEGRAM_BOT_TOKEN`。
3. 获取 Telegram `chat_id`，并配置为 `TELEGRAM_CHAT_ID`：可以给 Bot 发一条消息后访问 `https://api.telegram.org/bot<token>/getUpdates` 查看。
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

设置必填 Secret：

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

如果你希望通过 Cloudflare Dashboard 配置，也可以在 Worker 的 **Settings → Variables** 中添加上面三个变量，并勾选 **Encrypt**。

设置可选变量。`CHECK_INTERVAL_MINUTES` 和 `MAX_REPOS_PER_RUN` 已在 `wrangler.toml` 的 `[vars]` 中提供默认值，也可以在 Dashboard 中覆盖：

```bash
npx wrangler secret put GITHUB_USERNAME
```

示例：把实际检查周期改成 10 分钟：

```toml
[vars]
CHECK_INTERVAL_MINUTES = "10"
MAX_REPOS_PER_RUN = "300"
```

## 部署

```bash
npm run deploy
```

`wrangler.toml` 默认每 5 分钟唤醒一次 Worker，实际检查周期由 `CHECK_INTERVAL_MINUTES` 决定：

```toml
[triggers]
crons = ["*/5 * * * *"]

[vars]
CHECK_INTERVAL_MINUTES = "60"
```

## 手动触发检查

部署后可以调用 `/check` 手动触发一次检查。为了避免被公开调用，请求需要带上和 `GITHUB_TOKEN` 相同的 Bearer token。手动检查会立即执行，不受 `CHECK_INTERVAL_MINUTES` 限制：

```bash
curl -H "Authorization: Bearer <GITHUB_TOKEN>" https://<your-worker>.<your-subdomain>.workers.dev/check
```

健康检查：

```bash
curl https://<your-worker>.<your-subdomain>.workers.dev/health
```
