/**
 * Supabase Backup Service
 *
 * Creates daily PostgreSQL backups using pg_dump.
 * Backups are stored in the configured backup directory.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readdirSync, unlinkSync, statSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config/env';

const execAsync = promisify(exec);

function backupDir(): string {
    return config.backup.dir;
}

export class BackupService {
    /**
     * Run a full database backup
     */
    static async runBackup(): Promise<void> {
        const startTime = Date.now();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = `supabase_backup_${timestamp}.dump`;
        const backupPath = join(backupDir(), backupFile);

        console.log('='.repeat(60));
        console.log('Starting Supabase backup...');
        console.log(`Backup file: ${backupFile}`);
        console.log(`Backup directory: ${backupDir()}`);
        console.log('='.repeat(60));

        // Check if backup directory exists
        if (!existsSync(backupDir())) {
            throw new Error(`Backup directory does not exist: ${backupDir()}`);
        }

        // Check if password is configured
        if (!config.backup.dbPassword) {
            throw new Error('SUPABASE_DB_PASSWORD is not configured');
        }

        try {
            // Run pg_dump with custom format (compressed)
            // PGCONNECT_TIMEOUT: abort if connection takes too long
            // PGHOSTADDR: force IPv4 by resolving hostname beforehand
            const env = {
                ...process.env,
                PGPASSWORD: config.backup.dbPassword,
                PGCONNECT_TIMEOUT: '30'
            };

            const dumpCmd = `pg_dump \
                --host=${config.backup.dbHost} \
                --port=${config.backup.dbPort} \
                --username=${config.backup.dbUser} \
                --dbname=${config.backup.dbName} \
                --format=custom \
                --file=${backupPath}`;

            console.log('Executing pg_dump...');
            const { stdout, stderr } = await execAsync(dumpCmd, { env });

            if (stderr) {
                console.warn('pg_dump stderr:', stderr);
            }

            if (stdout) {
                console.log('pg_dump stdout:', stdout);
            }

            const durationMs = Date.now() - startTime;
            const fileSize = this.getFileSize(backupPath);

            console.log(`✓ Backup completed: ${backupFile}`);
            console.log(`  Size: ${fileSize}`);
            console.log(`  Duration: ${(durationMs / 1000).toFixed(2)}s`);

            // Persist status for API inspection
            this.writeStatusFile({
                lastBackupAt: new Date().toISOString(),
                fileName: backupFile,
                fileSize,
                durationMs,
                success: true
            });

            // Clean up old backups
            await this.cleanupOldBackups();

            console.log('='.repeat(60));
            console.log('Backup process completed successfully');
            console.log('='.repeat(60));

        } catch (error) {
            const durationMs = Date.now() - startTime;
            this.writeStatusFile({
                lastBackupAt: new Date().toISOString(),
                fileName: backupFile,
                fileSize: '0 B',
                durationMs,
                success: false
            });
            console.error('✗ Backup failed:', error);
            throw error;
        }
    }

    /**
     * Clean up backup files older than the configured retention window
     */
    private static async cleanupOldBackups(): Promise<void> {
        console.log(`\nCleaning up backups older than ${config.backup.retentionDays} days...`);

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - config.backup.retentionDays);

        const files = readdirSync(backupDir());
        let deletedCount = 0;

        for (const file of files) {
            if (!file.startsWith('supabase_backup_') || !file.endsWith('.dump')) {
                continue;
            }

            const filePath = join(backupDir(), file);
            const stats = await execAsync(`stat -c %Y "${filePath}"`);
            const fileTime = parseInt(stats.stdout.trim()) * 1000;

            if (fileTime < cutoffDate.getTime()) {
                unlinkSync(filePath);
                console.log(`  Deleted old backup: ${file}`);
                deletedCount++;
            }
        }

        if (deletedCount === 0) {
            console.log('  No old backups to clean up');
        } else {
            console.log(`  Deleted ${deletedCount} old backup(s)`);
        }
    }

    /**
     * Get human-readable file size
     */
    private static getFileSize(filePath: string): string {
        try {
            const stats = statSync(filePath);
            const bytes = stats.size;

            if (bytes === 0) return '0 B';

            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));

            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        } catch {
            return 'unknown';
        }
    }

    /**
     * Persist backup status to JSON file for API inspection
     */
    private static writeStatusFile(status: {
        lastBackupAt: string;
        fileName: string;
        fileSize: string;
        durationMs: number;
        success: boolean;
    }): void {
        try {
            const statusPath = join(backupDir(), 'backup_status.json');
            writeFileSync(statusPath, JSON.stringify(status, null, 2), 'utf8');
        } catch {
            // Non-fatal: status file is best-effort
        }
    }

    /**
     * Get the latest backup status with file metadata
     */
    static getBackupStatus(): {
        hasBackups: boolean;
        totalCount: number;
        latest?: {
            fileName: string;
            fileSize: string;
            createdAt: string;
            durationSeconds: number | null;
            success: boolean | null;
            isHealthy: boolean;
            hoursSince: number;
        };
    } {
        const backups = this.listBackups();
        const totalCount = backups.length;
        const hasBackups = totalCount > 0;

        if (!hasBackups) {
            return { hasBackups: false, totalCount: 0 };
        }

        const latestFile = backups[0];
        const latestPath = join(backupDir(), latestFile);
        let fileSize = 'unknown';
        let createdAt = '';

        try {
            const stats = statSync(latestPath);
            fileSize = this.getFileSize(latestPath);
            createdAt = new Date(stats.mtime).toISOString();
        } catch {
            // Fallback: try to parse timestamp from filename
            createdAt = this.parseTimestampFromFileName(latestFile);
        }

        // Try to read persisted status for duration/success
        let durationSeconds: number | null = null;
        let success: boolean | null = null;
        try {
            const statusPath = join(backupDir(), 'backup_status.json');
            if (existsSync(statusPath)) {
                const raw = readFileSync(statusPath, 'utf8');
                const status = JSON.parse(raw);
                if (status.fileName === latestFile) {
                    durationSeconds = parseFloat((status.durationMs / 1000).toFixed(2));
                    success = status.success;
                }
            }
        } catch {
            // Ignore status read errors
        }

        // Cold-start: if no status file exists for the latest dump, infer duration from
        // filename timestamp (start) vs file modification time (end)
        if (durationSeconds === null && createdAt) {
            const startFromFileName = this.parseTimestampFromFileName(latestFile);
            let inferredDurationMs = 0;
            try {
                const stats = statSync(latestPath);
                const endTime = stats.mtime.getTime();
                const startTime = new Date(startFromFileName).getTime();
                if (startTime && endTime > startTime) {
                    inferredDurationMs = endTime - startTime;
                }
            } catch {
                // ignore
            }

            this.writeStatusFile({
                lastBackupAt: createdAt,
                fileName: latestFile,
                fileSize,
                durationMs: inferredDurationMs,
                success: true
            });
            durationSeconds = parseFloat((inferredDurationMs / 1000).toFixed(2));
            success = true;
        }

        const hoursSince = createdAt
            ? parseFloat(((Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60)).toFixed(2))
            : Infinity;

        // Daily cron at 02:00 -> healthy if within ~25 hours
        const isHealthy = (success === null || success === true) && hoursSince < 25;

        return {
            hasBackups: true,
            totalCount,
            latest: {
                fileName: latestFile,
                fileSize,
                createdAt,
                durationSeconds,
                success,
                isHealthy,
                hoursSince
            }
        };
    }

    private static parseTimestampFromFileName(fileName: string): string {
        const match = fileName.match(/supabase_backup_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
        if (match) {
            const [, y, m, d, h, min, s] = match;
            return `${y}-${m}-${d}T${h}:${min}:${s}.000Z`;
        }
        return '';
    }

    /**
     * List all available backups
     */
    static listBackups(): string[] {
        if (!existsSync(backupDir())) {
            return [];
        }

        return readdirSync(backupDir())
            .filter(file => file.startsWith('supabase_backup_') && file.endsWith('.dump'))
            .sort()
            .reverse();
    }
}
