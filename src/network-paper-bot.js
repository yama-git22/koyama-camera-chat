import "dotenv/config";
import cron from "node-cron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

const TIMEZONE = process.env.TZ || "Asia/Tokyo";
const PAPER_SEARCH_QUERY = (process.env.PAPER_SEARCH_QUERY || "cat:cs.NI").trim();
const PAPER_CRON_SCHEDULE = (process.env.PAPER_CRON_SCHEDULE || "0 9 * * *").trim();
const PAPER_RUN_ON_START = toBool(process.env.PAPER_RUN_ON_START, false);
const PAPER_FETCH_LIMIT = toPositiveInt(process.env.PAPER_FETCH_LIMIT, 25);
const PAPER_MAX_POSTS = toPositiveInt(process.env.PAPER_MAX_POSTS, 5);
const PAPER_LOOKBACK_HOURS = toPositiveInt(process.env.PAPER_LOOKBACK_HOURS, 48);
const PAPER_POST_EMPTY_UPDATE = toBool(process.env.PAPER_POST_EMPTY_UPDATE, false);
const PAPER_STATE_FILE = (process.env.PAPER_STATE_FILE || "output/network-paper-bot-state.json").trim();

const ARXIV_API_URL = (process.env.ARXIV_API_URL || "https://export.arxiv.org/api/query").trim();
const ARXIV_USER_AGENT = (
  process.env.ARXIV_USER_AGENT || "network-paper-bot/1.0 (mailto:replace-this@example.com)"
).trim();
const ARXIV_MAX_RETRIES = toNonNegativeInt(process.env.ARXIV_MAX_RETRIES, 3);
const ARXIV_RETRY_DELAY_MS = toPositiveInt(process.env.ARXIV_RETRY_DELAY_MS, 20000);

const OLLAMA_BASE_URL = stripTrailingSlash(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434");
const OLLAMA_MODEL = (process.env.OLLAMA_MODEL || "qwen2.5:7b").trim();
const OLLAMA_KEEP_ALIVE = (process.env.OLLAMA_KEEP_ALIVE || "10m").trim();
const OLLAMA_TIMEOUT_MS = toPositiveInt(process.env.OLLAMA_TIMEOUT_MS, 120000);

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN?.trim() || "";
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID?.trim() || "";

const RUN_ONCE = args.once;
const DRY_RUN = args.dryRun;
const IGNORE_STATE = args.ignoreState;

if (!PAPER_SEARCH_QUERY) {
  console.error("[CONFIG ERROR] PAPER_SEARCH_QUERY is empty.");
  process.exit(1);
}

if (!DRY_RUN) {
  validateRequired(["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"], "SLACK");
}

let isJobRunning = false;

await start();

async function start() {
  console.log(`[PAPER BOT] Query: ${PAPER_SEARCH_QUERY}`);
  console.log(`[PAPER BOT] Ollama model: ${OLLAMA_MODEL}`);
  console.log(`[PAPER BOT] Dry run: ${DRY_RUN ? "yes" : "no"}`);

  if (RUN_ONCE) {
    await runPaperJob();
    return;
  }

  if (PAPER_RUN_ON_START) {
    await runPaperJob();
  }

  console.log(`[PAPER BOT] Schedule: '${PAPER_CRON_SCHEDULE}' (${TIMEZONE})`);
  cron.schedule(
    PAPER_CRON_SCHEDULE,
    async () => {
      await runPaperJob();
    },
    { timezone: TIMEZONE }
  );
}

async function runPaperJob() {
  if (isJobRunning) {
    console.warn("[PAPER BOT] Skip: previous job is still running.");
    return;
  }

  isJobRunning = true;
  const startedAt = new Date();
  console.log(`[PAPER BOT] Start: ${startedAt.toISOString()}`);

  try {
    const state = IGNORE_STATE ? defaultState() : await loadState(PAPER_STATE_FILE);
    const candidates = await fetchRecentPapers();
    const freshPapers = filterFreshPapers(candidates, state);

    if (freshPapers.length === 0) {
      console.log("[PAPER BOT] No new papers found.");

      if (PAPER_POST_EMPTY_UPDATE) {
        const message =
          `*ネットワーク分野の新着論文まとめ*\n` +
          `対象期間: 過去${PAPER_LOOKBACK_HOURS}時間\n` +
          `検索条件: \`${PAPER_SEARCH_QUERY}\`\n` +
          `新着論文は見つかりませんでした。`;

        if (DRY_RUN) {
          console.log("\n--- DRY RUN HEADER ---\n");
          console.log(message);
        } else {
          await postSlackMessage(message);
        }
      }

      if (!DRY_RUN) {
        await saveState(PAPER_STATE_FILE, {
          ...state,
          lastCheckedAt: startedAt.toISOString(),
        });
      }
      return;
    }

    const summarizedPapers = [];
    for (const paper of freshPapers) {
      const summary = await summarizePaper(paper);
      summarizedPapers.push({ ...paper, summary });
    }

    const rendered = renderDigest(summarizedPapers, startedAt);

    if (DRY_RUN) {
      console.log("\n--- DRY RUN HEADER ---\n");
      console.log(rendered.header);
      for (const body of rendered.paperBodies) {
        console.log("\n--- DRY RUN PAPER ---\n");
        console.log(body);
      }
    } else {
      await postDigestToSlack(rendered);
    }

    if (!DRY_RUN) {
      await saveState(PAPER_STATE_FILE, buildNextState(state, freshPapers, startedAt));
    }

    const actionLabel = DRY_RUN ? "Prepared" : "Posted";
    console.log(`[PAPER BOT] ${actionLabel} ${freshPapers.length} paper(s).`);
  } catch (error) {
    console.error("[PAPER BOT ERROR]", error);

    if (!DRY_RUN) {
      const message =
        `*ネットワーク論文Botでエラーが発生しました*\n` +
        `時刻: ${formatDateTime(new Date())}\n` +
        `詳細: \`${truncateText(String(error?.message || error), 300)}\``;

      try {
        await postSlackMessage(message);
      } catch (slackError) {
        console.error("[PAPER BOT] Failed to report error to Slack.", slackError);
      }
    }

    process.exitCode = 1;
  } finally {
    isJobRunning = false;
  }
}

async function fetchRecentPapers() {
  const url = new URL(ARXIV_API_URL);
  url.searchParams.set("search_query", PAPER_SEARCH_QUERY);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(PAPER_FETCH_LIMIT));
  url.searchParams.set("sortBy", "submittedDate");
  url.searchParams.set("sortOrder", "descending");

  for (let attempt = 0; attempt <= ARXIV_MAX_RETRIES; attempt += 1) {
    const response = await fetchWithTimeout(url.toString(), {
      headers: {
        Accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
        "User-Agent": ARXIV_USER_AGENT,
      },
    });

    if (response.ok) {
      const xml = await response.text();
      const papers = parseArxivFeed(xml);
      console.log(`[PAPER BOT] Fetched ${papers.length} paper(s) from arXiv.`);
      return papers;
    }

    const details = await readErrorDetails(response);
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const shouldRetry = response.status === 429 || response.status >= 500;

    if (!shouldRetry || attempt >= ARXIV_MAX_RETRIES) {
      throw new Error(
        `arXiv API request failed: ${response.status} ${response.statusText}${details ? ` (${details})` : ""}`
      );
    }

    const delayMs = retryAfterMs ?? ARXIV_RETRY_DELAY_MS * (attempt + 1);
    console.warn(
      `[PAPER BOT] arXiv request throttled or unavailable. Retry ${attempt + 1}/${ARXIV_MAX_RETRIES} in ${Math.ceil(
        delayMs / 1000
      )}s.`
    );
    await sleep(delayMs);
  }

  throw new Error("arXiv API request failed after retries.");
}

function parseArxivFeed(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;

  for (const match of xml.matchAll(entryRegex)) {
    const entryXml = match[1];
    const rawId = extractXmlTag(entryXml, "id");
    const versionedId = rawId.split("/abs/").pop() || "";
    const baseId = versionedId.replace(/v\d+$/, "");
    const title = normalizeWhitespace(extractXmlTag(entryXml, "title"));
    const summary = normalizeWhitespace(extractXmlTag(entryXml, "summary"));
    const publishedAt = extractXmlTag(entryXml, "published");
    const updatedAt = extractXmlTag(entryXml, "updated");
    const authors = extractAuthors(entryXml);
    const categories = Array.from(new Set(extractCategories(entryXml)));
    const primaryCategory = extractAttribute(entryXml, "arxiv:primary_category", "term") || categories[0] || "";
    const pdfUrl =
      extractLink(entryXml, { title: "pdf" }) ||
      (versionedId ? `https://arxiv.org/pdf/${versionedId}.pdf` : "");
    const absUrl =
      extractLink(entryXml, { rel: "alternate" }) ||
      (versionedId ? `https://arxiv.org/abs/${versionedId}` : "");

    if (!baseId || !title || !summary || !publishedAt) {
      continue;
    }

    entries.push({
      id: baseId,
      versionedId,
      title,
      summary,
      authors,
      categories,
      primaryCategory,
      publishedAt,
      updatedAt,
      publishedMs: Date.parse(publishedAt),
      absUrl,
      pdfUrl,
    });
  }

  return entries;
}

function filterFreshPapers(papers, state) {
  const cutoffMs = Date.now() - PAPER_LOOKBACK_HOURS * 60 * 60 * 1000;
  const postedIds = new Set(state.postedPaperIds || []);

  return papers
    .filter((paper) => Number.isFinite(paper.publishedMs))
    .filter((paper) => paper.publishedMs >= cutoffMs)
    .filter((paper) => !postedIds.has(paper.id))
    .slice(0, PAPER_MAX_POSTS);
}

async function summarizePaper(paper) {
  try {
    const summary = await summarizeWithOllama(paper);
    return normalizeSummary(summary, false);
  } catch (error) {
    console.warn(`[PAPER BOT] Ollama summary failed for ${paper.id}. Falling back.`, error);
    return normalizeSummary(buildFallbackSummary(paper), true);
  }
}

async function summarizeWithOllama(paper) {
  const schema = {
    type: "object",
    properties: {
      overview: { type: "string" },
      key_points: {
        type: "array",
        items: { type: "string" },
        minItems: 2,
        maxItems: 3,
      },
      value_for_lab: { type: "string" },
      cautions: { type: "string" },
    },
    required: ["overview", "key_points", "value_for_lab", "cautions"],
  };

  const prompt = [
    "次のarXiv論文情報を日本語で要約してください。",
    "出力はJSONのみで返してください。",
    "制約:",
    "- アブストラクトにない事実を捏造しない",
    "- overview は2文から3文",
    "- key_points は2件から3件",
    "- value_for_lab は研究室で読む価値を1文で述べる",
    "- cautions は限界や未記載事項を1文で述べる",
    "",
    `Title: ${paper.title}`,
    `Authors: ${paper.authors.join(", ") || "Unknown"}`,
    `Primary category: ${paper.primaryCategory || "Unknown"}`,
    `All categories: ${paper.categories.join(", ") || "Unknown"}`,
    `Published: ${paper.publishedAt}`,
    "",
    "Abstract:",
    paper.summary,
  ].join("\n");

  const response = await fetchWithTimeout(
    `${OLLAMA_BASE_URL}/api/generate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        format: schema,
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: {
          temperature: 0.2,
          num_predict: 360,
        },
      }),
    },
    OLLAMA_TIMEOUT_MS
  );

  if (!response.ok) {
    const details = await readErrorDetails(response);
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}${details ? ` (${details})` : ""}`);
  }

  const payload = await response.json();
  const content = payload.response?.trim();
  const parsed = safeJsonParse(content);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Ollama returned invalid JSON.");
  }

  return {
    overview: parsed.overview,
    key_points: parsed.key_points,
    value_for_lab: parsed.value_for_lab,
    cautions: parsed.cautions,
  };
}

function normalizeSummary(summary, isFallback) {
  const keyPoints = Array.isArray(summary.key_points)
    ? summary.key_points.map((item) => normalizeWhitespace(String(item))).filter(Boolean).slice(0, 3)
    : [];

  if (keyPoints.length === 0) {
    keyPoints.push("アブストラクトの要点を原文で確認してください。");
  }

  return {
    overview: normalizeWhitespace(summary.overview || "要約の生成に失敗しました。"),
    keyPoints,
    valueForLab: normalizeWhitespace(summary.value_for_lab || "研究室での関連性は原文確認が必要です。"),
    cautions: normalizeWhitespace(summary.cautions || "詳細は原文を確認してください。"),
    isFallback,
  };
}

function buildFallbackSummary(paper) {
  const sentences = splitIntoSentences(paper.summary);
  const overview = sentences.slice(0, 2).join(" ");
  const keyPoints = sentences.slice(0, 3);

  return {
    overview: overview || truncateText(paper.summary, 220),
    key_points: keyPoints.length > 0 ? keyPoints : [truncateText(paper.summary, 120)],
    value_for_lab: "新しいネットワーク手法や評価条件を把握する入り口として有用です。",
    cautions: "この要約はOllamaが利用できなかったため、アブストラクトからの簡易抽出です。",
  };
}

function renderDigest(papers, generatedAt) {
  const header =
    `*ネットワーク分野の新着論文まとめ*\n` +
    `生成時刻: ${formatDateTime(generatedAt)}\n` +
    `検索条件: \`${PAPER_SEARCH_QUERY}\`\n` +
    `対象期間: 過去${PAPER_LOOKBACK_HOURS}時間\n` +
    `件数: ${papers.length}件`;

  const paperBodies = papers.map((paper, index) => renderPaper(paper, index + 1));
  return { header, paperBodies };
}

function renderPaper(paper, number) {
  const authorLabel =
    paper.authors.length > 4
      ? `${paper.authors.slice(0, 4).join(", ")} ほか`
      : paper.authors.join(", ") || "Unknown";

  const lines = [
    `*${number}. ${paper.title}*`,
    `著者: ${authorLabel}`,
    `投稿日: ${formatDateTime(new Date(paper.publishedAt))}`,
    `カテゴリ: ${paper.categories.join(", ") || paper.primaryCategory || "Unknown"}`,
    `リンク: <${paper.absUrl}|arXiv>${paper.pdfUrl ? ` / <${paper.pdfUrl}|PDF>` : ""}`,
    "",
    "要約:",
    paper.summary.overview,
    "",
    "ポイント:",
    ...paper.summary.keyPoints.map((point) => `• ${point}`),
    "",
    "研究室での見どころ:",
    paper.summary.valueForLab,
    "",
    "注意点:",
    paper.summary.cautions,
  ];

  if (paper.summary.isFallback) {
    lines.push("", "_注: Ollama要約に失敗したため簡易要約を表示しています。_");
  }

  return lines.join("\n");
}

async function postDigestToSlack(rendered) {
  const root = await postSlackMessage(rendered.header);

  for (const body of rendered.paperBodies) {
    const chunks = splitSlackMessage(body);
    for (const chunk of chunks) {
      await postSlackMessage(chunk, root.ts);
    }
  }
}

async function postSlackMessage(text, threadTs = undefined) {
  const response = await fetchWithTimeout("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text,
      thread_ts: threadTs,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  if (!response.ok) {
    const details = await readErrorDetails(response);
    throw new Error(`Slack request failed: ${response.status} ${response.statusText}${details ? ` (${details})` : ""}`);
  }

  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`Slack API error: ${payload.error || "unknown_error"}`);
  }

  return payload;
}

async function loadState(stateFile) {
  const resolved = path.resolve(stateFile);

  try {
    const raw = await readFile(resolved, "utf8");
    const parsed = JSON.parse(raw);
    return {
      postedPaperIds: Array.isArray(parsed.postedPaperIds) ? parsed.postedPaperIds : [],
      lastCheckedAt: typeof parsed.lastCheckedAt === "string" ? parsed.lastCheckedAt : null,
      lastPostedAt: typeof parsed.lastPostedAt === "string" ? parsed.lastPostedAt : null,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return defaultState();
    }
    throw error;
  }
}

async function saveState(stateFile, state) {
  const resolved = path.resolve(stateFile);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function buildNextState(previousState, postedPapers, checkedAt) {
  const merged = [...postedPapers.map((paper) => paper.id), ...(previousState.postedPaperIds || [])];
  const deduped = Array.from(new Set(merged)).slice(0, 500);

  return {
    postedPaperIds: deduped,
    lastCheckedAt: checkedAt.toISOString(),
    lastPostedAt: checkedAt.toISOString(),
  };
}

function defaultState() {
  return {
    postedPaperIds: [],
    lastCheckedAt: null,
    lastPostedAt: null,
  };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 30000) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function readErrorDetails(response) {
  try {
    const text = (await response.text()).trim();
    if (!text) return "";

    const parsed = safeJsonParse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      return parsed.error;
    }

    return truncateText(text, 160);
  } catch {
    return "";
  }
}

function parseRetryAfterMs(value) {
  if (!value) return null;

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) {
    return null;
  }

  return Math.max(0, dateMs - Date.now());
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function extractXmlTag(xml, tagName) {
  const escaped = escapeForRegex(tagName);
  const regex = new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`, "i");
  const match = xml.match(regex);
  return match ? decodeXmlEntities(match[1]) : "";
}

function extractAuthors(xml) {
  const authors = [];
  const regex = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi;

  for (const match of xml.matchAll(regex)) {
    const author = normalizeWhitespace(decodeXmlEntities(match[1]));
    if (author) {
      authors.push(author);
    }
  }

  return authors;
}

function extractCategories(xml) {
  const categories = [];
  const regex = /<category\b[^>]*\bterm="([^"]+)"[^>]*\/?>/gi;

  for (const match of xml.matchAll(regex)) {
    const category = normalizeWhitespace(decodeXmlEntities(match[1]));
    if (category) {
      categories.push(category);
    }
  }

  return categories;
}

function extractAttribute(xml, tagName, attributeName) {
  const escapedTag = escapeForRegex(tagName);
  const escapedAttr = escapeForRegex(attributeName);
  const regex = new RegExp(`<${escapedTag}\\b[^>]*\\b${escapedAttr}="([^"]+)"[^>]*\\/?>`, "i");
  const match = xml.match(regex);
  return match ? decodeXmlEntities(match[1]) : "";
}

function extractLink(xml, criteria = {}) {
  const regex = /<link\b([^>]+?)\/?>/gi;

  for (const match of xml.matchAll(regex)) {
    const attrs = match[1];
    const href = extractAttrFromString(attrs, "href");
    const rel = extractAttrFromString(attrs, "rel");
    const title = extractAttrFromString(attrs, "title");

    if (criteria.rel && rel !== criteria.rel) continue;
    if (criteria.title && title !== criteria.title) continue;
    if (href) return href.replace(/^http:\/\//i, "https://");
  }

  return "";
}

function extractAttrFromString(attrs, name) {
  const escaped = escapeForRegex(name);
  const regex = new RegExp(`\\b${escaped}="([^"]+)"`, "i");
  const match = attrs.match(regex);
  return match ? decodeXmlEntities(match[1]) : "";
}

function decodeXmlEntities(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number.parseInt(num, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitIntoSentences(text) {
  return normalizeWhitespace(text)
    .split(/(?<=[。.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function splitSlackMessage(text, maxLength = 3000) {
  if (text.length <= maxLength) {
    return [text];
  }

  const paragraphs = text.split("\n\n");
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (paragraph.length <= maxLength) {
      current = paragraph;
      continue;
    }

    chunks.push(...splitLongParagraph(paragraph, maxLength));
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitLongParagraph(text, maxLength) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (line.length <= maxLength) {
      current = line;
      continue;
    }

    for (let index = 0; index < line.length; index += maxLength) {
      chunks.push(line.slice(index, index + maxLength));
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeJsonParse(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function toBool(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function toPositiveInt(value, defaultValue) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function toNonNegativeInt(value, defaultValue) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function validateRequired(keys, label) {
  const missing = keys.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    console.error(`[CONFIG ERROR] Missing ${label} environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}

function escapeForRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv) {
  return {
    once: argv.includes("--once"),
    dryRun: argv.includes("--dry-run"),
    ignoreState: argv.includes("--ignore-state"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function printUsage() {
  console.log(`Usage: node src/network-paper-bot.js [options]

Options:
  --once          Run one cycle and exit
  --dry-run       Do not post to Slack; print the rendered digest
  --ignore-state  Ignore the saved posted-paper history
  --help, -h      Show this help
`);
}
