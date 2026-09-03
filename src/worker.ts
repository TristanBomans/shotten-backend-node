/**
 * Shotten Scraper Worker
 *
 * This is a minimal version of the backend that only runs the scheduled jobs:
 * - LZV Scraper (daily at 03:00)
 * - iCal Match Sync (every 4 hours)
 * - Web Push outbox flush (every minute)
 * - Match notification dispatch (attendance 2 weeks / evening before, kickoff morning / 1h)
 *
 * Jobs and admin endpoints can be toggled with FEATURE_* environment variables.
 * All data is stored in Supabase instead of MongoDB.
 * The API is now served by Cloudflare Pages (Next.js app).
 */

import express, { Response } from "express";
import cors from "cors";
import cron from "node-cron";
import axios from "axios";
import { ScraperServiceSupabase } from "./services/scraperSupabase";
import { MatchSyncServiceSupabase } from "./services/matchSyncServiceSupabase";
import { BackupService } from "./services/backupService";
import { dispatchMatchPushNotifications } from "./services/pushDispatch";
import { getSupabase } from "./config/supabase";
import { LoggerService } from "./services/loggerService";
import { linkCoreMatchesToLzv } from "./services/linkCoreMatches";
import { config, logConfigSummary, validateConfig } from "./config/env";

validateConfig();
LoggerService.init();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = config.port;

console.log("=".repeat(60));
console.log("Shotten Scraper Worker");
console.log("=".repeat(60));
console.log("");
console.log(
  "This worker runs scheduled jobs and provides manual trigger endpoints.",
);
console.log("API is served by Cloudflare Pages.");
console.log("Database: Supabase (PostgreSQL)");
console.log("");
logConfigSummary();
console.log("");

function featureDisabled(res: Response, feature: string): void {
  res.status(404).json({
    success: false,
    error: `Feature ${feature} is disabled`,
    feature,
  });
}

// Run initial sync on startup
async function runInitialSync() {
  console.log("Running initial iCal match sync...");
  try {
    await MatchSyncServiceSupabase.syncMatches();
    console.log("Initial match sync complete.");
  } catch (error) {
    console.error("Initial match sync failed:", error);
  }
}

if (config.features.icalSync) {
  void runInitialSync();
}

// ============================================================================
// CRON JOBS
// ============================================================================

if (config.features.lzvScrape) {
  cron.schedule("0 3 * * *", () => {
    console.log("Running daily LZV scrape job...");
    ScraperServiceSupabase.scrapeAll();
  });
}

if (config.features.icalSync) {
  cron.schedule("0 */4 * * *", () => {
    console.log("Running iCal match sync job...");
    MatchSyncServiceSupabase.syncMatches();
  });
}

if (config.features.backup) {
  cron.schedule("0 2 * * *", () => {
    console.log("Running daily Supabase backup job...");
    BackupService.runBackup()
      .then(() => console.log("Daily backup completed successfully."))
      .catch((err) => console.error("Daily backup failed:", err));
  });
}

async function flushPushOutbox() {
  const url = config.push.flushUrl;
  const secret = config.push.secret;
  if (!url || !secret) return;

  try {
    const response = await axios.post(url, null, {
      headers: { Authorization: `Bearer ${secret}` },
      timeout: 20_000,
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      console.error(
        `Push outbox flush HTTP ${response.status}:`,
        typeof response.data === "string"
          ? response.data.slice(0, 300)
          : response.data,
      );
      return;
    }

    const sent = Number(response.data?.sent ?? 0);
    const failed = Number(response.data?.failed ?? 0);
    if (sent > 0 || failed > 0) {
      console.log(`Push outbox flushed: sent=${sent} failed=${failed}`);
    }
  } catch (error) {
    console.error("Push outbox flush failed:", error);
  }
}

if (config.features.push) {
  cron.schedule("* * * * *", () => {
    void (async () => {
      await dispatchMatchPushNotifications();
      await flushPushOutbox();
    })();
  });
  setTimeout(() => {
    void (async () => {
      await dispatchMatchPushNotifications();
      await flushPushOutbox();
    })();
  }, 5_000);
}

// ============================================================================
// MANUAL TRIGGER ENDPOINTS
// ============================================================================

/**
 * GET /api/lzv/scrape/trigger
 * Manually trigger a full LZV scrape
 */
app.get("/api/lzv/scrape/trigger", async (req, res) => {
  if (!config.features.lzvScrape) return featureDisabled(res, "lzv_scrape");

  console.log("Manual scrape trigger requested...");
  try {
    // Run async - don't wait for completion
    ScraperServiceSupabase.scrapeAll()
      .then(() => console.log("Manual scrape completed successfully."))
      .catch((err) => console.error("Manual scrape failed:", err));

    res.json({
      success: true,
      message:
        "Scrape job started. This runs in the background and may take a few minutes.",
    });
  } catch (error) {
    console.error("Failed to start scrape:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to start scrape job" });
  }
});

/**
 * POST /api/lzv/link-matches
 * Match core iCal matches to scraped LZV fixtures
 */
app.post("/api/lzv/link-matches", async (req, res) => {
  if (!config.features.lzvScrape) return featureDisabled(res, "lzv_scrape");

  console.log("Manual core-to-LZV match linking requested...");
  try {
    const result = await linkCoreMatchesToLzv();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Failed to link matches:", error);
    res.status(500).json({ success: false, error: "Failed to link matches" });
  }
});

/**
 * POST /api/lzv/scrape/reset-players
 * Reset all LZV players data (clears player_team_stats and optionally players)
 */
app.post("/api/lzv/scrape/reset-players", async (req, res) => {
  if (!config.features.lzvScrape) return featureDisabled(res, "lzv_scrape");

  console.log("Reset players requested...");
  try {
    const supabase = getSupabase();

    // First delete all player team stats
    const { error: statsError } = await supabase
      .from("lzv_player_team_stats")
      .delete()
      .neq("id", 0); // Delete all rows

    if (statsError) {
      console.error("Error deleting player stats:", statsError);
      return res
        .status(500)
        .json({ success: false, error: "Failed to delete player stats" });
    }

    // Optionally delete players too (based on query param)
    const deletePlayers = req.query.deletePlayers === "true";
    if (deletePlayers) {
      const { error: playersError } = await supabase
        .from("lzv_players")
        .delete()
        .neq("id", 0); // Delete all rows

      if (playersError) {
        console.error("Error deleting players:", playersError);
        return res
          .status(500)
          .json({ success: false, error: "Failed to delete players" });
      }
    }

    console.log(
      `Players reset complete. Stats deleted: true, Players deleted: ${deletePlayers}`,
    );
    res.json({
      success: true,
      message: `Player stats cleared.${deletePlayers ? " Players also deleted." : " Players retained."}`,
    });
  } catch (error) {
    console.error("Failed to reset players:", error);
    res.status(500).json({ success: false, error: "Failed to reset players" });
  }
});

/**
 * POST /api/backup/trigger
 * Manually trigger a database backup
 */
app.post("/api/backup/trigger", async (req, res) => {
  if (!config.features.backup) return featureDisabled(res, "backup");

  console.log("Manual backup trigger requested...");
  try {
    // Run async - don't wait for completion
    BackupService.runBackup()
      .then(() => console.log("Manual backup completed successfully."))
      .catch((err) => console.error("Manual backup failed:", err));

    res.json({
      success: true,
      message:
        "Backup job started. This runs in the background and may take a few minutes.",
    });
  } catch (error) {
    console.error("Failed to start backup:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to start backup job" });
  }
});

/**
 * GET /api/backup/list
 * List all available backups
 */
app.get("/api/backup/list", (req, res) => {
  if (!config.features.backup) return featureDisabled(res, "backup");

  try {
    const backups = BackupService.listBackups();
    res.json({
      success: true,
      backups,
      count: backups.length,
      backupDir: config.backup.dir,
    });
  } catch (error) {
    console.error("Failed to list backups:", error);
    res.status(500).json({ success: false, error: "Failed to list backups" });
  }
});

/**
 * GET /api/backup/status
 * Get the latest backup health and metadata
 */
app.get("/api/backup/status", (req, res) => {
  if (!config.features.backup) return featureDisabled(res, "backup");

  try {
    const status = BackupService.getBackupStatus();
    res.json({
      success: true,
      backupDir: config.backup.dir,
      ...status,
    });
  } catch (error) {
    console.error("Failed to get backup status:", error);
    res.status(500).json({ success: false, error: "Failed to get backup status" });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    features: config.features,
  });
});

/**
 * GET /api/logs
 * Read, filter, and paginate application logs.
 *
 * Query params:
 * - date    (string)  Filter to a specific date file (YYYY-MM-DD). Defaults to today.
 * - level   (string)  Filter by level: log | error | warn | info.
 * - search  (string)  Case-insensitive substring search across messages.
 * - page    (number)  Page number, starting at 1. Default: 1.
 * - limit   (number)  Entries per page, max 1000. Default: 100.
 * - reverse (boolean) Newest first when true. Default: true.
 *
 * Searches both current log files and legacy backup logs in logbackups/.
 */
app.get("/api/logs", (req, res) => {
  if (!config.features.logs) return featureDisabled(res, "logs");

  try {
    const logs = LoggerService.query({
      date: (req.query.date as string) || undefined,
      level: (req.query.level as string) || undefined,
      search: (req.query.search as string) || undefined,
      page: parseInt(req.query.page as string) || 1,
      limit: Math.min(parseInt(req.query.limit as string) || 100, 1000),
      reverse: req.query.reverse !== "false",
    });
    res.json({ success: true, ...logs });
  } catch (error) {
    console.error("Failed to read logs:", error);
    res.status(500).json({ success: false, error: "Failed to read logs" });
  }
});

/**
 * POST /api/ical/sync/trigger
 * Manually trigger an iCal match sync
 */
app.post("/api/ical/sync/trigger", async (req, res) => {
  if (!config.features.icalSync) return featureDisabled(res, "ical_sync");

  console.log("Manual iCal sync trigger requested...");
  try {
    MatchSyncServiceSupabase.syncMatches()
      .then(() => console.log("Manual iCal sync completed successfully."))
      .catch((err) => console.error("Manual iCal sync failed:", err));

    res.json({
      success: true,
      message: "iCal sync started. This runs in the background.",
    });
  } catch (error) {
    console.error("Failed to start iCal sync:", error);
    res.status(500).json({ success: false, error: "Failed to start iCal sync" });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log("");
  console.log("Scheduled jobs:");
  console.log(
    `  - LZV Scraper: ${config.features.lzvScrape ? "Daily at 03:00" : "disabled"}`,
  );
  console.log(
    `  - iCal Sync: ${config.features.icalSync ? "Every 4 hours" : "disabled"}`,
  );
  console.log(
    `  - Supabase Backup: ${config.features.backup ? "Daily at 02:00" : "disabled"}`,
  );
  console.log(
    `  - Web Push flush: ${config.features.push ? "Every minute" : "disabled"}`,
  );
  console.log(
    `  - Match push dispatch: ${config.features.push ? "Every minute" : "disabled"}`,
  );
  console.log("");
  console.log("Manual endpoints:");
  if (config.features.lzvScrape) {
    console.log(`  - GET  /api/lzv/scrape/trigger`);
    console.log(`  - POST /api/lzv/link-matches`);
    console.log(`  - POST /api/lzv/scrape/reset-players`);
  }
  if (config.features.icalSync) {
    console.log(`  - POST /api/ical/sync/trigger`);
  }
  if (config.features.backup) {
    console.log(`  - POST /api/backup/trigger`);
    console.log(`  - GET  /api/backup/list`);
    console.log(`  - GET  /api/backup/status`);
  }
  if (config.features.logs) {
    console.log(`  - GET  /api/logs`);
  }
  console.log(`  - GET  /health`);
  console.log("");
  console.log(`Worker is running on port ${PORT}. Press Ctrl+C to stop.`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down worker...");
  process.exit(0);
});
