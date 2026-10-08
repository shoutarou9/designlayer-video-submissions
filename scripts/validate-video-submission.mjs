import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const FOLDER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_DURATION_SEC = 60;
const MAX_LOGO_BYTES = 1024 * 1024;
const ASPECT = 16 / 9;
const ASPECT_TOLERANCE = 0.02;
const CONSENT = "この動画・プロンプト・ロゴの権利を自分が持っていることを確認しました。";
const ALLOWED_FILES = new Set(["video.mp4", "prompt.txt", "meta.json", "logo.png"]);

const baseRef = process.env.BASE_REF;
const prBody = process.env.PR_BODY ?? "";
const errors = [];

function fail(message) {
  errors.push(message);
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" });
}

if (!prBody.includes(CONSENT)) {
  fail("プルリクエスト本文に、権利確認の文を残してください。");
}

let changed = [];
try {
  changed = run("git", ["diff", "--name-only", "--diff-filter=AMDR", `origin/${baseRef}...HEAD`])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const submissionPaths = changed.filter((file) => file.startsWith("submissions/"));
if (submissionPaths.length === 0) {
  console.log("submissions/ の変更はありません。");
  process.exit(0);
}

let existing = [];
try {
  existing = run("git", ["ls-tree", "-d", "--name-only", `origin/${baseRef}`, "submissions"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
} catch {
  existing = [];
}
const existingNames = new Set(existing.map((folder) => path.posix.basename(folder)));

const folders = new Set();
for (const file of submissionPaths) {
  const parts = file.split("/");
  if (parts.length !== 3 || parts[0] !== "submissions") {
    fail(`置ける場所は submissions/<フォルダ名>/ の直下だけです: ${file}`);
    continue;
  }
  const folderName = parts[1];
  const fileName = parts[2];
  if (!FOLDER_NAME.test(folderName)) {
    fail(`フォルダ名は小文字の英数字とハイフンだけです: ${folderName}`);
  }
  if (!ALLOWED_FILES.has(fileName)) {
    fail(`使えないファイルです: ${file}`);
  }
  if (existingNames.has(folderName)) {
    fail(`同じフォルダ名がすでにあります: ${folderName}`);
  }
  folders.add(folderName);
}

for (const folderName of folders) {
  if (!FOLDER_NAME.test(folderName) || existingNames.has(folderName)) continue;
  const folder = path.join("submissions", folderName);
  const required = ["video.mp4", "prompt.txt", "meta.json"];
  for (const fileName of required) {
    try {
      statSync(path.join(folder, fileName));
    } catch {
      fail(`${folderName} に ${fileName} がありません。`);
    }
  }

  const promptPath = path.join(folder, "prompt.txt");
  try {
    if (!readFileSync(promptPath, "utf8").trim()) {
      fail(`${folderName} のプロンプトが空です。`);
    }
  } catch {
    // required check already reported
  }

  const metaPath = path.join(folder, "meta.json");
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    for (const key of ["title", "description", "authorName"]) {
      if (typeof meta[key] !== "string" || !meta[key].trim()) {
        fail(`${folderName} の meta.json に ${key} を書いてください。`);
      }
    }
    if (typeof meta.email === "string" && meta.email.trim()) {
      fail(`${folderName} の meta.json にメールアドレスは書かないでください。`);
    }
    if (meta.x != null && meta.x !== "") {
      if (typeof meta.x !== "string" || !/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/.test(meta.x)) {
        fail(`${folderName} の meta.json の x は https://x.com/ユーザー名 にしてください。`);
      }
    }
    if (meta.website != null && meta.website !== "") {
      try {
        const site = new URL(meta.website);
        if (site.protocol !== "https:" && site.protocol !== "http:") {
          fail(`${folderName} の meta.json の website は http か https の URL にしてください。`);
        }
      } catch {
        fail(`${folderName} の meta.json の website は http か https の URL にしてください。`);
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${folderName} の meta.json が JSON ではありません。`);
  }

  const logoPath = path.join(folder, "logo.png");
  try {
    const logo = statSync(logoPath);
    if (logo.size > MAX_LOGO_BYTES) fail(`${folderName} のロゴは 1MB 以内にしてください。`);
    const header = readFileSync(logoPath).subarray(0, 8);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!header.equals(png)) fail(`${folderName} のロゴは PNG にしてください。`);
  } catch {
    // logo is optional
  }

  const videoPath = path.join(folder, "video.mp4");
  let videoStat = null;
  try {
    videoStat = statSync(videoPath);
  } catch {
    videoStat = null;
  }
  if (videoStat) {
    if (videoStat.size > MAX_VIDEO_BYTES) fail(`${folderName} の動画は 50MB 以内にしてください。`);
    try {
    const probe = JSON.parse(
      run("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "format=format_name,duration:stream=width,height,codec_name,sample_aspect_ratio",
        "-of",
        "json",
        videoPath,
      ]),
    );
    const formatName = probe.format?.format_name ?? "";
    if (!formatName.split(",").includes("mp4")) {
      fail(`${folderName} の動画は MP4 にしてください。`);
    }
    const duration = Number(probe.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SEC + 0.05) {
      fail(`${folderName} の動画は 60 秒以内にしてください。`);
    }
    const stream = probe.streams?.[0];
    if (stream?.codec_name !== "h264") {
      fail(`${folderName} の動画は H.264 にしてください。`);
    }
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    const [sarW, sarH] = String(stream?.sample_aspect_ratio || "1:1").split(":").map(Number);
    const sar = sarW > 0 && sarH > 0 ? sarW / sarH : 1;
    if (!(width > 0 && height > 0) || Math.abs((width * sar) / height - ASPECT) > ASPECT_TOLERANCE) {
      fail(`${folderName} の動画は 16:9 にしてください。`);
    }
    } catch {
      fail(`${folderName} の動画を確認できませんでした。`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("提出内容を確認しました。");
