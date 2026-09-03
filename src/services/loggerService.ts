/**
 * Logger Service
 *
 * Intercepts console.* output and writes it to dated log files.
 * Also exposes a query API for reading, filtering, and paginating logs.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { LogLevel, LogEntry, QueryOptions, QueryResult } from "../types/logger.types";
import { config } from "../config/env";

function logDir(): string {
  return config.logs.dir;
}

function legacyLogDir(): string {
  return config.logs.legacyDir;
}
const WALL_CLOCK_START_NS = BigInt(Date.now()) * 1_000_000n;
const MONOTONIC_START_NS = process.hrtime.bigint();

function getLogFilePath(dateStr: string): string {
  return join(logDir(), `app_${dateStr}.log`);
}

function getCurrentTimestampNs(): bigint {
  return WALL_CLOCK_START_NS + (process.hrtime.bigint() - MONOTONIC_START_NS);
}

function formatTimestampNs(timestampNs: bigint): string {
  const date = new Date(Number(timestampNs / 1_000_000n));
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ns = String(timestampNs % 1_000_000_000n).padStart(9, "0");
  return `${y}-${m}-${d} ${h}:${min}:${s}.${ns}`;
}

function normalizeIsoTimestampLossless(isoTimestamp: string): string {
  return isoTimestamp.replace("T", " ").replace(/Z$/, "");
}

function normalizeTimestampForSort(timestamp: string): string {
  const match = timestamp.match(
    /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d+))?$/
  );
  if (!match) return timestamp;

  const fraction = (match[2] || "").padEnd(9, "0").slice(0, 9);
  return `${match[1]}.${fraction}`;
}

function getToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export class LoggerService {
  private static originalLog: typeof console.log;
  private static originalError: typeof console.error;
  private static originalWarn: typeof console.warn;
  private static originalInfo: typeof console.info;
  private static initialized = false;

  static init(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (!existsSync(logDir())) {
      mkdirSync(logDir(), { recursive: true });
    }

    this.originalLog = console.log;
    this.originalError = console.error;
    this.originalWarn = console.warn;
    this.originalInfo = console.info;

    console.log = (...args: unknown[]) => {
      this.write("LOG", args);
      this.originalLog(...args);
    };

    console.error = (...args: unknown[]) => {
      this.write("ERROR", args);
      this.originalError(...args);
    };

    console.warn = (...args: unknown[]) => {
      this.write("WARN", args);
      this.originalWarn(...args);
    };

    console.info = (...args: unknown[]) => {
      this.write("INFO", args);
      this.originalInfo(...args);
    };
  }

  private static write(level: LogLevel, args: unknown[]): void {
    try {
      const timestamp = formatTimestampNs(getCurrentTimestampNs());
      const message = args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return arg.stack || arg.message;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ");

      const line = `${timestamp} [${level}] ${message}\n`;
      const filePath = getLogFilePath(getToday());
      appendFileSync(filePath, line, { encoding: "utf8" });
    } catch {
      // Fail silently so logging never breaks the app
    }
  }

  static query(options: QueryOptions = {}): QueryResult {
    const hasSpecificDate = !!options.date;
    const targetDate = options.date || getToday();
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(1000, Math.max(1, options.limit || 100));
    const reverse = options.reverse !== false;

    let entries: LogEntry[] = [];

    // Read modern log files
    if (hasSpecificDate) {
      const filePath = getLogFilePath(targetDate);
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, "utf8");
        const lines = content.split("\n").filter((line) => line.trim().length > 0);

        for (const line of lines) {
          const match = line.match(
            /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?) \[(LOG|ERROR|WARN|INFO)\] (.*)$/
          );
          if (match) {
            entries.push({
              timestamp: match[1],
              level: match[2] as LogLevel,
              message: match[3],
            });
          }
        }
      }
    } else {
      if (existsSync(logDir())) {
        const modernFiles = readdirSync(logDir()).filter(
          (f) => f.startsWith("app_") && f.endsWith(".log")
        );
        for (const file of modernFiles) {
          const filePath = join(logDir(), file);
          if (!existsSync(filePath)) continue;
          const content = readFileSync(filePath, "utf8");
          const lines = content.split("\n").filter((line) => line.trim().length > 0);

          for (const line of lines) {
            const match = line.match(
              /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?) \[(LOG|ERROR|WARN|INFO)\] (.*)$/
            );
            if (match) {
              entries.push({
                timestamp: match[1],
                level: match[2] as LogLevel,
                message: match[3],
              });
            }
          }
        }
      }
    }

    // Include legacy log backups alongside modern logs
    if (existsSync(legacyLogDir())) {
      const legacyFiles = readdirSync(legacyLogDir()).filter((f) => f.endsWith(".txt"));
      for (const legacyFile of legacyFiles) {
        const legacyPath = join(legacyLogDir(), legacyFile);
        const content = readFileSync(legacyPath, "utf8");
        const lines = content.split("\n").filter((line) => line.trim().length > 0);

        for (const line of lines) {
          const trimmed = line.trim();

          // Try to extract an ISO timestamp from the start of the line
          const tsMatch = trimmed.match(
            /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z\s*/
          );

          let parsedTimestamp = "";
          let messageBody = trimmed;

          if (tsMatch) {
            const isoTs = tsMatch[1];
            const lineDate = isoTs.slice(0, 10);
            if (hasSpecificDate && lineDate !== targetDate) {
              continue; // Skip legacy entries that don't match the requested date
            }
            parsedTimestamp = normalizeIsoTimestampLossless(isoTs);
            messageBody = trimmed.slice(tsMatch[0].length).trim();
          }

          // If we couldn't parse a timestamp, we can't verify the date — skip it
          if (!parsedTimestamp) {
            continue;
          }

          const lower = messageBody.toLowerCase();
          let level: LogLevel = "LOG";
          if (lower.includes("error") || lower.includes("failed") || lower.includes("✗")) {
            level = "ERROR";
          } else if (lower.includes("warn")) {
            level = "WARN";
          }

          entries.push({
            timestamp: parsedTimestamp,
            level,
            message: messageBody,
            legacy: true,
          });
        }
      }
    }

    entries = entries.filter((e) => e.message.trim().length > 0);

    const levelFilter = options.level?.toUpperCase();
    if (levelFilter && ["LOG", "ERROR", "WARN", "INFO"].includes(levelFilter)) {
      entries = entries.filter((e) => e.level === levelFilter);
    }

    const searchFilter = options.search?.trim().toLowerCase();
    if (searchFilter) {
      entries = entries.filter(
        (e) =>
          e.message.toLowerCase().includes(searchFilter) ||
          e.timestamp.includes(searchFilter) ||
          e.level.toLowerCase().includes(searchFilter)
      );
    }

    // Sort globally by timestamp before paginating
    entries.sort((a, b) => {
      const ta = normalizeTimestampForSort(a.timestamp);
      const tb = normalizeTimestampForSort(b.timestamp);
      return reverse ? tb.localeCompare(ta) : ta.localeCompare(tb);
    });

    const total = entries.length;
    const start = (page - 1) * limit;
    const paginated = entries.slice(start, start + limit);

    return {
      ...(hasSpecificDate && { date: targetDate }),
      total,
      page,
      limit,
      logs: paginated,
    };
  }
}
