import { getCorePlayersWithTeams, getOwnLzvTeams, getPlayedLzvMatchesSince } from '../config/supabase';
import { config } from '../config/env';
import { isSameTeamName } from '../lib/teamNameMatching';
import { brusselsParts, playerPlaysForTeam, PushItem, queuePushItems } from './pushDispatch';

// Only announce results of recent matches, so the first run (or a player who
// subscribes later) doesn't get a burst of old scores.
const RESULT_WINDOW_DAYS = 4;
// The scrape runs at night: hold result pushes until the morning.
const QUIET_UNTIL_HOUR = 8;

export interface ResultMatch {
    home_team: string;
    away_team: string;
    home_score: number;
    away_score: number;
    home_team_id?: number | null;
    away_team_id?: number | null;
}

export function buildResultCopy(match: ResultMatch, ownLzvId: number, ownName: string): { title: string; body: string } {
    const isHome = match.home_team_id != null || match.away_team_id != null
        ? match.home_team_id === ownLzvId
        : isSameTeamName(match.home_team, ownName);
    const teamName = isHome ? match.home_team : match.away_team;
    const opponent = isHome ? match.away_team : match.home_team;
    const teamScore = isHome ? match.home_score : match.away_score;
    const opponentScore = isHome ? match.away_score : match.home_score;

    const title = teamScore > opponentScore ? 'We won!' : teamScore < opponentScore ? 'We lost' : 'Draw';
    return {
        title,
        body: `${teamName} ${teamScore} - ${opponentScore} ${opponent}`,
    };
}

/** Start of the quiet hours' end today (Europe/Brussels), or undefined when it already passed. */
export function quietHoursSendAt(now: Date): Date | undefined {
    const parts = brusselsParts(now);
    if (parts.hour >= QUIET_UNTIL_HOUR) return undefined;
    const wallClockNow = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const offsetMs = wallClockNow - Math.floor(now.getTime() / 60_000) * 60_000;
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, QUIET_UNTIL_HOUR, 0) - offsetMs);
}

function resultDeepLink(resultId: number | null): string {
    const path = resultId != null ? `/?modal=recent&detail=${resultId}` : '/?modal=recent';
    return `${config.push.appOrigin}${path}`;
}

/**
 * Queues one push per player of an own team the first time the scrape sees a
 * score for one of that team's matches. push_sent keys these on the
 * lzv_matches id (kind 'result'), not on a core match id.
 */
export async function notifyNewResults(now: Date = new Date()): Promise<void> {
    if (!config.features.push) return;

    const ownTeams = await getOwnLzvTeams();
    const since = new Date(now.getTime() - RESULT_WINDOW_DAYS * 86_400_000);
    const matches = await getPlayedLzvMatchesSince(ownTeams.map((team) => team.lzvExternalId), since);
    if (matches.length === 0) return;

    const players = await getCorePlayersWithTeams();
    const items: PushItem[] = [];

    for (const match of matches) {
        const ownTeam = ownTeams.find((team) => team.lzvExternalId === match.team_id);
        if (!ownTeam) continue;
        const copy = buildResultCopy(match, ownTeam.lzvExternalId, ownTeam.name);

        for (const player of players) {
            if (!playerPlaysForTeam(player.team_ids, ownTeam.id)) continue;
            items.push({
                playerId: player.id,
                matchId: match.id,
                kind: 'result',
                title: copy.title,
                body: copy.body,
                url: resultDeepLink(match.lzv_result_id ?? null),
            });
        }
    }

    const queued = await queuePushItems(items, quietHoursSendAt(now));
    if (queued.outbox > 0) {
        console.log(`Result push: queued=${queued.outbox} results=${queued.claimed}`);
    }
}
