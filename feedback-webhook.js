const fs = require("fs/promises");
const path = require("path");

function normalizeHttpUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(String(value).trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return "";
  }

  return "";
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function createFeedbackWebhookSystem(options = {}) {
  const {
    portalDataDir,
    discordWebhookUrl = "",
    customFeedbackWebhookUrl = "",
    feedbackMaxLength = 1200,
    logError = () => {}
  } = options;

  const normalizedDiscordWebhookUrl = normalizeHttpUrl(discordWebhookUrl);
  const normalizedCustomFeedbackWebhookUrl = normalizeHttpUrl(customFeedbackWebhookUrl);
  const primaryMode = normalizedDiscordWebhookUrl
    ? "discord"
    : normalizedCustomFeedbackWebhookUrl
      ? "custom_webhook"
      : "local_inbox";
  const localInboxPath = path.join(portalDataDir, "feedback-inbox.ndjson");
  let localWriteQueue = Promise.resolve();

  async function appendLocalInbox(entry, metadata = {}) {
    const enrichedEntry = {
      ...entry,
      ...metadata,
      storedAt: Date.now()
    };
    const line = `${JSON.stringify(enrichedEntry)}\n`;

    localWriteQueue = localWriteQueue
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(portalDataDir, { recursive: true });
        await fs.appendFile(localInboxPath, line, "utf8");
      });

    await localWriteQueue;
  }

  function buildDiscordPayload(entry) {
    const selectedGameLabel =
      entry.selectedGameName && entry.selectedSlug
        ? `${entry.selectedGameName} (${entry.selectedSlug})`
        : entry.selectedGameName || entry.selectedSlug || "Not provided";

    return {
      username: "School Arcade Feedback",
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: "New Launcher Feedback",
          description: truncateText(entry.message, feedbackMaxLength),
          color: 9605316,
          fields: [
            { name: "Selected Game", value: truncateText(selectedGameLabel, 1024), inline: false },
            { name: "Page URL", value: truncateText(entry.pageUrl || "Not provided", 1024), inline: false },
            { name: "Client IP", value: truncateText(entry.clientIp || "unknown", 1024), inline: true },
            { name: "User Agent", value: truncateText(entry.userAgent || "Not provided", 1024), inline: false }
          ],
          timestamp: new Date(entry.submittedAt || Date.now()).toISOString()
        }
      ]
    };
  }

  async function postDiscord(entry) {
    const response = await fetch(normalizedDiscordWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildDiscordPayload(entry))
    });

    if (response.ok) {
      return;
    }

    const webhookErrorBody = truncateText(await response.text(), 300);
    throw new Error(
      `Discord webhook rejected feedback (${response.status}): ${webhookErrorBody || "No response body"}`
    );
  }

  async function postCustomWebhook(entry) {
    const customPayload = {
      eventType: "launcher_feedback",
      message: entry.message,
      selectedSlug: entry.selectedSlug || "",
      selectedGameName: entry.selectedGameName || "",
      pageUrl: entry.pageUrl || "",
      clientIp: entry.clientIp || "",
      userAgent: entry.userAgent || "",
      submittedAt: entry.submittedAt || Date.now()
    };

    const response = await fetch(normalizedCustomFeedbackWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(customPayload)
    });

    if (response.ok) {
      return;
    }

    const customErrorBody = truncateText(await response.text(), 300);
    throw new Error(
      `Custom webhook rejected feedback (${response.status}): ${customErrorBody || "No response body"}`
    );
  }

  async function sendFeedback(entry) {
    if (primaryMode === "local_inbox") {
      await appendLocalInbox(entry, { deliveryMode: "local_inbox" });
      return {
        ok: true,
        mode: "local_inbox"
      };
    }

    try {
      if (primaryMode === "discord") {
        await postDiscord(entry);
      } else {
        await postCustomWebhook(entry);
      }

      return {
        ok: true,
        mode: primaryMode
      };
    } catch (error) {
      logError(error);
      await appendLocalInbox(entry, {
        deliveryMode: "local_fallback",
        failedPrimaryMode: primaryMode,
        failureMessage: truncateText(error?.message || String(error), 1000)
      });

      return {
        ok: true,
        mode: "local_fallback",
        warning:
          primaryMode === "discord"
            ? "Discord webhook failed, feedback was saved locally."
            : "Custom webhook failed, feedback was saved locally."
      };
    }
  }

  return {
    isEnabled: true,
    primaryMode,
    localInboxPath,
    sendFeedback
  };
}

module.exports = {
  createFeedbackWebhookSystem,
  normalizeHttpUrl
};
