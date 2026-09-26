import webpush from 'web-push';
import {
    claimPushSent,
    deletePushOutbox,
    deletePushSubscription,
    getAttendancesByMatchIds,
    getCorePlayersWithTeams,
    getDuePushOutbox,
    getPushSubscriptionsForPlayers,
    getUpcomingCoreMatches,
    insertPushOutbox,
    recordPushOutboxFailure,
} from '../config/supabase';
import { config } from '../config/env';

export type AttendanceStatus = 'Present' | 'NotPresent' | 'Maybe' | null;
export type PushKind = 'attendance_2w' | 'attendance_eve' | 'kickoff_morning' | 'kickoff_1h';

const TIME_ZONE = config.timezone;
const APP_ORIGIN = config.push.appOrigin;
const LOOKAHEAD_DAYS = 16;
const HOUR_MS = 60 * 60 * 1000;
const FLUSH_BATCH = 50;
const MAX_ATTEMPTS = 5;
const PUSH_TTL_SECONDS = 12 * 60 * 60;

// Endpoints come from browsers via the PWA, and this runs on the homeserver:
// only talk to the real push services so a forged endpoint can't reach the LAN.
const PUSH_SERVICE_HOSTS = [
    'fcm.googleapis.com',
    'updates.push.services.mozilla.com',
    'web.push.apple.com',
    '.push.apple.com',
    '.notify.windows.com',
];

export interface MatchForPush {
    id: number;
    date: Date;
    name: string;
    location?: string | null;
}

export interface PushItem {
    playerId: number;
    matchId: number;
    kind: PushKind;
    title: string;
    body: string;
    url: string;
}

function brusselsParts(date: Date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((part) => part.type === type)?.value);
    return {
        year: value('year'),
        month: value('month'),
        day: value('day'),
        hour: value('hour'),
        minute: value('minute'),
    };
}

export function calendarDaysUntil(now: Date, matchDate: Date): number {
    const start = brusselsParts(now);
    const end = brusselsParts(matchDate);
    const startUtc = Date.UTC(start.year, start.month - 1, start.day);
    const endUtc = Date.UTC(end.year, end.month - 1, end.day);
    return Math.round((endUtc - startUtc) / 86_400_000);
}

export function kindsDue(now: Date, matchDate: Date, status: AttendanceStatus): PushKind[] {
    if (matchDate.getTime() <= now.getTime()) return [];

    const days = calendarDaysUntil(now, matchDate);
    const hour = brusselsParts(now).hour;
    const needsAttendance = status !== 'Present' && status !== 'NotPresent';
    const isPresent = status === 'Present';
    const kinds: PushKind[] = [];

    if (needsAttendance && (days === 14 || days === 13)) kinds.push('attendance_2w');
    if (needsAttendance && days === 1 && hour >= 18) kinds.push('attendance_eve');
    if (isPresent && days === 0 && hour >= 8 && now.getTime() < matchDate.getTime() - HOUR_MS) {
        kinds.push('kickoff_morning');
    }
    if (isPresent && now.getTime() >= matchDate.getTime() - HOUR_MS) {
        kinds.push('kickoff_1h');
    }

    return kinds;
}

function formatKickoffTime(matchDate: Date): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(matchDate);
}

export function buildPushCopy(kind: PushKind, match: MatchForPush, status: AttendanceStatus): { title: string; body: string } {
    const matchLabel = match.name || 'Match';
    const time = formatKickoffTime(match.date);

    if (kind === 'attendance_2w') {
        if (status === 'Maybe') {
            return {
                title: 'Still Deciding?',
                body: `2 weeks out — pick in or out for ${matchLabel}.`,
            };
        }
        return {
            title: 'Response Needed',
            body: `Match in 2 weeks — let us know if you're in for ${matchLabel}.`,
        };
    }

    if (kind === 'attendance_eve') {
        if (status === 'Maybe') {
            return {
                title: 'Still Deciding?',
                body: `"Maybe" won't cut it — pick in or out for tomorrow's ${matchLabel}.`,
            };
        }
        return {
            title: 'Response Needed',
            body: `Match is tomorrow — let us know if you're in for ${matchLabel}.`,
        };
    }

    if (kind === 'kickoff_morning') {
        return {
            title: 'Match today',
            body: `${matchLabel} · ${time}`,
        };
    }

    return {
        title: 'Kickoff in 1 hour',
        body: `${matchLabel} · ${time}`,
    };
}

function playerPlaysForTeam(teamIds: unknown, teamId: number | null | undefined): boolean {
    if (teamId == null) return false;
    if (!Array.isArray(teamIds)) return false;
    return teamIds.map(Number).includes(Number(teamId));
}

function matchDeepLink(matchId: number): string {
    const path = `/?modal=match&modalId=${matchId}`;
    if (!APP_ORIGIN) return path;
    return `${APP_ORIGIN}${path}`;
}

export function isPushServiceEndpoint(endpoint: string): boolean {
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        return false;
    }
    if (url.protocol !== 'https:') return false;
    return PUSH_SERVICE_HOSTS.some((host) =>
        host.startsWith('.') ? url.hostname.endsWith(host) : url.hostname === host,
    );
}

let isRunning = false;

export async function dispatchMatchPushNotifications(now: Date = new Date()): Promise<void> {
    if (!config.features.push) return;
    if (isRunning) return;
    isRunning = true;

    try {
        const until = new Date(now.getTime() + LOOKAHEAD_DAYS * 86_400_000);
        const matches = await getUpcomingCoreMatches(now, until);
        const upcoming = matches.filter((match) => !match.forfait);
        if (upcoming.length === 0) return;

        const matchIds = upcoming.map((match) => match.id as number);
        const [attendances, players] = await Promise.all([
            getAttendancesByMatchIds(matchIds),
            getCorePlayersWithTeams(),
        ]);

        const attendanceByMatch = new Map<number, Map<number, AttendanceStatus>>();
        for (const row of attendances) {
            const matchId = row.match_id as number;
            if (!attendanceByMatch.has(matchId)) attendanceByMatch.set(matchId, new Map());
            attendanceByMatch.get(matchId)!.set(row.player_id as number, row.status as AttendanceStatus);
        }

        const items: PushItem[] = [];
        for (const match of upcoming) {
            const matchDate = new Date(match.date);
            if (Number.isNaN(matchDate.getTime())) continue;
            const matchInfo: MatchForPush = {
                id: match.id,
                date: matchDate,
                name: match.name || match.team_name || 'Match',
                location: match.location,
            };
            const byPlayer = attendanceByMatch.get(match.id) || new Map();

            for (const player of players) {
                if (!playerPlaysForTeam(player.team_ids, match.team_id)) continue;
                const status = byPlayer.get(player.id) ?? null;
                const due = kindsDue(now, matchDate, status);
                for (const kind of due) {
                    const copy = buildPushCopy(kind, matchInfo, status);
                    items.push({
                        playerId: player.id,
                        matchId: match.id,
                        kind,
                        title: copy.title,
                        body: copy.body,
                        url: matchDeepLink(match.id),
                    });
                }
            }
        }

        if (items.length === 0) return;

        // Only claim reminders for players with a device, so someone who turns
        // notifications on later still gets the next due reminder.
        const subscriptions = await getPushSubscriptionsForPlayers([...new Set(items.map((item) => item.playerId))]);
        const subsByPlayer = new Map<number, typeof subscriptions>();
        for (const sub of subscriptions) {
            if (sub.player_id == null) continue;
            if (!subsByPlayer.has(sub.player_id)) subsByPlayer.set(sub.player_id, []);
            subsByPlayer.get(sub.player_id)!.push(sub);
        }
        const reachable = items.filter((item) => subsByPlayer.has(item.playerId));
        if (reachable.length === 0) return;

        const claimed = await claimPushSent(reachable.map((item) => ({
            player_id: item.playerId,
            match_id: item.matchId,
            kind: item.kind,
        })));
        const claimedKeys = new Set(claimed.map((row) => `${row.player_id}:${row.match_id}:${row.kind}`));

        const outbox = reachable
            .filter((item) => claimedKeys.has(`${item.playerId}:${item.matchId}:${item.kind}`))
            .flatMap((item) => subsByPlayer.get(item.playerId)!.map((sub) => ({
                endpoint: sub.endpoint,
                title: item.title,
                body: item.body,
                url: item.url,
                tag: item.kind,
            })));

        await insertPushOutbox(outbox);
        if (outbox.length > 0) {
            console.log(`Push dispatch: queued=${outbox.length} reminders=${claimed.length}`);
        }
    } catch (error) {
        console.error('Match push dispatch failed:', error);
    } finally {
        isRunning = false;
    }
}

let isFlushing = false;

export async function flushPushOutbox(now: Date = new Date()): Promise<void> {
    if (!config.features.push) return;
    if (isFlushing) return;
    isFlushing = true;

    let sent = 0;
    let failed = 0;
    let gone = 0;

    try {
        const rows = await getDuePushOutbox(now, FLUSH_BATCH);
        const vapidDetails = {
            subject: config.push.vapidSubject,
            publicKey: config.push.vapidPublicKey,
            privateKey: config.push.vapidPrivateKey,
        };

        for (const row of rows) {
            const keys = row.push_subscriptions;
            if (!keys || !isPushServiceEndpoint(row.endpoint)) {
                await deletePushSubscription(row.endpoint);
                gone += 1;
                continue;
            }

            try {
                await webpush.sendNotification(
                    { endpoint: row.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
                    JSON.stringify({
                        title: row.title,
                        body: row.body,
                        tag: row.tag || 'shotten',
                        data: { url: row.url || '/' },
                    }),
                    { vapidDetails, TTL: PUSH_TTL_SECONDS, timeout: 15_000 },
                );
                await deletePushOutbox(row.id);
                sent += 1;
            } catch (error) {
                const status = (error as { statusCode?: number }).statusCode;
                if (status === 404 || status === 410) {
                    await deletePushSubscription(row.endpoint);
                    gone += 1;
                    continue;
                }

                failed += 1;
                const attempts = row.attempts + 1;
                console.error(`Push send failed (id=${row.id}, status=${status ?? 'n/a'}, attempt=${attempts}):`,
                    (error as { body?: string }).body?.slice(0, 300) || (error as Error).message);
                if (attempts >= MAX_ATTEMPTS) {
                    await deletePushOutbox(row.id);
                } else {
                    await recordPushOutboxFailure(row.id, attempts);
                }
            }
        }

        if (sent > 0 || failed > 0 || gone > 0) {
            console.log(`Push outbox flushed: sent=${sent} failed=${failed} gone=${gone}`);
        }
    } catch (error) {
        console.error('Push outbox flush failed:', error);
    } finally {
        isFlushing = false;
    }
}
