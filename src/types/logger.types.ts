/**
 * Logger types
 */

export type LogLevel = "LOG" | "ERROR" | "WARN" | "INFO";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  legacy?: boolean;
}

export interface QueryOptions {
  date?: string;
  level?: string;
  search?: string;
  page?: number;
  limit?: number;
  reverse?: boolean;
}

export interface QueryResult {
  date?: string;
  total: number;
  page: number;
  limit: number;
  logs: LogEntry[];
}
