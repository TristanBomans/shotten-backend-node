import webpush from 'web-push';
import {
    claimPushSent,
    deletePushOutbox,
    deletePushSubscription,
    getAttendancesByMatchIds,
    getCorePlayersWithTeams,
    getPastCoreMatchesForTeams,
    getDuePushOutbox,
    getPushSubscriptionsForPlayers,
    getUpcomingCoreMatches,
    insertPushOutbox,
    recordPushOutboxFailure,
} from '../config/supabase';
import { config } from '../config/env';

export type AttendanceStatus = 'Present' | 'NotPresent' | 'Maybe' | null;
export type PushKind =
    | 'attendance_2w'
    | 'attendance_eve'
    | 'streak_risk'
    | 'kickoff_morning'
    | 'kickoff_1h'
    | 'result';

/** Reminders that ask for an RSVP get "I'm in / Can't make it" buttons. */
const RSVP_KINDS = new Set<string>(['attendance_2w', 'attendance_eve', 'streak_risk']);
const RSVP_ACTIONS = [
    { action: 'rsvp-present', title: "I'm in" },
    { action: 'rsvp-absent', title: "Can't make it" },
];

/** A streak this long or longer turns the evening reminder into a streak_risk one. */
export const STREAK_RISK_MIN = 3;
const STREAK_LOOKBACK_DAYS = 400;

const TIME_ZONE = config.timezone;
const APP_ORIGIN = config.push.appOrigin;
const LOOKAHEAD_DAYS = 16;
const HOUR_MS = 60 * 60 * 1000;
const FLUSH_BATCH = 50;
const MAX_ATTEMPTS = 5;
const PUSH_TTL_SECONDS = 12 * 60 * 60;

// Endpoints come from browsers via the PWA, and this worker usually runs on a
// private network: only talk to the real push services so a forged endpoint
// can't reach internal hosts.
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

export function brusselsParts(date: Date) {
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

/** Brussels wall-clock time as UTC components, the way lzv_matches.date is stored. */
export function brusselsWallClock(date: Date): Date {
    const parts = brusselsParts(date);
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
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

export interface PastMatchForStreak {
    id: number;
    date: string | Date;
    team_id: number | null;
    forfait?: boolean | null;
}

/**
 * Current run of consecutive Present answers per player, newest match first.
 * Counts matches the same way the PWA stats page does by default: past,
 * not forfait, and at least one player Present.
 */
export function currentPresentStreaks(
    players: { id: number; team_ids: unknown }[],
    pastMatches: PastMatchForStreak[],
    attendanceByMatch: Map<number, Map<number, AttendanceStatus>>,
): Map<number, number> {
    const counted = pastMatches
        .filter((match) => !match.forfait)
        .filter((match) => {
            const byPlayer = attendanceByMatch.get(match.id);
            return byPlayer ? [...byPlayer.values()].includes('Present') : false;
        })
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const streaks = new Map<number, number>();
    for (const player of players) {
        let streak = 0;
        for (const match of counted) {
            if (!playerPlaysForTeam(player.team_ids, match.team_id)) continue;
            if (attendanceByMatch.get(match.id)?.get(player.id) !== 'Present') break;
            streak += 1;
        }
        streaks.set(player.id, streak);
    }
    return streaks;
}

/** The match id in a `/?modal=match&modalId=…` deep link, if it is one. */
export function matchIdFromDeepLink(url: string | null | undefined): number | null {
    if (!url) return null;
    try {
        const parsed = new URL(url, 'https://app.invalid');
        if (parsed.searchParams.get('modal') !== 'match') return null;
        const id = Number(parsed.searchParams.get('modalId'));
        return Number.isInteger(id) && id > 0 ? id : null;
    } catch {
        return null;
    }
}

/** The JSON the service worker receives; see the PWA's public/sw.js. */
export function buildPushPayload(row: { title: string; body: string; url: string | null; tag: string | null; playerId: number | null }) {
    const url = row.url || '/';
    const kind = row.tag || undefined;
    const matchId = matchIdFromDeepLink(row.url);
    const canRsvp = kind !== undefined && RSVP_KINDS.has(kind) && matchId != null && row.playerId != null;

    return {
        title: row.title,
        body: row.body,
        tag: row.tag || 'shotten',
        data: {
            url,
            ...(kind ? { kind } : {}),
            ...(matchId != null ? { matchId } : {}),
            ...(row.playerId != null ? { playerId: row.playerId } : {}),
        },
        ...(canRsvp ? { actions: RSVP_ACTIONS } : {}),
    };
}

function formatKickoffTime(matchDate: Date): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(matchDate);
}

export function buildPushCopy(
    kind: PushKind,
    match: MatchForPush,
    status: AttendanceStatus,
    streak = 0,
): { title: string; body: string } {
    const matchLabel = match.name || 'Match';
    const time = formatKickoffTime(match.date);

    if (kind === 'streak_risk') {
        return {
            title: `🔥 ${streak} matches in a row!`,
            body: `Your streak is on the line — are you in for tomorrow's ${matchLabel}?`,
        };
    }

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

export function playerPlaysForTeam(teamIds: unknown, teamId: number | null | undefined): boolean {
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

/**
 * Claims each item once per player/match/kind in push_sent and queues it for
 * every device of that player. Returns how many items and outbox rows were new.
 */
export async function queuePushItems(items: PushItem[], sendAt?: Date): Promise<{ claimed: number; outbox: number }> {
    if (items.length === 0) return { claimed: 0, outbox: 0 };

    // Only claim for players with a device, so someone who turns
    // notifications on later still gets the next due one.
    const subscriptions = await getPushSubscriptionsForPlayers([...new Set(items.map((item) => item.playerId))]);
    const subsByPlayer = new Map<number, typeof subscriptions>();
    for (const sub of subscriptions) {
        if (sub.player_id == null) continue;
        if (!subsByPlayer.has(sub.player_id)) subsByPlayer.set(sub.player_id, []);
        subsByPlayer.get(sub.player_id)!.push(sub);
    }
    const reachable = items.filter((item) => subsByPlayer.has(item.playerId));
    if (reachable.length === 0) return { claimed: 0, outbox: 0 };

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
            ...(sendAt ? { send_at: sendAt.toISOString() } : {}),
        })));

    await insertPushOutbox(outbox);
    return { claimed: claimed.length, outbox: outbox.length };
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
        const streaks = await loadStreaksIfEveningReminderDue(now, upcoming, attendances, players);

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
                const streak = streaks.get(player.id) ?? 0;
                const due = kindsDue(now, matchDate, status).map((kind): PushKind =>
                    kind === 'attendance_eve' && streak >= STREAK_RISK_MIN ? 'streak_risk' : kind,
                );
                for (const kind of due) {
                    const copy = buildPushCopy(kind, matchInfo, status, streak);
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

        const queued = await queuePushItems(items);
        if (queued.outbox > 0) {
            console.log(`Push dispatch: queued=${queued.outbox} reminders=${queued.claimed}`);
        }
    } catch (error) {
        console.error('Match push dispatch failed:', error);
    } finally {
        isRunning = false;
    }
}

/**
 * Streaks only matter for the evening-before reminder, so past matches are
 * loaded only when at least one upcoming match is in that window.
 */
async function loadStreaksIfEveningReminderDue(
    now: Date,
    upcoming: { id: number; date: string; team_id: number | null }[],
    attendances: { match_id: unknown; player_id: unknown; status: unknown }[],
    players: { id: number; team_ids: unknown }[],
): Promise<Map<number, number>> {
    const eveningTeams = new Set<number>();
    for (const match of upcoming) {
        const matchDate = new Date(match.date);
        if (Number.isNaN(matchDate.getTime()) || match.team_id == null) continue;
        if (kindsDue(now, matchDate, null).includes('attendance_eve')) eveningTeams.add(Number(match.team_id));
    }
    if (eveningTeams.size === 0) return new Map();

    try {
        const since = new Date(now.getTime() - STREAK_LOOKBACK_DAYS * 86_400_000);
        const pastMatches = await getPastCoreMatchesForTeams([...eveningTeams], since, now);
        const pastAttendances = await getAttendancesByMatchIds(pastMatches.map((m) => m.id as number));

        const byMatch = new Map<number, Map<number, AttendanceStatus>>();
        for (const row of [...pastAttendances, ...attendances]) {
            const matchId = row.match_id as number;
            if (!byMatch.has(matchId)) byMatch.set(matchId, new Map());
            byMatch.get(matchId)!.set(row.player_id as number, row.status as AttendanceStatus);
        }
        return currentPresentStreaks(players, pastMatches as PastMatchForStreak[], byMatch);
    } catch (error) {
        // Fall back to the plain evening reminder.
        console.error('Streak lookup for push failed:', error);
        return new Map();
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
                    JSON.stringify(buildPushPayload({
                        title: row.title,
                        body: row.body,
                        url: row.url,
                        tag: row.tag,
                        playerId: keys.player_id ?? null,
                    })),
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
