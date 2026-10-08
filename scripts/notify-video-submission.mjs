const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const prNumber = process.env.PR_NUMBER;
const headSha = process.env.HEAD_SHA;
const prUrl = process.env.PR_URL;
const prTitle = process.env.PR_TITLE || "(無題)";
const prUser = process.env.PR_USER || "(不明)";
const resendKey = process.env.RESEND_API_KEY?.trim();
const notifyTo = process.env.CONTACT_NOTIFY_EMAIL?.trim() || "support@design-layer.com";
const from = process.env.CONTACT_FROM_EMAIL?.trim() || "DesignLayer <support@design-layer.com>";

if (!repository || !token || !prNumber || !headSha || !prUrl) {
  console.error("GitHub のイベント情報が足りません。");
  process.exit(1);
}

if (!resendKey) {
  console.error("RESEND_API_KEY が未設定です。リポジトリの Actions secrets に追加してください。");
  process.exit(1);
}

const [owner, repo] = repository.split("/");

async function github(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} ${pathname}`);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readField(meta, keys) {
  for (const key of keys) {
    const value = meta?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function listPullFiles() {
  const files = [];
  for (let page = 1; page <= 5; page += 1) {
    const chunk = await github(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    );
    files.push(...chunk);
    if (chunk.length < 100) break;
  }
  return files.map((file) => file.filename).filter((name) => name.startsWith("submissions/"));
}

async function readJsonAt(filePath) {
  const encoded = filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const ref = encodeURIComponent(`refs/pull/${prNumber}/head`);
  const payload = await github(`/repos/${owner}/${repo}/contents/${encoded}?ref=${ref}`);
  if (!payload.content) return null;
  return JSON.parse(Buffer.from(payload.content, "base64").toString("utf8"));
}

const paths = await listPullFiles();
const folders = [
  ...new Set(
    paths
      .map((name) => name.split("/").slice(0, 2).join("/"))
      .filter((folder) => folder.split("/").length === 2 && folder !== "submissions"),
  ),
];

const entries = [];
for (const folder of folders) {
  let meta = null;
  if (paths.includes(`${folder}/meta.json`)) {
    try {
      meta = await readJsonAt(`${folder}/meta.json`);
    } catch (error) {
      console.error(`meta.json を読めませんでした: ${folder}`, error);
    }
  }
  entries.push({
    folder,
    title: readField(meta, ["title"]) || folder.split("/")[1],
    description: readField(meta, ["description"]),
    author: readField(meta, ["authorName"]),
    hasVideo: paths.includes(`${folder}/video.mp4`),
    hasPrompt: paths.includes(`${folder}/prompt.txt`),
    hasLogo: paths.includes(`${folder}/logo.png`),
  });
}

const lines = [
  "動画の提出プルリクエストが届きました。",
  "",
  `プルリクエスト: ${prTitle}`,
  `GitHub: ${prUser}`,
  `URL: ${prUrl}`,
  "",
];

if (entries.length === 0) {
  lines.push("submissions/ にフォルダはまだありません。");
} else {
  for (const entry of entries) {
    lines.push(`--- ${entry.folder} ---`);
    lines.push(`タイトル: ${entry.title}`);
    if (entry.author) lines.push(`投稿者名: ${entry.author}`);
    lines.push(`動画: ${entry.hasVideo ? "あり" : "なし"}`);
    lines.push(`プロンプト: ${entry.hasPrompt ? "あり" : "なし"}`);
    lines.push(`ロゴ: ${entry.hasLogo ? "あり" : "なし"}`);
    if (entry.description) {
      lines.push("説明:");
      lines.push(entry.description);
    }
    lines.push("");
  }
}

const text = lines.join("\n");
const subject = `[DesignLayer] 動画の提出: ${prTitle}`;
const html = `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(text)}</pre>`;
const resendTestFrom = "DesignLayer <onboarding@resend.dev>";

async function sendEmail(fromAddress, toAddress) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [toAddress],
      subject,
      text,
      html,
    }),
  });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
}

function testingRecipient(body) {
  const match = body.match(/your own email address \(([^)]+)\)/);
  return match?.[1]?.trim() ?? "";
}

let sent = await sendEmail(from, notifyTo);
if (!sent.ok && sent.status === 403 && sent.body.includes("domain is not verified")) {
  console.error(
    "送信元ドメインが Resend で未確認のため、確認用アドレスから送り直します。",
  );
  sent = await sendEmail(resendTestFrom, notifyTo);
}

if (!sent.ok) {
  const accountEmail = testingRecipient(sent.body);
  if (accountEmail && accountEmail !== notifyTo) {
    console.error(
      "ドメイン未確認のあいだは Resend の登録メールにだけ送れます。そちらへ送り直します。",
    );
    sent = await sendEmail(resendTestFrom, accountEmail);
  }
}

if (!sent.ok) {
  console.error("メール送信に失敗しました", sent.status, sent.body);
  process.exit(1);
}

const result = JSON.parse(sent.body);
console.log("メールを送信しました", result.id, notifyTo);
