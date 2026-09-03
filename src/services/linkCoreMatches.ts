import {
    getCoreMatches,
    getLzvMatchesForTeamIds,
    getLzvTeamNameIndex,
    getOwnLzvTeams,
    updateCoreMatchLzvLink,
} from '../config/supabase';
import { findNamedTeam, isSameTeamName } from '../lib/teamNameMatching';

interface LzvMatchRow {
    external_id: string;
    date: string;
    home_team: string;
    away_team: string;
    team_id: number;
    home_team_id?: number | null;
    away_team_id?: number | null;
}

function sameKickoff(left: string, right: string): boolean {
    const a = new Date(left);
    const b = new Date(right);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;

    return a.getUTCFullYear() === b.getUTCFullYear()
        && a.getUTCMonth() === b.getUTCMonth()
        && a.getUTCDate() === b.getUTCDate()
        && a.getUTCHours() === b.getUTCHours()
        && a.getUTCMinutes() === b.getUTCMinutes();
}

function sameUtcDay(left: string, right: string): boolean {
    const a = new Date(left);
    const b = new Date(right);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;

    return a.getUTCFullYear() === b.getUTCFullYear()
        && a.getUTCMonth() === b.getUTCMonth()
        && a.getUTCDate() === b.getUTCDate();
}

function fixtureMatchesCoreName(coreName: string, homeTeam: string, awayTeam: string): boolean {
    if (!coreName) return false;

    const parts = coreName.split(/\s*-\s*/).map(part => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
        const left = parts[0];
        const right = parts[parts.length - 1];
        return (
            (isSameTeamName(left, homeTeam) && isSameTeamName(right, awayTeam))
            || (isSameTeamName(left, awayTeam) && isSameTeamName(right, homeTeam))
        );
    }

    return isSameTeamName(coreName, homeTeam) || isSameTeamName(coreName, awayTeam);
}

function resolveOpponentId(
    lzvMatch: LzvMatchRow,
    ownLzvId: number,
    ownName: string,
    lzvTeams: { name: string; externalId: number }[],
): number | null {
    if (lzvMatch.home_team_id && lzvMatch.away_team_id) {
        if (lzvMatch.home_team_id === ownLzvId) return lzvMatch.away_team_id;
        if (lzvMatch.away_team_id === ownLzvId) return lzvMatch.home_team_id;
    }

    const opponentName = isSameTeamName(lzvMatch.home_team, ownName)
        ? lzvMatch.away_team
        : lzvMatch.home_team;

    return findNamedTeam(lzvTeams, opponentName)?.externalId ?? null;
}

export async function linkCoreMatchesToLzv(): Promise<{ linked: number; skipped: number }> {
    const ownTeams = await getOwnLzvTeams();
    const ownLzvIds = ownTeams.map(team => team.lzvExternalId);
    const coreMatches = await getCoreMatches();
    const lzvMatches = (await getLzvMatchesForTeamIds(ownLzvIds)) as LzvMatchRow[];
    const lzvTeams = (await getLzvTeamNameIndex()).map(team => ({
        name: team.name,
        externalId: team.external_id,
    }));

    let linked = 0;
    let skipped = 0;

    for (const core of coreMatches as any[]) {
        const ownTeam = ownTeams.find(team => team.id === core.team_id)
            || ownTeams.find(team => isSameTeamName(team.name, core.team_name || ''));

        if (!ownTeam) {
            skipped += 1;
            continue;
        }

        const forTeam = lzvMatches.filter(match => match.team_id === ownTeam.lzvExternalId);
        const nameMatches = forTeam.filter(match =>
            fixtureMatchesCoreName(core.name || '', match.home_team, match.away_team),
        );

        let candidates = nameMatches.filter(match => sameKickoff(match.date, core.date));
        if (candidates.length === 0) {
            candidates = nameMatches.filter(match => sameUtcDay(match.date, core.date));
        }

        if (candidates.length !== 1) {
            skipped += 1;
            continue;
        }

        const lzvMatch = candidates[0];
        const opponentLzvId = resolveOpponentId(lzvMatch, ownTeam.lzvExternalId, ownTeam.name, lzvTeams);

        if (
            core.lzv_match_external_id === lzvMatch.external_id
            && core.opponent_lzv_id === opponentLzvId
        ) {
            continue;
        }

        await updateCoreMatchLzvLink(core.id, lzvMatch.external_id, opponentLzvId);
        linked += 1;
    }

    console.log(`Linked ${linked} core matches to LZV (${skipped} skipped)`);
    return { linked, skipped };
}
