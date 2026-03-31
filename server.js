require("dotenv").config({ quiet: true });

const express = require("express");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createFeedbackWebhookSystem, normalizeHttpUrl } = require("./feedback-webhook");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 4173);
const ROOT_DIR = path.resolve(process.env.GAMES_ROOT || __dirname);
const PORTAL_DIR = path.join(__dirname, "portal");
const PORTAL_DATA_DIR = path.join(__dirname, ".portal-data");
const PLAY_STATS_PATH = path.join(PORTAL_DATA_DIR, "play-stats.json");
const FEEDBACK_LOG_PATH = path.join(PORTAL_DATA_DIR, "feedback-log.ndjson");
const README_PATH = path.join(__dirname, "README.md");
const MAX_SCAN_DEPTH = Number(process.env.MAX_SCAN_DEPTH || 4);
const RESCAN_INTERVAL_MS = Number(process.env.RESCAN_INTERVAL_MS || 300_000);
const LOCAL_ONLY = process.env.LOCAL_ONLY === "1";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const NO_CACHE_CONTROL = "no-cache";
const DEFAULT_MOST_PLAYED_LIMIT = 8;
const MAX_MOST_PLAYED_LIMIT = 500;
const DISCORD_INVITE_URL = String(process.env.DISCORD_INVITE_URL || "").trim();
const DISCORD_WEBHOOK_URL = String(
  process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_FEEDBACK_WEBHOOK_URL || ""
).trim();
const CUSTOM_FEEDBACK_WEBHOOK_URL = String(process.env.CUSTOM_FEEDBACK_WEBHOOK_URL || "").trim();
const FEEDBACK_MAX_LENGTH = Math.min(
  Math.max(Number(process.env.FEEDBACK_MAX_LENGTH || 1200) || 1200, 80),
  1900
);
const FEEDBACK_COOLDOWN_MS = Math.max(
  Number(process.env.FEEDBACK_COOLDOWN_MS || 20_000) || 20_000,
  3_000
);
const FEEDBACK_HISTORY_LIMIT = Math.min(
  Math.max(Number(process.env.FEEDBACK_HISTORY_LIMIT || 500) || 500, 50),
  5000
);

const ENTRY_PRIORITY = [
  "index.html",
  "index.htm",
  "game.html",
  "main.html",
  "play.html",
  "start.html"
];

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "portal"
]);

let gameCache = {
  games: [],
  bySlug: new Map(),
  updatedAt: 0
};
const encodingHintCache = new Map();
const readmeDisplayNameCache = new Map();
let playStatsCache = null;
let playStatsSaveQueue = Promise.resolve();
const feedbackRateLimitByIp = new Map();
let feedbackLogWriteQueue = Promise.resolve();
let feedbackHistoryCache = [];
let feedbackHistoryLoaded = false;
const feedbackStreamClients = new Set();

function isLoopbackAddress(ipAddress) {
  if (!ipAddress) {
    return false;
  }

  return (
    ipAddress === "127.0.0.1" ||
    ipAddress === "::1" ||
    ipAddress === "::ffff:127.0.0.1"
  );
}

function makeDisplayName(folderName) {
  return folderName
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

async function loadReadmeDisplayNameOverrides() {
  if (readmeDisplayNameCache.size) {
    return readmeDisplayNameCache;
  }

  let readmeContent = "";
  try {
    readmeContent = await fs.readFile(README_PATH, "utf8");
  } catch {
    return readmeDisplayNameCache;
  }

  const entryPattern = /-\s+\[([^\]]+)\]\(([^)]+)\)/g;
  for (const match of readmeContent.matchAll(entryPattern)) {
    const displayName = match[1].trim();
    const link = match[2].trim();
    const folderMatch = link.match(/\/tree\/main\/([^\/)#?]+)/i);
    if (!folderMatch) {
      continue;
    }

    const folderName = folderMatch[1];
    if (!readmeDisplayNameCache.has(folderName)) {
      readmeDisplayNameCache.set(folderName, displayName);
    }
  }

  return readmeDisplayNameCache;
}

function makeSlug(folderName) {
  return folderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "game";
}

function makeDisplayNameFromFileName(fileName) {
  return path
    .parse(fileName)
    .name
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createUniqueSlug(slugCounts, seed) {
  const baseSlug = makeSlug(seed);
  const slugIndex = slugCounts.get(baseSlug) || 0;
  slugCounts.set(baseSlug, slugIndex + 1);
  return slugIndex === 0 ? baseSlug : `${baseSlug}-${slugIndex + 1}`;
}

function toUrlPath(relativePath) {
  return relativePath
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function scoreEntry(relativePath) {
  const parts = relativePath.split(path.sep);
  const fileName = parts[parts.length - 1].toLowerCase();
  const folderDepth = parts.length - 1;
  const priorityIndex = ENTRY_PRIORITY.includes(fileName)
    ? ENTRY_PRIORITY.indexOf(fileName)
    : ENTRY_PRIORITY.length + 5;

  return folderDepth * 100 + priorityIndex * 10 + relativePath.length / 10_000;
}

async function findHtmlEntries(baseDir, currentRelative = "", depth = 0) {
  if (depth > MAX_SCAN_DEPTH) {
    return [];
  }

  const absoluteDir = path.join(baseDir, currentRelative);
  let entries;

  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const found = [];

  for (const item of sortedEntries) {
    if (item.name.startsWith(".")) {
      continue;
    }

    const nextRelative = path.join(currentRelative, item.name);

    if (item.isDirectory()) {
      if (IGNORED_DIRS.has(item.name)) {
        continue;
      }

      const children = await findHtmlEntries(baseDir, nextRelative, depth + 1);
      found.push(...children);
      continue;
    }

    if (item.isFile() && item.name.toLowerCase().endsWith(".html")) {
      found.push(nextRelative);
    }
  }

  return found;
}

async function discoverGames() {
  const readmeDisplayNameOverrides = await loadReadmeDisplayNameOverrides();
  const rootEntries = await fs.readdir(ROOT_DIR, { withFileTypes: true });
  const topFolders = rootEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .filter((name) => !IGNORED_DIRS.has(name))
    .sort((a, b) => a.localeCompare(b));

  const slugCounts = new Map();
  const games = [];

  for (const folderName of topFolders) {
    const folderPath = path.join(ROOT_DIR, folderName);

    if (folderName === "html") {
      const htmlDirEntries = await fs.readdir(folderPath, { withFileTypes: true });
      const standaloneFiles = htmlDirEntries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => name.toLowerCase().endsWith(".html"))
        .sort((a, b) => a.localeCompare(b));

      for (const fileName of standaloneFiles) {
        const slug = createUniqueSlug(slugCounts, `html-${fileName}`);
        const entryRelativePath = fileName;
        const entryUrl = `/games/${encodeURIComponent(slug)}/${toUrlPath(entryRelativePath)}`;
        const htmlIconRelativePath = path.join("icons", `${slug}.png`);
        const htmlIconAbsolutePath = path.join(folderPath, htmlIconRelativePath);
        let iconUrl = "/portal/default-game-icon.svg";

        try {
          await fs.access(htmlIconAbsolutePath);
          iconUrl = `/games/${encodeURIComponent(slug)}/${toUrlPath(htmlIconRelativePath)}`;
        } catch {
          iconUrl = "/portal/default-game-icon.svg";
        }

        games.push({
          slug,
          folder: folderName,
          name: makeDisplayNameFromFileName(fileName),
          baseDir: folderPath,
          entryRelativePath,
          entryUrl,
          iconUrl
        });
      }

      if (standaloneFiles.length) {
        continue;
      }
    }

    const htmlEntries = await findHtmlEntries(folderPath);

    if (!htmlEntries.length) {
      continue;
    }

    const bestEntry = htmlEntries
      .map((entry) => ({
        entry,
        score: scoreEntry(entry)
      }))
      .sort((a, b) => a.score - b.score)[0].entry;

    const slug = createUniqueSlug(slugCounts, folderName);
    const entryUrl = `/games/${encodeURIComponent(slug)}/${toUrlPath(bestEntry)}`;

    games.push({
      slug,
      folder: folderName,
      name: readmeDisplayNameOverrides.get(folderName) || makeDisplayName(folderName),
      baseDir: folderPath,
      entryRelativePath: bestEntry,
      entryUrl
    });
  }

  return games;
}

async function ensureGameCache(options = {}) {
  const { force = false, autoRescan = true } = options;
  const isFresh = Date.now() - gameCache.updatedAt < RESCAN_INTERVAL_MS;

  if (!force && gameCache.games.length && (isFresh || !autoRescan)) {
    return gameCache;
  }

  const games = await discoverGames();
  const bySlug = new Map(games.map((game) => [game.slug, game]));

  gameCache = {
    games,
    bySlug,
    updatedAt: Date.now()
  };

  return gameCache;
}

function createDefaultPlayStats() {
  return {
    version: 1,
    updatedAt: 0,
    plays: {}
  };
}

function sanitizePlayStats(rawStats) {
  const safeStats = createDefaultPlayStats();

  if (!rawStats || typeof rawStats !== "object") {
    return safeStats;
  }

  safeStats.version = Number(rawStats.version) || 1;
  safeStats.updatedAt = Number(rawStats.updatedAt) || 0;
  const plays = rawStats.plays;

  if (!plays || typeof plays !== "object") {
    return safeStats;
  }

  for (const [slug, value] of Object.entries(plays)) {
    if (!slug || typeof slug !== "string") {
      continue;
    }

    const playCount = Math.max(0, Number(value?.count) || 0);
    const lastPlayedAt = Math.max(0, Number(value?.lastPlayedAt) || 0);

    if (playCount === 0 && lastPlayedAt === 0) {
      continue;
    }

    safeStats.plays[slug] = {
      count: playCount,
      lastPlayedAt
    };
  }

  return safeStats;
}

async function ensurePlayStatsCache() {
  if (playStatsCache) {
    return playStatsCache;
  }

  try {
    const rawFile = await fs.readFile(PLAY_STATS_PATH, "utf8");
    playStatsCache = sanitizePlayStats(JSON.parse(rawFile));
  } catch (error) {
    if (error.code !== "ENOENT") {
      logErrorSafe(error);
    }
    playStatsCache = createDefaultPlayStats();
  }

  return playStatsCache;
}

async function savePlayStats() {
  await fs.mkdir(PORTAL_DATA_DIR, { recursive: true });
  await fs.writeFile(PLAY_STATS_PATH, JSON.stringify(playStatsCache, null, 2), "utf8");
}

function queuePlayStatsSave() {
  playStatsSaveQueue = playStatsSaveQueue
    .catch(() => {})
    .then(() => savePlayStats());
  return playStatsSaveQueue;
}

function getMostPlayedGames(games, playStats, limit = DEFAULT_MOST_PLAYED_LIMIT) {
  const bySlug = new Map(games.map((game) => [game.slug, game]));
  const sortedEntries = Object.entries(playStats.plays)
    .map(([slug, value]) => ({
      slug,
      playCount: Math.max(0, Number(value?.count) || 0),
      lastPlayedAt: Math.max(0, Number(value?.lastPlayedAt) || 0)
    }))
    .filter((entry) => entry.playCount > 0)
    .filter((entry) => bySlug.has(entry.slug))
    .sort((a, b) => {
      if (b.playCount !== a.playCount) {
        return b.playCount - a.playCount;
      }
      if (b.lastPlayedAt !== a.lastPlayedAt) {
        return b.lastPlayedAt - a.lastPlayedAt;
      }
      const aName = bySlug.get(a.slug)?.name || "";
      const bName = bySlug.get(b.slug)?.name || "";
      return aName.localeCompare(bName);
    })
    .slice(0, limit);

  return sortedEntries.map((entry) => {
    const game = bySlug.get(entry.slug);
    return {
      slug: game.slug,
      name: game.name,
      folder: game.folder,
      entryUrl: game.entryUrl,
      iconUrl: game.iconUrl || `/games/${encodeURIComponent(game.slug)}/icon.png`,
      entryRelativePath: game.entryRelativePath,
      playCount: entry.playCount,
      lastPlayedAt: entry.lastPlayedAt
    };
  });
}

function resolveSafePath(baseDir, relativeFilePath) {
  const normalized = path.normalize(relativeFilePath || "");

  if (normalized.includes("..")) {
    return null;
  }

  const absolutePath = path.resolve(baseDir, normalized);

  if (absolutePath !== baseDir && !absolutePath.startsWith(`${baseDir}${path.sep}`)) {
    return null;
  }

  return absolutePath;
}

function getAssetContentType(targetPath) {
  const lowerPath = targetPath.toLowerCase();

  if (lowerPath.endsWith(".wasm") || lowerPath.endsWith(".wasm.code.unityweb")) {
    return "application/wasm";
  }

  if (
    lowerPath.endsWith(".js") ||
    lowerPath.endsWith(".mjs") ||
    lowerPath.endsWith(".framework.js.unityweb") ||
    lowerPath.endsWith(".wasm.framework.unityweb") ||
    lowerPath.endsWith(".asm.framework.unityweb")
  ) {
    return "application/javascript; charset=UTF-8";
  }

  return null;
}

function getCacheControlForPath(targetPath) {
  const lowerPath = targetPath.toLowerCase();
  const extension = path.extname(lowerPath);

  if (extension === ".html" || extension === ".htm") {
    return NO_CACHE_CONTROL;
  }

  const unityRuntimeExtensions = new Set([
    ".js",
    ".mjs",
    ".wasm",
    ".data",
    ".mem",
    ".symbols",
    ".symbols.json",
    ".unityweb"
  ]);

  const isUnityRuntimePath =
    lowerPath.includes(`${path.sep}build${path.sep}`) ||
    lowerPath.includes("/build/") ||
    lowerPath.includes("/templatedata/");

  if (unityRuntimeExtensions.has(extension) || lowerPath.endsWith(".unityweb") || isUnityRuntimePath) {
    return "public, max-age=0, must-revalidate";
  }

  return IMMUTABLE_CACHE_CONTROL;
}

async function detectPrecompressedEncoding(targetPath) {
  if (!targetPath.toLowerCase().endsWith(".unityweb")) {
    return null;
  }

  if (encodingHintCache.has(targetPath)) {
    return encodingHintCache.get(targetPath);
  }

  let encoding = null;

  try {
    const fileHandle = await fs.open(targetPath, "r");
    try {
      const header = Buffer.alloc(2);
      await fileHandle.read(header, 0, 2, 0);

      if (header[0] === 0x1f && header[1] === 0x8b) {
        encoding = "gzip";
      }
    } finally {
      await fileHandle.close();
    }
  } catch {
    encoding = null;
  }

  encodingHintCache.set(targetPath, encoding);
  return encoding;
}

async function sendGameFile(res, targetPath) {
  res.setHeader("Cache-Control", getCacheControlForPath(targetPath));

  const contentType = getAssetContentType(targetPath);
  if (contentType) {
    res.setHeader("Content-Type", contentType);
  }

  const encoding = await detectPrecompressedEncoding(targetPath);
  if (encoding) {
    res.setHeader("Content-Encoding", encoding);
  }

  await new Promise((resolve, reject) => {
    res.sendFile(targetPath, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function getLanIpv4Urls(port) {
  const interfaces = os.networkInterfaces();
  const urls = [];

  for (const network of Object.values(interfaces)) {
    if (!network) {
      continue;
    }

    for (const addressInfo of network) {
      if (addressInfo.family !== "IPv4" || addressInfo.internal) {
        continue;
      }

      urls.push(`http://${addressInfo.address}:${port}`);
    }
  }

  return [...new Set(urls)];
}

function isClientDisconnectError(error) {
  if (!error) {
    return false;
  }

  return (
    error.code === "EPIPE" ||
    error.code === "ECONNRESET" ||
    error.code === "ECONNABORTED" ||
    error.message === "Request aborted"
  );
}

function logErrorSafe(error) {
  try {
    console.error(error);
  } catch {
    // Ignore logging pipe issues under daemonized runtimes.
  }
}

function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return String(req.socket.remoteAddress || "unknown").trim();
}

function sanitizeFeedbackText(rawValue) {
  if (typeof rawValue !== "string") {
    return "";
  }

  return rawValue
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function makeFeedbackId(timestamp = Date.now()) {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `fb_${timestamp}_${randomPart}`;
}

async function appendFeedbackLog(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  feedbackLogWriteQueue = feedbackLogWriteQueue
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(PORTAL_DATA_DIR, { recursive: true });
      await fs.appendFile(FEEDBACK_LOG_PATH, line, "utf8");
    });

  await feedbackLogWriteQueue;
}

function rememberFeedbackEntry(entry) {
  feedbackHistoryCache.push(entry);
  if (feedbackHistoryCache.length > FEEDBACK_HISTORY_LIMIT) {
    feedbackHistoryCache = feedbackHistoryCache.slice(-FEEDBACK_HISTORY_LIMIT);
  }
}

async function ensureFeedbackHistoryLoaded() {
  if (feedbackHistoryLoaded) {
    return feedbackHistoryCache;
  }

  try {
    const rawLog = await fs.readFile(FEEDBACK_LOG_PATH, "utf8");
    const parsedEntries = rawLog
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && typeof entry === "object");

    feedbackHistoryCache = parsedEntries.slice(-FEEDBACK_HISTORY_LIMIT);
  } catch (error) {
    if (error.code !== "ENOENT") {
      logErrorSafe(error);
    }
    feedbackHistoryCache = [];
  }

  feedbackHistoryLoaded = true;
  return feedbackHistoryCache;
}

async function persistFeedbackHistory() {
  const lines = feedbackHistoryCache.map((entry) => JSON.stringify(entry));
  const output = lines.length ? `${lines.join("\n")}\n` : "";

  feedbackLogWriteQueue = feedbackLogWriteQueue
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(PORTAL_DATA_DIR, { recursive: true });
      await fs.writeFile(FEEDBACK_LOG_PATH, output, "utf8");
    });

  await feedbackLogWriteQueue;
}

async function deleteFeedbackEntryById(feedbackId) {
  await ensureFeedbackHistoryLoaded();
  const index = feedbackHistoryCache.findIndex((entry) => entry.id === feedbackId);
  if (index === -1) {
    return null;
  }

  const [deletedEntry] = feedbackHistoryCache.splice(index, 1);
  await persistFeedbackHistory();
  return deletedEntry;
}

async function clearAllFeedbackEntries() {
  await ensureFeedbackHistoryLoaded();
  const removedCount = feedbackHistoryCache.length;
  feedbackHistoryCache = [];
  await persistFeedbackHistory();
  return removedCount;
}

function sendSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastFeedbackEvent(eventName, payload) {
  for (const client of feedbackStreamClients) {
    try {
      sendSseEvent(client, eventName, payload);
    } catch (error) {
      logErrorSafe(error);
    }
  }
}

function broadcastFeedbackEntry(entry) {
  broadcastFeedbackEvent("feedback", entry);
}

const feedbackWebhookSystem = createFeedbackWebhookSystem({
  portalDataDir: PORTAL_DATA_DIR,
  discordWebhookUrl: DISCORD_WEBHOOK_URL,
  customFeedbackWebhookUrl: CUSTOM_FEEDBACK_WEBHOOK_URL,
  feedbackMaxLength: FEEDBACK_MAX_LENGTH,
  logError: logErrorSafe
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  if (LOCAL_ONLY && !isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).send("This server is running in LOCAL_ONLY mode.");
    return;
  }

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Vary", "Accept-Encoding");
  next();
});

app.get("/api/config", async (req, res) => {
  const discordInviteUrl = normalizeHttpUrl(DISCORD_INVITE_URL);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    discordInviteUrl: discordInviteUrl || null,
    feedbackEnabled: feedbackWebhookSystem.isEnabled,
    feedbackMode: feedbackWebhookSystem.primaryMode,
    feedbackDashboardUrl: "/portal/feedback.html"
  });
});

app.get("/api/feedback/list", async (req, res, next) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), FEEDBACK_HISTORY_LIMIT)
      : 200;
    const history = await ensureFeedbackHistoryLoaded();
    const feedback = history.slice(-limit).reverse();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      total: history.length,
      feedback
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/feedback/:id", async (req, res, next) => {
  try {
    const feedbackId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!feedbackId) {
      res.status(400).json({
        error: "Missing feedback id.",
        message: "Route param :id is required."
      });
      return;
    }

    const deletedEntry = await deleteFeedbackEntryById(feedbackId);
    if (!deletedEntry) {
      res.status(404).json({
        error: "Feedback not found.",
        id: feedbackId
      });
      return;
    }

    broadcastFeedbackEvent("feedback_deleted", { id: feedbackId });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      id: feedbackId
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/feedback", async (req, res, next) => {
  try {
    const removedCount = await clearAllFeedbackEntries();
    broadcastFeedbackEvent("feedback_cleared", { removedCount });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      removedCount
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/feedback/stream", async (req, res, next) => {
  try {
    await ensureFeedbackHistoryLoaded();
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (res.flushHeaders) {
      res.flushHeaders();
    }

    const helloPayload = {
      ok: true,
      feedbackMode: feedbackWebhookSystem.primaryMode,
      connectedAt: Date.now()
    };
    sendSseEvent(res, "hello", helloPayload);
    feedbackStreamClients.add(res);

    const keepAliveInterval = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch (error) {
        logErrorSafe(error);
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(keepAliveInterval);
      feedbackStreamClients.delete(res);
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/stats/most-played", async (req, res, next) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), MAX_MOST_PLAYED_LIMIT)
      : DEFAULT_MOST_PLAYED_LIMIT;
    const { games } = await ensureGameCache({ autoRescan: false });
    const playStats = await ensurePlayStatsCache();
    const mostPlayedGames = getMostPlayedGames(games, playStats, limit);

    res.setHeader("Cache-Control", "no-store");
    res.json({
      total: mostPlayedGames.length,
      updatedAt: playStats.updatedAt,
      games: mostPlayedGames
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/stats/play", async (req, res, next) => {
  try {
    const slug = typeof req.body?.slug === "string" ? req.body.slug.trim() : "";
    if (!slug) {
      res.status(400).json({
        error: "Missing slug.",
        message: "Body must include a non-empty slug."
      });
      return;
    }

    const { bySlug } = await ensureGameCache({ autoRescan: false });
    if (!bySlug.has(slug)) {
      res.status(404).json({
        error: "Unknown game slug.",
        slug
      });
      return;
    }

    const playStats = await ensurePlayStatsCache();
    const previous = playStats.plays[slug] || { count: 0, lastPlayedAt: 0 };
    const playCount = Math.max(0, Number(previous.count) || 0) + 1;
    const lastPlayedAt = Date.now();

    playStats.plays[slug] = {
      count: playCount,
      lastPlayedAt
    };
    playStats.updatedAt = lastPlayedAt;
    await queuePlayStatsSave();

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      slug,
      playCount,
      lastPlayedAt
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/feedback", async (req, res, next) => {
  try {
    const message = sanitizeFeedbackText(req.body?.message);
    if (!message) {
      res.status(400).json({
        error: "Missing feedback message.",
        message: "Please enter feedback before sending."
      });
      return;
    }

    if (message.length > FEEDBACK_MAX_LENGTH) {
      res.status(400).json({
        error: "Feedback message is too long.",
        message: `Feedback must be ${FEEDBACK_MAX_LENGTH} characters or fewer.`
      });
      return;
    }

    const clientIp = getClientIp(req);
    const now = Date.now();
    const previousFeedbackAt = feedbackRateLimitByIp.get(clientIp) || 0;
    const msUntilAllowed = FEEDBACK_COOLDOWN_MS - (now - previousFeedbackAt);

    if (msUntilAllowed > 0) {
      const retryAfterSeconds = Math.ceil(msUntilAllowed / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "Feedback cooldown active.",
        message: `Please wait ${retryAfterSeconds} seconds before sending another message.`
      });
      return;
    }

    feedbackRateLimitByIp.set(clientIp, now);
    for (const [ip, timestamp] of feedbackRateLimitByIp.entries()) {
      if (now - timestamp > FEEDBACK_COOLDOWN_MS * 15) {
        feedbackRateLimitByIp.delete(ip);
      }
    }

    const selectedSlug = truncateText(sanitizeFeedbackText(req.body?.selectedSlug), 120);
    const selectedGameName = truncateText(sanitizeFeedbackText(req.body?.selectedGameName), 120);
    const pageUrl = truncateText(sanitizeFeedbackText(req.body?.pageUrl), 300);
    const userAgent = truncateText(String(req.headers["user-agent"] || "").trim(), 500);
    const deliveryResult = await feedbackWebhookSystem.sendFeedback({
      message,
      selectedSlug,
      selectedGameName,
      pageUrl,
      clientIp,
      userAgent,
      submittedAt: now
    });

    const feedbackEntry = {
      id: makeFeedbackId(now),
      message,
      selectedSlug,
      selectedGameName,
      pageUrl,
      clientIp,
      userAgent,
      submittedAt: now,
      mode: deliveryResult.mode,
      warning: deliveryResult.warning || null
    };

    rememberFeedbackEntry(feedbackEntry);
    await appendFeedbackLog(feedbackEntry);
    broadcastFeedbackEntry(feedbackEntry);

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      mode: deliveryResult.mode,
      warning: deliveryResult.warning || null,
      feedbackId: feedbackEntry.id
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/games", async (req, res, next) => {
  try {
    const forceRefresh = req.query.refresh === "1";
    const { games, updatedAt } = await ensureGameCache({
      force: forceRefresh,
      autoRescan: true
    });
    res.setHeader("Cache-Control", "no-store");

    res.json({
      host: HOST,
      port: PORT,
      total: games.length,
      updatedAt,
      games: games.map((game) => ({
        slug: game.slug,
        name: game.name,
        folder: game.folder,
        entryUrl: game.entryUrl,
        iconUrl: game.iconUrl || `/games/${encodeURIComponent(game.slug)}/icon.png`,
        entryRelativePath: game.entryRelativePath
      }))
    });
  } catch (error) {
    next(error);
  }
});

async function serveGameRequest(req, res, next, requestedPart = "") {
  try {
    const { bySlug } = await ensureGameCache({ autoRescan: false });
    const game = bySlug.get(req.params.slug);

    if (!game) {
      res.status(404).send("Game not found.");
      return;
    }

    const targetPart = requestedPart || game.entryRelativePath;
    const decodedPart = decodeURIComponent(targetPart);
    const absoluteTarget = resolveSafePath(game.baseDir, decodedPart);

    if (!absoluteTarget) {
      res.status(400).send("Invalid path.");
      return;
    }

    const targetPath = absoluteTarget;

    try {
      await sendGameFile(res, targetPath);
      return;
    } catch (error) {
      if (isClientDisconnectError(error)) {
        return;
      }

      if (error.code === "EISDIR") {
        const fallbackPath = path.join(targetPath, "index.html");
        try {
          await sendGameFile(res, fallbackPath);
          return;
        } catch (fallbackError) {
          if (isClientDisconnectError(fallbackError)) {
            return;
          }

          if (fallbackError.code === "ENOENT") {
            if (!res.headersSent) {
              res.status(404).send("File not found.");
            }
            return;
          }

          throw fallbackError;
        }
      }

      if (error.code === "ENOENT") {
        if (!res.headersSent) {
          res.status(404).send("File not found.");
        }
        return;
      }

      throw error;
    }
  } catch (error) {
    if (isClientDisconnectError(error)) {
      return;
    }
    next(error);
  }
}

app.get("/games/:slug", async (req, res, next) => {
  await serveGameRequest(req, res, next, "");
});

app.get("/games/:slug/*", async (req, res, next) => {
  await serveGameRequest(req, res, next, req.params[0] || "");
});

app.use("/portal", express.static(PORTAL_DIR, { index: "index.html" }));

app.get("/", async (req, res) => {
  res.sendFile(path.join(PORTAL_DIR, "index.html"));
});

app.use((error, req, res, next) => {
  if (isClientDisconnectError(error)) {
    return;
  }

  if (res.headersSent) {
    logErrorSafe(error);
    return;
  }

  logErrorSafe(error);
  res.status(500).json({
    error: "Unexpected server error.",
    message: error.message
  });
});

async function startServer() {
  const { games } = await ensureGameCache({ force: true, autoRescan: true });

  app.listen(PORT, HOST, () => {
    console.log(`School Games Portal listening on ${HOST}:${PORT}`);
    console.log(`Open on this computer: http://127.0.0.1:${PORT}`);
    const lanUrls = getLanIpv4Urls(PORT);
    if (lanUrls.length) {
      console.log(`Open on other devices (same network):`);
      for (const url of lanUrls) {
        console.log(`- ${url}`);
      }
    }
    console.log(`LOCAL_ONLY mode: ${LOCAL_ONLY ? "ON" : "OFF"}`);
    console.log(`Feedback mode: ${feedbackWebhookSystem.primaryMode}`);
    if (feedbackWebhookSystem.primaryMode === "local_inbox") {
      console.log(`Feedback inbox file: ${feedbackWebhookSystem.localInboxPath}`);
    }
    console.log(`Live feedback dashboard: http://127.0.0.1:${PORT}/portal/feedback.html`);
    console.log(`Discovered ${games.length} playable game folders.`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start School Games Portal:", error);
  process.exit(1);
});
