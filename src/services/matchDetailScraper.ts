/**
 * LZV match detail scraper
 *
 * Reads lzvcup.be/results/detail/{id}: date, venue, score and both lineups
 * with goals/assists, and stores them in lzv_match_details.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import {
    getLzvResultIds,
    getScrapedLzvMatchDetails,
    upsertLzvMatchDetail,
} from '../config/supabase';
import { LzvLineupPlayer, LzvMatchDetailData } from '../types/supabase.types';
import { lzvUrl } from '../config/env';

const DELAY_MS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
// Scores and stats sometimes get corrected a few days after the match.
const RESCRAPE_WINDOW_MS = 7 * DAY_MS;
// Teams can fill in their lineup ("Nog niet ingevuld") well after the match.
const INCOMPLETE_RESCRAPE_WINDOW_MS = 30 * DAY_MS;

function cleanText(value: string): string {
    return value.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function idFromHref(href: string | undefined, segment: string): number | null {
    const match = (href || '').match(new RegExp(`/${segment}/(\\d+)`));
    return match ? parseInt(match[1], 10) : null;
}

function toInt(value: string): number {
    const parsed = parseInt(cleanText(value), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseLineup($: CheerioAPI, card: Parameters<CheerioAPI>[0]): LzvLineupPlayer[] {
    const players: LzvLineupPlayer[] = [];

    $(card).find('tbody tr').each((_, row) => {
        const cells = $(row).find('td');
        const playerLink = $(row).find('a[href*="/player/"]').first();
        const name = cleanText(playerLink.text());
        if (!name || cells.length < 3) return;

        const numberText = cleanText($(row).find('th').first().text());
        players.push({
            playerId: idFromHref(playerLink.attr('href'), 'player'),
            name,
            number: /^\d+$/.test(numberText) ? parseInt(numberText, 10) : null,
            captain: /\(K\)/.test(cleanText($(cells[0]).text())),
            goals: toInt($(cells[1]).text()),
            assists: toInt($(cells[2]).text()),
        });
    });

    return players;
}

/** Pure HTML → data, so it can be checked against a saved page. */
export function parseMatchDetail(html: string, resultId: number): LzvMatchDetailData | null {
    const $ = cheerio.load(html);
    const summary = $('.lzvcontent table.lzvtable').first();
    const rows = summary.find('tr');
    if (rows.length < 2) return null;

    // "23/09/2026 om 22u00 , SportCube Eppegem"
    const headerText = cleanText($(rows[0]).text());
    const dateMatch = headerText.match(/(\d{2})\/(\d{2})\/(\d{4})\s+om\s+(\d{2})u(\d{2})/);
    // Belgian wall-clock stored as UTC components, same as lzv_matches.date.
    const date = dateMatch
        ? new Date(Date.UTC(+dateMatch[3], +dateMatch[2] - 1, +dateMatch[1], +dateMatch[4], +dateMatch[5]))
        : null;
    const commaIndex = headerText.indexOf(',');
    const location = commaIndex >= 0 ? cleanText(headerText.slice(commaIndex + 1)) || null : null;

    const teamLinks = $(rows[1]).find('a[href*="/teams/detail/"]');
    if (teamLinks.length < 2) return null;
    const homeTeamId = idFromHref($(teamLinks[0]).attr('href'), 'teams/detail');
    const awayTeamId = idFromHref($(teamLinks[1]).attr('href'), 'teams/detail');

    const scoreMatch = cleanText($(rows[1]).find('td').eq(1).text()).match(/^(\d+)\s*-\s*(\d+)/);

    let homeLineup: LzvLineupPlayer[] = [];
    let awayLineup: LzvLineupPlayer[] = [];
    $('.lzvcontent .card').each((_, card) => {
        const teamId = idFromHref($(card).find('.card-title a[href*="/teams/detail/"]').attr('href'), 'teams/detail');
        if (teamId === null) return;
        if (teamId === homeTeamId) homeLineup = parseLineup($, card);
        else if (teamId === awayTeamId) awayLineup = parseLineup($, card);
    });

    return {
        result_id: resultId,
        date,
        location,
        home_team: cleanText($(teamLinks[0]).text()),
        away_team: cleanText($(teamLinks[1]).text()),
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        home_score: scoreMatch ? parseInt(scoreMatch[1], 10) : null,
        away_score: scoreMatch ? parseInt(scoreMatch[2], 10) : null,
        home_lineup: homeLineup,
        away_lineup: awayLineup,
    };
}

export async function scrapeMatchDetail(resultId: number): Promise<boolean> {
    const { data } = await axios.get(lzvUrl(`/results/detail/${resultId}`));
    const detail = parseMatchDetail(data, resultId);
    if (!detail) {
        console.warn(`Could not parse match detail ${resultId}`);
        return false;
    }
    await upsertLzvMatchDetail(detail);
    return true;
}

/**
 * Scrape result pages we don't have yet, recent ones that may still get
 * corrected, and ones still missing a lineup. Everything else is final and
 * is not fetched again.
 */
export async function scrapeMissingMatchDetails(): Promise<void> {
    const [known, scraped] = await Promise.all([getLzvResultIds(), getScrapedLzvMatchDetails()]);
    const now = Date.now();
    const toScrape = known
        .filter(({ resultId, date }) => {
            const complete = scraped.get(resultId);
            if (complete === undefined) return true;
            const age = now - new Date(date).getTime();
            return age < RESCRAPE_WINDOW_MS || (!complete && age < INCOMPLETE_RESCRAPE_WINDOW_MS);
        })
        .map(({ resultId }) => resultId);

    console.log(`Scraping ${toScrape.length} match detail page(s) (${known.length} known, ${scraped.size} stored)...`);

    let stored = 0;
    for (const resultId of toScrape) {
        try {
            if (await scrapeMatchDetail(resultId)) stored++;
        } catch (error) {
            console.error(`Error scraping match detail ${resultId}:`, error);
        }
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }

    console.log(`Stored ${stored}/${toScrape.length} match detail page(s).`);
}
