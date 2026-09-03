/**
 * LZV Scraper Service - Supabase Version
 * 
 * Scrapes team data, matches, and player stats from lzvcup.be
 * and stores them in Supabase instead of MongoDB.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import {
    upsertLzvTeam,
    upsertLzvMatch,
    upsertLzvPlayer,
    getLzvPlayerByExternalId,
    getLzvTeamByExternalId,
    deleteStaleLzvMatches,
    getOwnLzvTeams
} from '../config/supabase';
import { LzvTeamData, LzvMatchData, LzvPlayerData } from '../types/supabase.types';
import { linkCoreMatchesToLzv } from './linkCoreMatches';
import { lzvUrl } from '../config/env';

const DELAY_MS = 500;

export class ScraperServiceSupabase {

    private static async getPrimaryTeams(): Promise<{ id: number; name: string }[]> {
        const teams = await getOwnLzvTeams();
        return teams.map(team => ({ id: team.lzvExternalId, name: team.name }));
    }

    /**
     * Main entry point - scrapes everything
     */
    static async scrapeAll() {
        console.log('Starting full scrape (Supabase)...');

        const primaryTeams = await this.getPrimaryTeams();
        if (primaryTeams.length === 0) {
            throw new Error('No own LZV teams configured on core_teams.lzv_external_id');
        }

        // Step 1: Scrape matches for our primary teams first to discover all teams in league
        const allTeamIds = new Set<number>();
        for (const team of primaryTeams) {
            const opponentIds = await this.scrapeTeamMatches(team.id);
            opponentIds.forEach(id => allTeamIds.add(id));
            allTeamIds.add(team.id);
        }

        console.log(`Found ${allTeamIds.size} unique teams in league`);

        // Step 2: Scrape standings from each primary team's overview page
        for (const team of primaryTeams) {
            await this.scrapeStandingsFromTeamOverview(team.id);
        }

        // Step 3: Scrape matches, players AND team details for ALL teams
        for (const teamId of allTeamIds) {
            // Skip matches for primary teams (already scraped in step 1)
            if (!primaryTeams.some(t => t.id === teamId)) {
                await this.scrapeTeamMatches(teamId);
            }
            await this.scrapeTeamPlayers(teamId);
            await this.scrapeTeamDetails(teamId);
            await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        }

        await linkCoreMatchesToLzv();

        console.log('Full scrape completed (Supabase).');
    }

    /**
     * Scrape matches for a specific team
     * Returns array of opponent team IDs found
     */
    static async scrapeTeamMatches(teamId: number): Promise<number[]> {
        console.log(`Scraping matches for team ${teamId}...`);
        const opponentIds: number[] = [];

        try {
            const url = lzvUrl(`/teams/overview/${teamId}`);
            const { data } = await axios.get(url);
            const $ = cheerio.load(data);

            const matchPromises: Promise<void>[] = [];
            const scrapedExternalIds: string[] = [];

            $('li').each((i, el) => {
                const text = $(el).text();

                // Look for date pattern: "wo 10/09/2025 22u00"
                const dateMatch = text.match(/([a-z]{2})\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2})u(\d{2})/i);
                if (!dateMatch) return;

                const [, , day, month, year, hour, minute] = dateMatch;
                const yearNum = parseInt(year, 10);
                const monthNum = parseInt(month, 10);
                const dayNum = parseInt(day, 10);
                const hourNum = parseInt(hour, 10);
                const minuteNum = parseInt(minute, 10);

                // LZV times are Belgian wall-clock; store as UTC components so host TZ cannot shift IDs/dates.
                const matchDate = new Date(Date.UTC(yearNum, monthNum - 1, dayNum, hourNum, minuteNum));

                // Find team links to extract team names and IDs
                const teamLinks = $(el).find('a[href*="/teams/detail/"]');
                if (teamLinks.length < 2) return;

                const homeTeam = $(teamLinks[0]).text().trim();
                const awayTeam = $(teamLinks[1]).text().trim();

                // Extract team IDs from links
                const homeLink = $(teamLinks[0]).attr('href') || '';
                const awayLink = $(teamLinks[1]).attr('href') || '';
                const homeIdMatch = homeLink.match(/\/(\d+)$/);
                const awayIdMatch = awayLink.match(/\/(\d+)$/);

                const homeTeamId = homeIdMatch ? parseInt(homeIdMatch[1], 10) : null;
                const awayTeamId = awayIdMatch ? parseInt(awayIdMatch[1], 10) : null;

                if (homeTeamId) opponentIds.push(homeTeamId);
                if (awayTeamId) opponentIds.push(awayTeamId);

                // Score lives in the last column on lzvcup.be — not in the team-name separator ("VT 09 - 04United")
                const scoreColumnText = $(el)
                    .find('.item-row .item-col')
                    .last()
                    .text()
                    .replace(/\u00a0/g, ' ')
                    .trim();
                const scoreMatch = scoreColumnText.match(/^(\d+)\s*-\s*(\d+)$/);
                let homeScore = 0;
                let awayScore = 0;
                let status: 'Played' | 'Scheduled' = 'Scheduled';

                if (scoreMatch) {
                    homeScore = parseInt(scoreMatch[1], 10);
                    awayScore = parseInt(scoreMatch[2], 10);
                    status = 'Played';
                }

                // Find location
                const locationLink = $(el).find('a[href*="/sportshalls/"]');
                const location = locationLink.length > 0 ? locationLink.text().trim() : '';

                const externalId = `${teamId}_${year}${month}${day}${hour}${minute}_${homeTeam}_${awayTeam}`.replace(/\s+/g, '');

                const matchData: LzvMatchData = {
                    external_id: externalId,
                    date: matchDate,
                    home_team: homeTeam,
                    away_team: awayTeam,
                    home_score: homeScore,
                    away_score: awayScore,
                    location,
                    team_id: teamId,
                    home_team_id: homeTeamId,
                    away_team_id: awayTeamId,
                    status
                };

                scrapedExternalIds.push(externalId);
                matchPromises.push(upsertLzvMatch(matchData));
            });

            await Promise.all(matchPromises);
            console.log(`Found ${matchPromises.length} matches for team ${teamId}`);

            // Drop DB rows that disappeared from the LZV page (cancelled/rescheduled).
            // Skip when scrape found nothing — same safety posture as iCal sync.
            if (scrapedExternalIds.length === 0) {
                console.warn(`Skipping stale match cleanup for team ${teamId}: scrape returned 0 matches`);
            } else {
                const removed = await deleteStaleLzvMatches(teamId, scrapedExternalIds);
                if (removed > 0) {
                    console.log(`Removed ${removed} stale match(es) for team ${teamId}`);
                }
            }

        } catch (error) {
            console.error(`Error scraping team ${teamId}:`, error);
        }

        return [...new Set(opponentIds)]; // Return unique IDs
    }

    /**
     * Scrape standings from a team's overview page
     */
    static async scrapeStandingsFromTeamOverview(teamId: number) {
        console.log(`Scraping league standings from team ${teamId}...`);

        try {
            const url = lzvUrl(`/teams/overview/${teamId}`);
            const { data } = await axios.get(url);
            const $ = cheerio.load(data);

            let teamsFound = 0;
            const teamPromises: Promise<void>[] = [];

            $('li').each((i, el) => {
                const text = $(el).text();

                const rankMatch = text.match(/^\s*(\d{1,2})\s+/);
                if (!rankMatch) return;

                const rank = parseInt(rankMatch[1]);
                if (rank < 1 || rank > 50) return;

                const teamLink = $(el).find('a[href*="/teams/detail/"]').first();
                if (!teamLink.length) return;

                const name = teamLink.text().trim();
                const href = teamLink.attr('href') || '';
                const idMatch = href.match(/\/(\d+)$/);
                if (!idMatch) return;

                const externalId = parseInt(idMatch[1]);

                // IMPORTANT: Remove the team name from text before parsing numbers.
                // Team names like "04United" contain digits that corrupt our indices.
                // We replace the team name with a placeholder to preserve text structure.
                const textWithoutTeamName = text.replace(name, '');
                const numbers = textWithoutTeamName.match(/\d+\.?\d*/g) || [];

                if (numbers.length < 6) return;

                // After removing team name, the indices are now correct:
                // [0] = rank, [1] = played, [2] = won, [3] = draw, [4] = lost, 
                // [5] = goalsFor, [6] = goalsAgainst, [7] = goalDiff, [8] = points, [9] = ptn/m
                const statsStartIdx = 1;

                const matchesPlayed = parseInt(numbers[statsStartIdx]) || 0;
                const wins = parseInt(numbers[statsStartIdx + 1]) || 0;
                const draws = parseInt(numbers[statsStartIdx + 2]) || 0;
                const losses = parseInt(numbers[statsStartIdx + 3]) || 0;
                const goalsFor = parseInt(numbers[statsStartIdx + 4]) || 0;
                const goalsAgainst = parseInt(numbers[statsStartIdx + 5]) || 0;
                const goalDifference = goalsFor - goalsAgainst;
                const points = parseInt(numbers[statsStartIdx + 7]) || 0;
                const pointsPerMatch = parseFloat(numbers[statsStartIdx + 8]) || 0;

                const teamData: LzvTeamData = {
                    external_id: externalId,
                    name,
                    rank,
                    matches_played: matchesPlayed,
                    wins,
                    draws,
                    losses,
                    goals_for: goalsFor,
                    goals_against: goalsAgainst,
                    goal_difference: goalDifference,
                    points,
                    points_per_match: pointsPerMatch,
                    form: [],
                    last_updated: new Date()
                };

                teamPromises.push(upsertLzvTeam(teamData));
                teamsFound++;
            });

            await Promise.all(teamPromises);
            console.log(`Found ${teamsFound} teams in standings`);

        } catch (error) {
            console.error('Error scraping standings:', error);
        }
    }

    /**
     * Scrape players for a specific team from /teams/detail/{id}
     */
    static async scrapeTeamPlayers(teamId: number) {
        console.log(`Scraping players for team ${teamId}...`);

        try {
            const url = lzvUrl(`/teams/detail/${teamId}`);
            const { data } = await axios.get(url);
            const $ = cheerio.load(data);

            let playersFound = 0;

            const playersToProcess: {
                externalId: number;
                name: string;
                teamStats: {
                    team_id: number;
                    jersey_number?: number;
                    games_played: number;
                    goals: number;
                    assists: number;
                    fairplay_rank?: number;
                };
            }[] = [];

            $('li').each((i, el) => {
                const text = $(el).text();

                const playerLink = $(el).find('a[href*="/player/"]').first();
                if (!playerLink.length) return;

                const name = playerLink.text().trim();
                if (!name) return;

                const href = playerLink.attr('href') || '';
                const idMatch = href.match(/\/player\/(\d+)$/);
                if (!idMatch) return;

                const externalId = parseInt(idMatch[1]);

                const numbers = text.match(/\d+/g) || [];

                if (numbers.length < 3) return;

                const jerseyNumber = numbers[0] ? parseInt(numbers[0]) : 0;

                const numLen = numbers.length;
                const gamesPlayed = numbers[numLen - 3] ? parseInt(numbers[numLen - 3]) : 0;
                const goals = numbers[numLen - 2] ? parseInt(numbers[numLen - 2]) : 0;
                const assists = numbers[numLen - 1] ? parseInt(numbers[numLen - 1]) : 0;

                let fairplayRank: number | undefined;
                if (numLen > 4) {
                    const possibleFairplay = parseInt(numbers[1]);
                    if (possibleFairplay > 0 && possibleFairplay <= 20) {
                        fairplayRank = possibleFairplay;
                    }
                }

                playersToProcess.push({
                    externalId,
                    name,
                    teamStats: {
                        team_id: teamId,
                        jersey_number: jerseyNumber,
                        games_played: gamesPlayed,
                        goals,
                        assists,
                        fairplay_rank: fairplayRank,
                    }
                });
                playersFound++;
            });

            // Process each player - update or add team stats
            for (const playerData of playersToProcess) {
                const existingPlayer = await getLzvPlayerByExternalId(playerData.externalId);

                if (existingPlayer) {
                    // Check if we already have stats for this team
                    const existingStats = existingPlayer.lzv_player_team_stats || [];
                    const existingTeamStatsIndex = existingStats.findIndex(
                        (ts: any) => ts.team_id === teamId
                    );

                    let teamStats: LzvPlayerData['team_stats'];
                    if (existingTeamStatsIndex >= 0) {
                        // Update existing
                        teamStats = existingStats.map((ts: any, idx: number) =>
                            idx === existingTeamStatsIndex ? playerData.teamStats : {
                                team_id: ts.team_id,
                                jersey_number: ts.jersey_number,
                                games_played: ts.games_played,
                                goals: ts.goals,
                                assists: ts.assists,
                                fairplay_rank: ts.fairplay_rank
                            }
                        );
                    } else {
                        // Add new team stats
                        teamStats = [
                            ...existingStats.map((ts: any) => ({
                                team_id: ts.team_id,
                                jersey_number: ts.jersey_number,
                                games_played: ts.games_played,
                                goals: ts.goals,
                                assists: ts.assists,
                                fairplay_rank: ts.fairplay_rank
                            })),
                            playerData.teamStats
                        ];
                    }

                    await upsertLzvPlayer({
                        external_id: playerData.externalId,
                        name: playerData.name,
                        team_stats: teamStats
                    });
                } else {
                    // Create new player
                    await upsertLzvPlayer({
                        external_id: playerData.externalId,
                        name: playerData.name,
                        team_stats: [playerData.teamStats]
                    });
                }
            }

            console.log(`Found ${playersFound} players for team ${teamId}`);

        } catch (error) {
            console.error(`Error scraping players for team ${teamId}:`, error);
        }
    }

    /**
     * Scrape additional team details
     */
    static async scrapeTeamDetails(teamId: number) {
        console.log(`Scraping team details for ${teamId}...`);

        try {
            const url = lzvUrl(`/teams/detail/${teamId}`);
            const { data } = await axios.get(url);
            const $ = cheerio.load(data);

            let colors: string | undefined;
            let manager: string | undefined;
            let description: string | undefined;
            let leagueName: string | undefined;
            let imageBase64: string | undefined;

            const pageText = $('body').text();

            const colorMatch = pageText.match(/Kleur\s+Broek-Shirt:\s*([^\n]+)/i);
            if (colorMatch) {
                colors = colorMatch[1].trim();
            }

            const managerMatch = pageText.match(/Teammanager:\s*([^\n]+)/i);
            if (managerMatch) {
                manager = managerMatch[1].trim();
            }

            const leagueLink = $('a[href*="/teams/overview/"]').first().text();
            const leagueMatch = leagueLink.match(/\(([^)]+)\)/);
            if (leagueMatch) {
                leagueName = leagueMatch[1].trim();
            }

            const extraInfoMatch = pageText.match(/Extra\s+Info\s*\n+([^#\n][^\n]+)/i);
            if (extraInfoMatch) {
                let desc = extraInfoMatch[1].trim();
                const cutoffPatterns = [
                    /\s+\d+e\s+\d+\s+\d+\s+\d+/,
                    /\s+#\s*Teamleden/,
                    /\s+Teamleden\s+Fairplay/,
                    /\s+\d+\s+[A-Z][a-z]+\s+[A-Z][a-z]+\s+\d+e/,
                ];

                for (const pattern of cutoffPatterns) {
                    const match = desc.match(pattern);
                    if (match && match.index !== undefined) {
                        desc = desc.substring(0, match.index);
                    }
                }

                desc = desc.trim().replace(/\s+/g, ' ');

                const wordCount = desc.split(/\s+/).filter(w => /[a-zA-Z]{3,}/.test(w)).length;
                if (wordCount >= 3 && desc.length > 20) {
                    description = desc;
                }
            }

            const imgElement = $('img').filter((i, el) => {
                const src = $(el).attr('src') || '';
                return src.includes('/storage/teams/') || src.includes('/uploads/');
            }).first();

            if (imgElement.length > 0) {
                let imgSrc = imgElement.attr('src') || '';
                if (imgSrc && !imgSrc.startsWith('http')) {
                    imgSrc = lzvUrl(imgSrc);
                }

                if (imgSrc) {
                    try {
                        const imgResponse = await axios.get(imgSrc, { responseType: 'arraybuffer' });
                        const base64 = Buffer.from(imgResponse.data, 'binary').toString('base64');
                        const contentType = imgResponse.headers['content-type'] || 'image/jpeg';
                        imageBase64 = `data:${contentType};base64,${base64}`;
                        console.log(`Downloaded image for team ${teamId}`);
                    } catch (imgError) {
                        console.warn(`Failed to download image for team ${teamId}`);
                    }
                }
            }

            // Get existing team data
            const existingTeam = await getLzvTeamByExternalId(teamId);

            if (existingTeam || colors || manager || description || leagueName || imageBase64) {
                const updateData: LzvTeamData = {
                    external_id: teamId,
                    name: existingTeam?.name || `Team ${teamId}`,
                    ...(colors && { colors }),
                    ...(manager && { manager }),
                    ...(description && { description }),
                    ...(leagueName && { league_name: leagueName }),
                    ...(imageBase64 && { image_base64: imageBase64 }),
                    last_updated: new Date()
                };

                await upsertLzvTeam(updateData);
                console.log(`Updated team ${teamId} with details: colors=${!!colors}, manager=${!!manager}, desc=${!!description}, league=${!!leagueName}, image=${!!imageBase64}`);
            }

        } catch (error) {
            console.error(`Error scraping team details for ${teamId}:`, error);
        }
    }
}
