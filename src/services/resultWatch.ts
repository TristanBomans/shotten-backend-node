/**
 * Result watch
 *
 * After one of our matches, checks the team's LZV overview page for a score
 * every few minutes. As soon as LZV shows one, it runs the full scrape so
 * standings, lineups and the result push go out without waiting for 03:00.
 */

import axios from 'axios';
import { getAdminPushSubscriptions, getOwnLzvTeams, getUnplayedLzvMatchesBetween, insertPushOutbox } from '../config/supabase';
import { config, lzvUrl } from '../config/env';
import { LzvMatchData } from '../types/supabase.types';
import { brusselsParts, brusselsWallClock } from './pushDispatch';
import { ScraperServiceSupabase } from './scraperSupabase';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// A match lasts about 50 minutes; no score can be up before that.
const WATCH_FROM_MS = 45 * MINUTE_MS;
// Every run (5 min) right after the match, then hourly: some teams enter the score late.
const FAST_WINDOW_MS = 6 * HOUR_MS;
const SLOW_WINDOW_MS = 48 * HOUR_MS;
// If a scrape didn't store the score, don't restart the full scrape every run.
const RETRIGGER_COOLDOWN_MS = 30 * MINUTE_MS;

let isChecking = false;
let lastTriggeredAt = 0;

/** Matches whose window says to look this run. */
export function isDue(kickoff: Date, wallNow: Date, minute: number): boolean {
    const age = wallNow.getTime() - kickoff.getTime();
    if (age < WATCH_FROM_MS || age > SLOW_WINDOW_MS) return false;
    return age <= FAST_WINDOW_MS || minute < 5;
}

function scoreLine(match: LzvMatchData): string {
    return `${match.home_team} ${match.home_score} - ${match.away_score} ${match.away_team}`;
}

async function notifyAdmins(scores: LzvMatchData[]): Promise<void> {
    if (!config.features.push) return;
    const subscriptions = await getAdminPushSubscriptions();
    if (subscriptions.length === 0) return;

    const body = `${scores.map(scoreLine).join(', ')} · scraper started`;
    await insertPushOutbox(subscriptions.map(({ endpoint }) => ({
        endpoint,
        title: 'New score detected',
        body,
        url: `${config.push.appOrigin}/?view=settings`,
        tag: 'admin_scrape',
    })));
}

export async function checkForNewResults(now: Date = new Date()): Promise<void> {
    if (isChecking || ScraperServiceSupabase.isRunning()) return;
    if (now.getTime() - lastTriggeredAt < RETRIGGER_COOLDOWN_MS) return;
    isChecking = true;

    try {
        const wallNow = brusselsWallClock(now);
        const minute = brusselsParts(now).minute;
        const ownTeams = await getOwnLzvTeams();
        const pending = (await getUnplayedLzvMatchesBetween(
            ownTeams.map((team) => team.lzvExternalId),
            new Date(wallNow.getTime() - SLOW_WINDOW_MS),
            new Date(wallNow.getTime() - WATCH_FROM_MS),
        )).filter((match) => isDue(new Date(match.date), wallNow, minute));
        if (pending.length === 0) return;

        const pendingIds = new Set(pending.map((match) => match.external_id as string));
        const teamIds = [...new Set(pending.map((match) => match.team_id as number))];
        const scored: LzvMatchData[] = [];

        for (const teamId of teamIds) {
            const { data } = await axios.get(lzvUrl(`/teams/overview/${teamId}`));
            const { matches } = ScraperServiceSupabase.parseTeamMatches(data, teamId);
            scored.push(...matches.filter((match) => match.status === 'Played' && pendingIds.has(match.external_id)));
        }

        if (scored.length === 0) return;

        console.log(`Result watch: new score on LZV (${scored.map(scoreLine).join(', ')}), starting full scrape...`);
        lastTriggeredAt = now.getTime();
        try {
            await notifyAdmins(scored);
        } catch (error) {
            console.error('Result watch: could not queue admin push:', error);
        }
        await ScraperServiceSupabase.scrapeAll();
        console.log('Result watch: full scrape completed.');
    } catch (error) {
        console.error('Result watch failed:', error);
    } finally {
        isChecking = false;
    }
}
