/**
 * Match Sync Service - Supabase Version
 * 
 * Syncs matches from iCal feeds to Supabase instead of MongoDB.
 */

import { ICalService } from './icalService';
import { ICalEvent } from '../types/ical.types';
import {
    getCoreMatches,
    getCoreTeams,
    getOwnLzvTeams,
    createCoreMatch,
    deleteCoreMatch
} from '../config/supabase';
import { CoreMatchData } from '../types/supabase.types';
import { isSameTeamName } from '../lib/teamNameMatching';
import { linkCoreMatchesToLzv } from './linkCoreMatches';
import { buildIcalUrl, config } from '../config/env';

export class MatchSyncServiceSupabase {
    private static isRunning = false;

    /**
     * Sync matches from iCal feeds to database
     * Runs every 4 hours via cron
     */
    static async syncMatches(): Promise<void> {
        if (this.isRunning) {
            console.log('Match sync already running, skipping...');
            return;
        }

        this.isRunning = true;
        console.log('Starting match sync from iCal feeds (Supabase)...');

        try {
            const coreTeams = await getCoreTeams();
            const ownTeams = await getOwnLzvTeams();
            const namedTeams = ownTeams.length > 0 ? ownTeams : coreTeams.map((team: any) => ({
                id: team.id as number,
                name: team.name as string,
            }));

            if (namedTeams.length === 0) {
                throw new Error('No core teams configured; cannot sync iCal matches');
            }

            const validTeamNames = namedTeams.map(team => team.name);
            const teamNameToId = new Map(namedTeams.map(team => [team.name, team.id]));

            const explicitUrls = config.ical.urls;
            const feeds: { url: string; label: string }[] = explicitUrls.length > 0
                ? explicitUrls.map((url) => ({ url, label: url }))
                : ownTeams.map((team) => ({
                    url: buildIcalUrl(team.lzvExternalId),
                    label: team.name,
                }));

            if (feeds.length === 0) {
                throw new Error(
                    'FEATURE_ICAL_SYNC is enabled but no ICAL_URL / ICAL_URLS is set and no core_teams.lzv_external_id found for ICAL_URL_TEMPLATE',
                );
            }

            // Fetch all events from iCal sources
            const allEvents: { event: ICalEvent; teamName: string }[] = [];

            for (const feed of feeds) {
                const events = await ICalService.fetchEvents(feed.url);

                // A feed unexpectedly returning zero events is safer to treat as a sync failure
                // than to interpret as "delete everything for that team".
                if (events.length === 0) {
                    throw new Error(`iCal feed for ${feed.label} returned 0 events; aborting sync to avoid destructive cleanup`);
                }

                console.log(`Fetched ${events.length} events from ${feed.label} iCal`);

                for (const event of events) {
                    const matchingTeam = validTeamNames.find(name =>
                        event.summary.includes(name) || isSameTeamName(event.summary, name)
                    );
                    if (matchingTeam) {
                        allEvents.push({ event, teamName: matchingTeam });
                    }
                }
            }

            console.log(`Total relevant events found: ${allEvents.length}`);

            // Get existing matches from DB
            const existingMatches = await getCoreMatches();
            const existingMatchKeys = new Set(
                existingMatches.map((m: any) => `${new Date(m.date).toISOString()}-${m.name}-${m.team_name}`)
            );

            for (const teamName of validTeamNames) {
                if (!teamNameToId.has(teamName)) {
                    throw new Error(`Missing core team mapping for "${teamName}"; aborting sync before any writes`);
                }
            }

            // Find new matches to add
            const newMatches: CoreMatchData[] = [];

            for (const { event, teamName } of allEvents) {
                const key = `${event.startDate.toISOString()}-${event.summary}-${teamName}`;
                if (!existingMatchKeys.has(key)) {
                    newMatches.push({
                        date: event.startDate,
                        location: event.location,
                        name: event.summary,
                        team_name: teamName,
                        team_id: teamNameToId.get(teamName) || undefined
                    });
                }
            }

            // Insert new matches. Do not seed attendance rows: missing rows are TBD in the app.
            for (const match of newMatches) {
                await createCoreMatch(match);
                console.log(`Added new match: ${match.name} on ${match.date}`);
            }

            // Find matches to remove (in DB but not in iCal anymore)
            const icalMatchKeys = new Set(
                allEvents.map(({ event, teamName }) => 
                    `${event.startDate.toISOString()}-${event.summary}-${teamName}`
                )
            );

            const matchesToRemove = existingMatches.filter((m: any) => {
                if (!validTeamNames.some(name => name === m.team_name || isSameTeamName(name, m.team_name || ''))) {
                    return false;
                }
                const key = `${new Date(m.date).toISOString()}-${m.name}-${m.team_name}`;
                return !icalMatchKeys.has(key);
            });

            for (const match of matchesToRemove) {
                await deleteCoreMatch(match.id);
                console.log(`Removed match: ${match.name} on ${match.date}`);
            }

            if (config.features.lzvScrape) {
                await linkCoreMatchesToLzv();
            }

            console.log(`Match sync complete. Added: ${newMatches.length}, Removed: ${matchesToRemove.length}`);
        } catch (error) {
            console.error('Match sync failed:', error);
        } finally {
            this.isRunning = false;
        }
    }
}
