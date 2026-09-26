/**
 * Central environment config for the scraper worker.
 *
 * Feature flags default to ON so the existing Shotten deploy keeps running
 * if a flag is omitted. Other teams can turn jobs off and override URLs.
 */
import dotenv from "dotenv";

dotenv.config();

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

// Accepts the raw base64url private key or the JWK form (its "d" field).
function parseVapidPrivateKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const jwk = JSON.parse(trimmed) as { d?: unknown };
    return typeof jwk.d === "string" ? jwk.d : "";
  } catch {
    return "";
  }
}

const features = {
  lzvScrape: parseBool(process.env.FEATURE_LZV_SCRAPE, true),
  icalSync: parseBool(process.env.FEATURE_ICAL_SYNC, true),
  push: parseBool(process.env.FEATURE_PUSH, true),
  backup: parseBool(process.env.FEATURE_BACKUP, true),
  logs: parseBool(process.env.FEATURE_LOGS, true),
};

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || "";

const icalUrl = (process.env.ICAL_URL || "").trim();
const icalUrls = parseCsv(process.env.ICAL_URLS);
const explicitIcalUrls = [...new Set([...(icalUrl ? [icalUrl] : []), ...icalUrls])];
const icalUrlTemplate =
  process.env.ICAL_URL_TEMPLATE ||
  "https://www.lzvcup.be/icalendar.php?id={id}";

const lzvBaseUrl = stripTrailingSlash(
  process.env.LZV_BASE_URL || "https://www.lzvcup.be",
);

const vapidPublicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();
const vapidPrivateKey = parseVapidPrivateKey(process.env.VAPID_PRIVATE_KEY || "");
const vapidSubject = (process.env.VAPID_SUBJECT || "").trim();
const pushAppOrigin = stripTrailingSlash(process.env.PUSH_APP_ORIGIN || "");

const pushEnabled =
  features.push && Boolean(vapidPublicKey && vapidPrivateKey && vapidSubject);

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  timezone: process.env.TIMEZONE || "Europe/Brussels",
  features: {
    ...features,
    push: pushEnabled,
  },
  supabase: {
    url: supabaseUrl,
    serviceKey: supabaseServiceKey,
  },
  ical: {
    urls: explicitIcalUrls,
    urlTemplate: icalUrlTemplate,
  },
  lzv: {
    baseUrl: lzvBaseUrl,
  },
  push: {
    vapidPublicKey,
    vapidPrivateKey,
    vapidSubject,
    appOrigin: pushAppOrigin,
  },
  backup: {
    dir: process.env.BACKUP_DIR || "/backups",
    dbHost: process.env.SUPABASE_DB_HOST || "",
    dbPort: process.env.SUPABASE_DB_PORT || "5432",
    dbName: process.env.SUPABASE_DB_NAME || "postgres",
    dbUser: process.env.SUPABASE_DB_USER || "postgres",
    dbPassword: process.env.SUPABASE_DB_PASSWORD || "",
    retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || "90", 10),
  },
  logs: {
    dir: process.env.LOG_DIR || "/logs",
    legacyDir: process.env.LEGACY_LOG_DIR || "logbackups",
  },
} as const;

export type AppConfig = typeof config;

export function lzvUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${config.lzv.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export function buildIcalUrl(lzvExternalId: number): string {
  return config.ical.urlTemplate.replace(/\{id\}/g, String(lzvExternalId));
}

export function validateConfig(): void {
  const errors: string[] = [];

  if (!config.supabase.url) {
    errors.push("SUPABASE_URL is required");
  }
  if (!config.supabase.serviceKey) {
    errors.push("SUPABASE_SERVICE_KEY is required");
  }

  if (features.icalSync && config.ical.urls.length === 0 && !config.ical.urlTemplate) {
    errors.push(
      "FEATURE_ICAL_SYNC is enabled but neither ICAL_URL / ICAL_URLS nor ICAL_URL_TEMPLATE is set",
    );
  }

  if (features.push && !pushEnabled) {
    console.warn(
      "FEATURE_PUSH is enabled but VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY or VAPID_SUBJECT is missing; push jobs disabled",
    );
  }

  if (features.backup && !config.backup.dbPassword) {
    console.warn(
      "FEATURE_BACKUP is enabled but SUPABASE_DB_PASSWORD is missing; backup job will fail if it runs",
    );
  }

  if (errors.length > 0) {
    throw new Error(`Invalid worker configuration:\n- ${errors.join("\n- ")}`);
  }
}

export function logConfigSummary(): void {
  console.log("Feature flags:");
  console.log(`  - LZV scrape: ${config.features.lzvScrape ? "ON" : "OFF"}`);
  console.log(`  - iCal sync:  ${config.features.icalSync ? "ON" : "OFF"}`);
  console.log(`  - Push:       ${config.features.push ? "ON" : "OFF"}`);
  console.log(`  - Backup:     ${config.features.backup ? "ON" : "OFF"}`);
  console.log(`  - Logs API:   ${config.features.logs ? "ON" : "OFF"}`);
  if (config.ical.urls.length > 0) {
    console.log(`iCal feeds: ${config.ical.urls.join(", ")}`);
  } else {
    console.log(`iCal template: ${config.ical.urlTemplate}`);
  }
  console.log(`LZV base URL: ${config.lzv.baseUrl}`);
  if (config.features.push) {
    console.log(`Push VAPID subject: ${config.push.vapidSubject}`);
    if (config.push.appOrigin) {
      console.log(`Push app origin: ${config.push.appOrigin}`);
    }
  }
}
