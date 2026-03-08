import "dotenv/config";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set in .env");
  }

  const inputArg = process.argv[2];
  if (!inputArg) {
    throw new Error("Usage: node src/zoom-summary.js <zoom-video-file-or-url>");
  }

  const outputDir = path.resolve(process.cwd(), "output");
  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const resolvedInput = await resolveInputToLocalFile(inputArg, outputDir, timestamp);
  const baseName = path.basename(resolvedInput, path.extname(resolvedInput));
  const audioPath = path.join(outputDir, `${baseName}-${timestamp}.mp3`);
  const transcriptPath = path.join(outputDir, `${baseName}-${timestamp}.transcript.txt`);
  const summaryPath = path.join(outputDir, `${baseName}-${timestamp}.summary.md`);

  console.log(`[1/4] Extracting audio: ${audioPath}`);
  await extractAudio(resolvedInput, audioPath);

  console.log("[2/4] Transcribing audio with OpenAI...");
  const transcription = await transcribeAudio(audioPath);
  await fs.writeFile(transcriptPath, transcription, "utf8");

  console.log("[3/4] Summarizing transcript...");
  const summary = await summarizeTranscript(transcription);
  await fs.writeFile(summaryPath, summary, "utf8");

  console.log("[4/4] Done");
  console.log(`Transcript: ${transcriptPath}`);
  console.log(`Summary: ${summaryPath}`);
}

async function resolveInputToLocalFile(inputArg, outputDir, timestamp) {
  if (!isHttpUrl(inputArg)) {
    const local = path.resolve(inputArg);
    await fs.access(local);
    return local;
  }

  console.log(`[input] URL detected: ${inputArg}`);

  if (await commandExists("yt-dlp")) {
    try {
      const downloaded = await downloadWithYtDlp(inputArg, outputDir);
      console.log(`[input] Downloaded with yt-dlp: ${downloaded}`);
      return downloaded;
    } catch (err) {
      console.warn(`[input] yt-dlp failed: ${err.message}`);
    }
  } else {
    console.warn("[input] yt-dlp not found. Trying direct download.");
  }

  const fallbackPath = path.join(outputDir, `zoom-recording-${timestamp}.mp4`);
  await downloadDirect(inputArg, fallbackPath);
  console.log(`[input] Downloaded directly: ${fallbackPath}`);
  return fallbackPath;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
  });
}

function downloadWithYtDlp(url, outputDir) {
  return new Promise((resolve, reject) => {
    const args = [
      "--no-progress",
      "--no-warnings",
      "--merge-output-format",
      "mp4",
      "-o",
      "%(title).80s-%(id)s.%(ext)s",
      "-P",
      outputDir,
      "--print",
      "after_move:filepath",
      url,
    ];

    let stdout = "";
    let stderr = "";
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      reject(new Error(`yt-dlp failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }
      const lines = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const filePath = lines.at(-1);
      if (!filePath) {
        reject(new Error("yt-dlp finished but output file path was not detected."));
        return;
      }
      resolve(filePath);
    });
  });
}

async function downloadDirect(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Direct download failed: HTTP ${response.status}`);
  }
  await pipeline(response.body, fsSync.createWriteStream(outputPath));
}

function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      audioPath,
    ];

    const ffmpeg = spawn("ffmpeg", args, { stdio: "ignore" });
    ffmpeg.on("error", (err) => {
      reject(new Error(`ffmpeg failed to start: ${err.message}`));
    });
    ffmpeg.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with code ${code}. Please install ffmpeg.`));
    });
  });
}

async function transcribeAudio(audioPath) {
  const file = await fs.open(audioPath, "r");
  try {
    const response = await client.audio.transcriptions.create({
      file: file.createReadStream(),
      model: process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
      language: "ja",
      response_format: "text",
    });
    return String(response).trim();
  } finally {
    await file.close();
  }
}

async function summarizeTranscript(transcript) {
  const truncated = transcript.slice(0, 180000);
  const todayJst = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "long",
    timeZone: process.env.TZ || "Asia/Tokyo",
  }).format(new Date());

  const response = await client.responses.create({
    model: process.env.SUMMARY_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content:
          "あなたは会議記録の編集者です。日本語で簡潔に、事実ベースで整理してください。出力はMarkdown。",
      },
      {
        role: "user",
        content:
          `以下はZoom会議の文字起こしです。要約してください。\n` +
          `出力形式:\n` +
          `# Zoom会議要約 (${todayJst})\n` +
          `## 全体要約 (3-6行)\n` +
          `## 主要トピック (箇条書き)\n` +
          `## 決定事項\n` +
          `## 宿題・アクションアイテム (担当/期限が分かれば記載)\n` +
          `## 懸念点・未決事項\n\n` +
          truncated,
      },
    ],
  });

  const text = response.output_text?.trim();
  if (!text) {
    throw new Error("Failed to generate summary text.");
  }
  return text;
}

main().catch((err) => {
  console.error("[ERROR]", err.message);
  process.exit(1);
});
