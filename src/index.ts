export interface Env {
  GITHUB_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  RELEASE_STATE: KVNamespace;
  GITHUB_USERNAME?: string;
  USER_AGENT?: string;
  MAX_REPOS_PER_RUN?: string;
  CHECK_INTERVAL_MINUTES?: string;
}

type GitHubRepo = {
  full_name: string;
  html_url: string;
};

type GitHubRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
};

type CheckResult = {
  checkedRepos: number;
  notified: number;
  errors: string[];
};

const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_MAX_REPOS_PER_RUN = 300;
const DEFAULT_CHECK_INTERVAL_MINUTES = 60;
const CHECK_STATE_KEY = "scheduler:last-checked-at";

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledCheck(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/check") {
      const authHeader = request.headers.get("authorization");
      const expected = env.GITHUB_TOKEN ? `Bearer ${env.GITHUB_TOKEN}` : "";
      if (!expected || authHeader !== expected) {
        return json({ error: "Unauthorized" }, 401);
      }

      const result = await checkStarredRepoReleases(env);
      return json(result);
    }

    return json({ error: "Not found" }, 404);
  },
};

async function runScheduledCheck(env: Env): Promise<CheckResult> {
  const intervalMinutes = parsePositiveInt(env.CHECK_INTERVAL_MINUTES, DEFAULT_CHECK_INTERVAL_MINUTES);
  const now = Date.now();
  const lastCheckedAt = await env.RELEASE_STATE.get(CHECK_STATE_KEY);

  if (lastCheckedAt && now - Number.parseInt(lastCheckedAt, 10) < intervalMinutes * 60 * 1000) {
    return { checkedRepos: 0, notified: 0, errors: [] };
  }

  const result = await checkStarredRepoReleases(env);
  await env.RELEASE_STATE.put(CHECK_STATE_KEY, String(now));
  return result;
}

async function checkStarredRepoReleases(env: Env): Promise<CheckResult> {
  assertRequiredEnv(env);

  const result: CheckResult = { checkedRepos: 0, notified: 0, errors: [] };
  const maxRepos = parsePositiveInt(env.MAX_REPOS_PER_RUN, DEFAULT_MAX_REPOS_PER_RUN);
  const repos = await listStarredRepos(env, maxRepos);

  for (const repo of repos) {
    try {
      result.checkedRepos += 1;
      const latestRelease = await getLatestRelease(env, repo.full_name);
      if (!latestRelease || latestRelease.draft) {
        continue;
      }

      const stateKey = `release:${repo.full_name}`;
      const previousReleaseId = await env.RELEASE_STATE.get(stateKey);
      const currentReleaseId = String(latestRelease.id);

      if (!previousReleaseId) {
        await env.RELEASE_STATE.put(stateKey, currentReleaseId);
        continue;
      }

      if (previousReleaseId !== currentReleaseId) {
        await sendTelegramMessage(env, formatTelegramMessage(repo, latestRelease));
        await env.RELEASE_STATE.put(stateKey, currentReleaseId);
        result.notified += 1;
      }
    } catch (error) {
      result.errors.push(`${repo.full_name}: ${errorToMessage(error)}`);
    }
  }

  return result;
}

function assertRequiredEnv(env: Env): void {
  const missing = ["GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].filter(
    (key) => !env[key as keyof Env],
  );

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

async function listStarredRepos(env: Env, maxRepos: number): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;

  while (repos.length < maxRepos) {
    const endpoint = env.GITHUB_USERNAME
      ? `/users/${encodeURIComponent(env.GITHUB_USERNAME)}/starred`
      : "/user/starred";
    const url = new URL(`https://api.github.com${endpoint}`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const batch = await githubFetch<GitHubRepo[]>(env, url.toString());
    if (batch.length === 0) {
      break;
    }

    repos.push(...batch);
    page += 1;
  }

  return repos.slice(0, maxRepos);
}

async function getLatestRelease(env: Env, fullName: string): Promise<GitHubRelease | null> {
  const url = `https://api.github.com/repos/${fullName}/releases/latest`;
  const response = await fetch(url, { headers: githubHeaders(env) });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub latest release request failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as GitHubRelease;
}

async function githubFetch<T>(env: Env, url: string): Promise<T> {
  const response = await fetch(url, { headers: githubHeaders(env) });
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as T;
}

function githubHeaders(env: Env): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": env.USER_AGENT || "github-star-release-telegram-worker",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

async function sendTelegramMessage(env: Env, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      disable_web_page_preview: false,
      parse_mode: "HTML",
      text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram request failed: ${response.status} ${await response.text()}`);
  }
}

function formatTelegramMessage(repo: GitHubRepo, release: GitHubRelease): string {
  const title = release.name || release.tag_name;
  const prereleaseLabel = release.prerelease ? " (pre-release)" : "";

  return [
    "🚀 GitHub Star 项目有新 Release",
    `项目：<a href="${escapeHtml(repo.html_url)}">${escapeHtml(repo.full_name)}</a>`,
    `版本：<a href="${escapeHtml(release.html_url)}">${escapeHtml(title)}</a>${prereleaseLabel}`,
    `发布时间：${escapeHtml(release.published_at)}`,
  ].join("\n");
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
