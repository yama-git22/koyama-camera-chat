import "dotenv/config";
import cron from "node-cron";
import Parser from "rss-parser";
import OpenAI from "openai";
import { App } from "@slack/bolt";
import { Client, GatewayIntentBits } from "discord.js";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const parser = new Parser({ timeout: 15000 });

const DISCORD_ENABLED = toBool(process.env.DISCORD_ENABLED, true);
const SLACK_ENABLED = toBool(process.env.SLACK_ENABLED, false);

const FEEDS = (process.env.NEWS_FEEDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (FEEDS.length === 0) {
  console.error("[CONFIG ERROR] NEWS_FEEDS is empty. Please set at least one RSS feed URL.");
  process.exit(1);
}

if (!DISCORD_ENABLED && !SLACK_ENABLED) {
  console.error("[CONFIG ERROR] Both DISCORD_ENABLED and SLACK_ENABLED are false.");
  process.exit(1);
}

if (DISCORD_ENABLED) {
  validateRequired(["DISCORD_TOKEN", "DISCORD_CHANNEL_ID"], "DISCORD");
}
if (SLACK_ENABLED) {
  validateRequired(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_CHANNEL_ID"], "SLACK");
}

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 8 * * *";
const TIMEZONE = process.env.TZ || "Asia/Tokyo";
const MAX_ITEMS = Number(process.env.MAX_NEWS_ITEMS || "12");
const RUN_ON_START = toBool(process.env.RUN_ON_START, false);

const DISCORD_CHAT_ENABLED = toBool(process.env.CHAT_ENABLED, true);
const DISCORD_CHAT_PREFIX = (process.env.CHAT_PREFIX || "news").trim();
const DISCORD_CHAT_CHANNEL_ID = process.env.CHAT_CHANNEL_ID?.trim() || null;

const SLACK_CHAT_ENABLED = toBool(process.env.SLACK_CHAT_ENABLED, true);
const SLACK_CHAT_PREFIX = (process.env.SLACK_CHAT_PREFIX || "news").trim();
const SLACK_CHAT_CHANNEL_ID = process.env.SLACK_CHAT_CHANNEL_ID?.trim() || null;
const SLACK_CAMERA_ENABLED = toBool(process.env.SLACK_CAMERA_ENABLED, true);
const SLACK_CAMERA_CHANNEL_ID = process.env.SLACK_CAMERA_CHANNEL_ID?.trim() || null;
const CAMERA_CAPTURE_TIME_MS = toPositiveInt(process.env.CAMERA_CAPTURE_TIME_MS, 1200);
const CAMERA_OUTPUT_DIR = (process.env.CAMERA_OUTPUT_DIR || "output/camera").trim();

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

let slackApp = null;
let isJobReady = false;
let hasRunOnStart = false;
let isCameraCaptureRunning = false;

async function start() {
  if (SLACK_ENABLED) {
    await startSlack();
  }

  if (DISCORD_ENABLED) {
    setupDiscordHandlers();
    await discordClient.login(process.env.DISCORD_TOKEN);
  } else {
    startSchedule();
  }
}

function setupDiscordHandlers() {
  discordClient.once("clientReady", async () => {
    console.log(`[DISCORD] Logged in as ${discordClient.user.tag}`);
    console.log(
      `[DISCORD] Chat: ${DISCORD_CHAT_ENABLED ? "enabled" : "disabled"} (prefix: '${DISCORD_CHAT_PREFIX}')`
    );
    startSchedule();

    if (RUN_ON_START && !hasRunOnStart) {
      hasRunOnStart = true;
      await runDailyNewsJob();
    }
  });

  discordClient.on("error", (err) => {
    console.error("[DISCORD ERROR]", err);
  });

  discordClient.on("messageCreate", async (message) => {
    if (!DISCORD_CHAT_ENABLED) return;
    if (!discordClient.user || message.author.bot) return;
    if (!message.inGuild()) return;
    if (DISCORD_CHAT_CHANNEL_ID && message.channelId !== DISCORD_CHAT_CHANNEL_ID) return;

    const raw = message.content?.trim() || "";
    const mentioned = message.mentions.has(discordClient.user.id);
    const prefixed = hasPrefix(raw, DISCORD_CHAT_PREFIX);
    if (!mentioned && !prefixed) return;

    let userText = raw;
    if (mentioned) {
      userText = userText.replace(new RegExp(`<@!?${discordClient.user.id}>`, "g"), "").trim();
    }
    if (prefixed) {
      userText = removePrefix(userText, DISCORD_CHAT_PREFIX);
    }
    if (!userText) userText = "こんにちは";

    try {
      await message.channel.sendTyping();
      const reply = await buildChatReply(userText, message.author.username, "Discord");
      for (const chunk of splitForMessage(reply)) {
        await message.reply(chunk);
      }
    } catch (err) {
      console.error("[DISCORD CHAT ERROR]", err);
      await message.reply("ごめん、今ちょっと調子悪かみたい。少ししてまた話しかけてみて。");
    }
  });
}

async function startSlack() {
  slackApp = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  });

  slackApp.event("app_mention", async ({ event, client, say }) => {
    const botUserId = await getSlackBotUserId(client);
    let userText = (event.text || "").replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
    if (!userText) userText = "こんにちは";
    if (isCameraCommand(userText)) {
      if (SLACK_CAMERA_CHANNEL_ID && event.channel !== SLACK_CAMERA_CHANNEL_ID) return;
      await handleSlackCameraCommand(event.channel, event.ts, event.user || "slack-user");
      return;
    }

    if (!SLACK_CHAT_ENABLED) return;
    if (SLACK_CHAT_CHANNEL_ID && event.channel !== SLACK_CHAT_CHANNEL_ID) return;

    const username = event.user || "slack-user";
    try {
      const reply = await buildChatReply(userText, username, "Slack");
      for (const chunk of splitForMessage(reply)) {
        await say({ text: chunk, thread_ts: event.ts });
      }
    } catch (err) {
      console.error("[SLACK CHAT ERROR]", err);
      await say({ text: "ごめん、今ちょっと調子悪かみたい。少ししてまた話しかけてみて。", thread_ts: event.ts });
    }
  });

  slackApp.message(async ({ message, say }) => {
    if (!message || message.subtype || !message.text) return;
    if (message.bot_id) return;
    const rawText = message.text.trim();
    const prefixed = hasPrefix(rawText, SLACK_CHAT_PREFIX);
    const prefixedText = prefixed ? removePrefix(rawText, SLACK_CHAT_PREFIX) : rawText;
    const cameraRequested = isCameraCommand(rawText) || (prefixed && isCameraCommand(prefixedText));

    if (cameraRequested) {
      if (SLACK_CAMERA_CHANNEL_ID && message.channel !== SLACK_CAMERA_CHANNEL_ID) return;
      await handleSlackCameraCommand(message.channel, message.ts, message.user || "slack-user");
      return;
    }

    if (!SLACK_CHAT_ENABLED) return;
    if (SLACK_CHAT_CHANNEL_ID && message.channel !== SLACK_CHAT_CHANNEL_ID) return;
    if (!prefixed) return;

    const userText = prefixedText || "こんにちは";
    const username = message.user || "slack-user";

    try {
      const reply = await buildChatReply(userText, username, "Slack");
      for (const chunk of splitForMessage(reply)) {
        await say({ text: chunk, thread_ts: message.ts });
      }
    } catch (err) {
      console.error("[SLACK CHAT ERROR]", err);
      await say({ text: "ごめん、今ちょっと調子悪かみたい。少ししてまた話しかけてみて。", thread_ts: message.ts });
    }
  });

  await slackApp.start();
  console.log("[SLACK] Socket mode app started");
  console.log(`[SLACK] Chat: ${SLACK_CHAT_ENABLED ? "enabled" : "disabled"} (prefix: '${SLACK_CHAT_PREFIX}')`);
  console.log(`[SLACK] Camera: ${SLACK_CAMERA_ENABLED ? "enabled" : "disabled"} (commands: 'camera', 'カメラ')`);
  if (SLACK_CAMERA_CHANNEL_ID) {
    console.log(`[SLACK] Camera channel: ${SLACK_CAMERA_CHANNEL_ID}`);
  }

  if (RUN_ON_START && !DISCORD_ENABLED && !hasRunOnStart) {
    hasRunOnStart = true;
    await runDailyNewsJob();
  }
}

function startSchedule() {
  if (isJobReady) return;
  isJobReady = true;

  console.log(`[JOB] Schedule: '${CRON_SCHEDULE}' (${TIMEZONE})`);
  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      await runDailyNewsJob();
    },
    { timezone: TIMEZONE }
  );
}

async function runDailyNewsJob() {
  const started = new Date();
  console.log(`[JOB] Start: ${started.toISOString()}`);

  try {
    const articles = await fetchRecentArticles(FEEDS, MAX_ITEMS);

    if (articles.length === 0) {
      await postMessageAll("### 今日のニュースまとめ\n\n直近24時間で取得できる記事がありませんでした。");
      console.log("[JOB] No recent articles");
      return;
    }

    const summary = await buildSummary(articles);
    await postMessageAll(summary);

    console.log(`[JOB] Posted summary with ${articles.length} article(s)`);
  } catch (err) {
    console.error("[JOB ERROR]", err);
    await postMessageAll("ニュースまとめの生成に失敗しました。ログを確認してください。");
  }
}

async function fetchRecentArticles(feedUrls, limit) {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const results = await Promise.allSettled(
    feedUrls.map(async (url) => {
      const feed = await parser.parseURL(url);
      return (feed.items || []).map((item) => {
        const rawDate = item.isoDate || item.pubDate || null;
        const dateMs = rawDate ? Date.parse(rawDate) : NaN;
        return {
          title: (item.title || "(無題)").trim(),
          link: item.link || "",
          source: feed.title || new URL(url).hostname,
          publishedAt: Number.isNaN(dateMs) ? null : new Date(dateMs),
        };
      });
    })
  );

  const all = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      all.push(...r.value);
      continue;
    }
    console.warn("[FEED WARN] Failed to parse feed:", r.reason?.message || r.reason);
  }

  const dedup = new Map();
  for (const item of all) {
    const key = item.link || `${item.source}:${item.title}`;
    if (!dedup.has(key)) dedup.set(key, item);
  }

  return [...dedup.values()]
    .filter((item) => {
      if (!item.publishedAt) return true;
      return item.publishedAt.getTime() >= oneDayAgo;
    })
    .sort((a, b) => {
      const aMs = a.publishedAt ? a.publishedAt.getTime() : 0;
      const bMs = b.publishedAt ? b.publishedAt.getTime() : 0;
      return bMs - aMs;
    })
    .slice(0, limit);
}

async function buildSummary(articles) {
  if (!openai) {
    return buildFallbackSummary(articles);
  }

  const inputText = articles
    .map((a, i) => {
      const dateLabel = a.publishedAt ? a.publishedAt.toISOString() : "日時不明";
      return `${i + 1}. [${a.source}] ${a.title} (${dateLabel})\n${a.link}`;
    })
    .join("\n\n");

  const todayJst = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "full",
    timeZone: TIMEZONE,
  }).format(new Date());

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "あなたは日本語ニュース編集者です。入力された記事一覧を読み、事実ベースで短く分かりやすく要約してください。推測や断定を避け、リンクは削除しないでください。",
        },
        {
          role: "user",
          content:
            `以下は直近24時間のニュース候補です。Slack/Discord投稿用に日本語で要約してください。\n` +
            `出力形式:\n` +
            `- 先頭に \"### ${todayJst} のニュースまとめ\"\n` +
            `- 重要トピックを3-6個、各1-2文の箇条書き\n` +
            `- 最後に \"参考リンク\" セクションを作り、記事タイトル付きで最大8件\n\n` +
            inputText,
        },
      ],
    });

    const text = response.output_text?.trim();
    if (!text) return buildFallbackSummary(articles);
    return truncateForPost(text);
  } catch (err) {
    console.warn("[SUMMARY WARN] OpenAI summary failed. Falling back.", err?.code || err?.message || err);
    return buildFallbackSummary(articles);
  }
}

async function buildChatReply(userText, username, platform) {
  if (!openai) {
    return buildFallbackChatReply(userText, username);
  }

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "あなたは博多弁で話す親しみやすいニュースbotです。短く自然に返答してください。危険行為や違法行為は断ってください。",
        },
        {
          role: "user",
          content: `プラットフォーム: ${platform}\nユーザー名: ${username}\nメッセージ: ${userText}`,
        },
      ],
    });

    const text = response.output_text?.trim();
    if (!text) return buildFallbackChatReply(userText, username);
    return truncateForPost(text);
  } catch (err) {
    console.warn("[CHAT WARN] OpenAI chat failed. Falling back.", err?.code || err?.message || err);
    return buildFallbackChatReply(userText, username);
  }
}

function buildFallbackChatReply(userText, username) {
  const lower = userText.toLowerCase();
  if (lower.includes("ニュース")) {
    return `${username}さん、ニュースの要約は毎朝投稿しようけん、楽しみにしとってね。`;
  }
  if (lower.includes("おは")) {
    return `${username}さん、おはよう！今日もよか一日にしようや。`;
  }
  if (lower.includes("ありがと")) {
    return "どういたしましてたい。いつでも話しかけてよかよ。";
  }
  return `${username}さん、話しかけてくれてありがとう。うちは博多弁で返すけん、気軽に聞いてよかよ。`;
}

function buildFallbackSummary(articles) {
  const todayJst = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "full",
    timeZone: TIMEZONE,
  }).format(new Date());

  const lines = [`### ${todayJst} のニュースまとめ`, "", "主要記事:"];
  for (const a of articles.slice(0, 8)) {
    lines.push(`- [${a.source}] ${a.title}`);
    lines.push(`  ${a.link}`);
  }
  return truncateForPost(lines.join("\n"));
}

async function postMessageAll(content) {
  const tasks = [];
  if (DISCORD_ENABLED) tasks.push(postMessageDiscord(content));
  if (SLACK_ENABLED) tasks.push(postMessageSlack(content));

  const results = await Promise.allSettled(tasks);
  const failures = results.filter((r) => r.status === "rejected");
  for (const failure of failures) {
    console.error("[POST ERROR]", failure.reason);
  }

  if (failures.length === results.length) {
    throw new Error("Failed to post message to all enabled platforms.");
  }
}

async function postMessageDiscord(content) {
  const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    throw new Error("Configured DISCORD_CHANNEL_ID is not a text channel.");
  }

  for (const chunk of splitForMessage(content)) {
    await channel.send(chunk);
  }
}

async function postMessageSlack(content) {
  if (!slackApp) throw new Error("Slack app is not initialized.");

  for (const chunk of splitForMessage(content, 3500)) {
    await slackApp.client.chat.postMessage({
      channel: process.env.SLACK_CHANNEL_ID,
      text: chunk,
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}

async function getSlackBotUserId(client) {
  const auth = await client.auth.test();
  if (!auth.user_id) throw new Error("Could not resolve Slack bot user id.");
  return auth.user_id;
}

async function handleSlackCameraCommand(channelId, threadTs, username) {
  if (!slackApp) throw new Error("Slack app is not initialized.");

  if (!SLACK_CAMERA_ENABLED) {
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text: "カメラ機能は無効になっとるけん、`SLACK_CAMERA_ENABLED=true` にして再起動してね。",
      thread_ts: threadTs,
    });
    return;
  }

  if (isCameraCaptureRunning) {
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text: "いま撮影中やけん、少し待ってもう一回 `camera` って送ってね。",
      thread_ts: threadTs,
    });
    return;
  }

  isCameraCaptureRunning = true;
  try {
    const filePath = await captureSlackCameraImage();
    await slackApp.client.files.uploadV2({
      channel_id: channelId,
      file: createReadStream(filePath),
      filename: path.basename(filePath),
      title: "Raspberry Pi Camera",
      initial_comment: `${username}さんのリクエストで撮影した画像です。`,
    });
    console.log(`[SLACK CAMERA] Uploaded image: ${filePath}`);
  } catch (err) {
    console.error("[SLACK CAMERA ERROR]", err);
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text:
        "カメラ撮影に失敗したけん、`rpicam-still` か `libcamera-still` が使えるか確認してみて。",
      thread_ts: threadTs,
    });
  } finally {
    isCameraCaptureRunning = false;
  }
}

async function captureSlackCameraImage() {
  const outputDir = path.resolve(CAMERA_OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `camera-${timestamp}.jpg`);
  const commands = [
    {
      bin: "rpicam-still",
      args: ["-o", outputPath, "--nopreview", "--timeout", String(CAMERA_CAPTURE_TIME_MS)],
    },
    {
      bin: "libcamera-still",
      args: ["-o", outputPath, "--nopreview", "-t", String(CAMERA_CAPTURE_TIME_MS)],
    },
  ];

  let lastError = null;
  for (const command of commands) {
    try {
      await runCommand(command.bin, command.args, CAMERA_CAPTURE_TIME_MS + 10000);
      return outputPath;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `Could not capture image with rpicam-still/libcamera-still. ${lastError?.message || "Unknown error"}`
  );
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${command} failed to start: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const details = (stderr || stdout || "no output").trim();
      reject(new Error(`${command} exited with code ${code}: ${details}`));
    });
  });
}

function truncateForPost(text) {
  if (text.length <= 8000) return text;
  return text.slice(0, 7900) + "\n\n(文字数上限のため省略)";
}

function splitForMessage(text, maxLen = 1900) {
  const chunks = [];
  let rest = text;

  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function hasPrefix(raw, prefix) {
  if (!prefix) return false;
  const normalized = raw.trimStart().toLowerCase();
  const p = prefix.toLowerCase();
  return normalized === p || normalized.startsWith(`${p} `);
}

function removePrefix(raw, prefix) {
  const trimmed = raw.trimStart();
  const p = prefix.trim();
  if (!p) return trimmed;
  if (trimmed.toLowerCase() === p.toLowerCase()) return "";
  if (trimmed.toLowerCase().startsWith(`${p.toLowerCase()} `)) {
    return trimmed.slice(p.length).trim();
  }
  return trimmed;
}

function isCameraCommand(text) {
  if (!text) return false;
  const trimmed = text.trim();
  return /^camera(?:\s|$)/i.test(trimmed) || /^カメラ(?:\s|$)/.test(trimmed);
}

function validateRequired(keys, groupName) {
  for (const key of keys) {
    if (!process.env[key]) {
      console.error(`[CONFIG ERROR] Missing required env for ${groupName}: ${key}`);
      process.exit(1);
    }
  }
}

function toBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function toPositiveInt(value, fallback) {
  if (value == null || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

start().catch((err) => {
  console.error("[BOOT ERROR]", err);
  process.exit(1);
});
