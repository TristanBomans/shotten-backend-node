/**
 * Supabase Database Client for Scraper
 * 
 * This module provides the database connection for the scraper jobs.
 * Instead of MongoDB, we now use Supabase (PostgreSQL).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { LzvTeamData, LzvMatchData, LzvPlayerData, CoreMatchData, LzvMatchDetailData } from '../types/supabase.types';
import { config } from './env';

// ============================================================================
// SUPABASE CLIENT
// ============================================================================

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
    if (!client) {
        client = createClient(config.supabase.url, config.supabase.serviceKey);
    }
    return client;
}

// ============================================================================
// LZV TEAMS
// ============================================================================

export async function upsertLzvTeam(data: LzvTeamData): Promise<void> {
    const { error } = await getSupabase()
        .from('lzv_teams')
        .upsert({
            ...data,
            last_updated: data.last_updated?.toISOString() || new Date().toISOString()
        }, { onConflict: 'external_id' });
    
    if (error) throw error;
}

export async function getLzvTeamByExternalId(externalId: number) {
    const { data, error } = await getSupabase()
        .from('lzv_teams')
        .select('*')
        .eq('external_id', externalId)
        .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
}

// ============================================================================
// LZV MATCHES
// ============================================================================

export async function upsertLzvMatch(data: LzvMatchData): Promise<void> {
    const { error } = await getSupabase()
        .from('lzv_matches')
        .upsert({
            ...data,
            date: data.date.toISOString(),
            home_score: data.home_score || 0,
            away_score: data.away_score || 0,
            status: data.status || 'Scheduled'
        }, { onConflict: 'external_id' });
    
    if (error) throw error;
}

// ============================================================================
// LZV MATCH DETAILS
// ============================================================================

/** Result page ids known on lzv_matches, with the latest kick-off per id. */
export async function getLzvResultIds(): Promise<{ resultId: number; date: string }[]> {
    const { data, error } = await getSupabase()
        .from('lzv_matches')
        .select('lzv_result_id, date')
        .not('lzv_result_id', 'is', null);

    if (error) throw error;
    const byId = new Map<number, string>();
    for (const row of data || []) {
        byId.set(row.lzv_result_id, row.date);
    }
    return [...byId.entries()].map(([resultId, date]) => ({ resultId, date }));
}

/** Stored result ids, mapped to whether both lineups were filled in. */
export async function getScrapedLzvMatchDetails(): Promise<Map<number, boolean>> {
    const { data, error } = await getSupabase()
        .from('lzv_match_details')
        .select('result_id, home_lineup, away_lineup');

    if (error) throw error;
    return new Map((data || []).map(row => [
        row.result_id,
        (row.home_lineup?.length ?? 0) > 0 && (row.away_lineup?.length ?? 0) > 0,
    ]));
}

export async function upsertLzvMatchDetail(data: LzvMatchDetailData): Promise<void> {
    const { error } = await getSupabase()
        .from('lzv_match_details')
        .upsert({
            ...data,
            date: data.date ? data.date.toISOString() : null,
            scraped_at: new Date().toISOString(),
        }, { onConflict: 'result_id' });

    if (error) throw error;
}

/**
 * Delete lzv_matches for a team whose external_id is not in the latest scrape.
 * Refuses an empty keep-set so a failed/empty scrape cannot wipe the schedule.
 */
export async function deleteStaleLzvMatches(teamId: number, keepExternalIds: string[]): Promise<number> {
    if (keepExternalIds.length === 0) {
        throw new Error(`Refusing to prune lzv_matches for team ${teamId}: keep set is empty`);
    }

    const { data: existing, error: fetchError } = await getSupabase()
        .from('lzv_matches')
        .select('id, external_id')
        .eq('team_id', teamId);

    if (fetchError) throw fetchError;

    const keep = new Set(keepExternalIds);
    const staleIds = (existing || [])
        .filter((row: { id: number; external_id: string }) => !keep.has(row.external_id))
        .map((row: { id: number; external_id: string }) => row.id);

    if (staleIds.length === 0) return 0;

    const { error: deleteError } = await getSupabase()
        .from('lzv_matches')
        .delete()
        .in('id', staleIds);

    if (deleteError) throw deleteError;
    return staleIds.length;
}

// ============================================================================
// LZV PLAYERS
// ============================================================================

export async function upsertLzvPlayer(data: LzvPlayerData): Promise<void> {
    // First, upsert the player
    const { data: player, error: playerError } = await getSupabase()
        .from('lzv_players')
        .upsert({
            external_id: data.external_id,
            name: data.name,
            last_updated: new Date().toISOString()
        }, { onConflict: 'external_id' })
        .select('id')
        .single();
    
    if (playerError) throw playerError;
    if (!player) return;
    
    // Then, upsert each team stats entry
    for (const stats of data.team_stats) {
        const { error: statsError } = await getSupabase()
            .from('lzv_player_team_stats')
            .upsert({
                player_id: player.id,
                team_id: stats.team_id,
                jersey_number: stats.jersey_number,
                games_played: stats.games_played,
                goals: stats.goals,
                assists: stats.assists,
                fairplay_rank: stats.fairplay_rank
            }, { onConflict: 'player_id,team_id' });
        
        if (statsError) throw statsError;
    }
}

export async function getLzvPlayerByExternalId(externalId: number) {
    const { data, error } = await getSupabase()
        .from('lzv_players')
        .select('*, lzv_player_team_stats(*)')
        .eq('external_id', externalId)
        .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
}

// ============================================================================
// CORE MATCHES (for iCal sync)
// ============================================================================

export async function getCoreMatches() {
    const { data, error } = await getSupabase()
        .from('core_matches')
        .select('*');
    
    if (error) throw error;
    return data || [];
}

export async function getUpcomingCoreMatches(from: Date, to: Date) {
    const { data, error } = await getSupabase()
        .from('core_matches')
        .select('id, date, name, location, team_id, team_name, forfait')
        .gte('date', from.toISOString())
        .lte('date', to.toISOString())
        .order('date');

    if (error) throw error;
    return data || [];
}

export async function getAttendancesByMatchIds(matchIds: number[]) {
    if (matchIds.length === 0) return [];

    const { data, error } = await getSupabase()
        .from('attendances')
        .select('match_id, player_id, status')
        .in('match_id', matchIds);

    if (error) throw error;
    return data || [];
}

export async function getCorePlayersWithTeams() {
    const { data, error } = await getSupabase()
        .from('core_players')
        .select('id, team_ids');

    if (error) throw error;
    return data || [];
}

export async function getCoreTeams() {
    const { data, error } = await getSupabase()
        .from('core_teams')
        .select('*');
    
    if (error) throw error;
    return data || [];
}

export async function getOwnLzvTeams(): Promise<{ id: number; name: string; lzvExternalId: number }[]> {
    const teams = await getCoreTeams();
    const mapped = teams
        .filter((team: any) => team.lzv_external_id != null)
        .map((team: any) => ({
            id: team.id as number,
            name: team.name as string,
            lzvExternalId: team.lzv_external_id as number,
        }));

    return mapped;
}

export async function getLzvMatchesForTeamIds(teamIds: number[]) {
    if (teamIds.length === 0) return [];

    const { data, error } = await getSupabase()
        .from('lzv_matches')
        .select('*')
        .in('team_id', teamIds);

    if (error) throw error;
    return data || [];
}

export async function getLzvTeamNameIndex(): Promise<{ external_id: number; name: string }[]> {
    const { data, error } = await getSupabase()
        .from('lzv_teams')
        .select('external_id, name');

    if (error) throw error;
    return data || [];
}

export async function updateCoreMatchLzvLink(
    id: number,
    lzvMatchExternalId: string | null,
    opponentLzvId: number | null,
): Promise<void> {
    const { error } = await getSupabase()
        .from('core_matches')
        .update({
            lzv_match_external_id: lzvMatchExternalId,
            opponent_lzv_id: opponentLzvId,
        })
        .eq('id', id);

    if (error) throw error;
}

export async function getCoreTeamByName(name: string) {
    const { data, error } = await getSupabase()
        .from('core_teams')
        .select('*')
        .eq('name', name)
        .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
}

export async function createCoreMatch(data: CoreMatchData) {
    const { data: match, error } = await getSupabase()
        .from('core_matches')
        .insert({
            ...data,
            date: data.date.toISOString()
        })
        .select()
        .single();
    
    if (error) throw error;
    return match;
}

export async function deleteCoreMatch(id: number) {
    // First delete attendance records
    await getSupabase()
        .from('attendances')
        .delete()
        .eq('match_id', id);
    
    const { error } = await getSupabase()
        .from('core_matches')
        .delete()
        .eq('id', id);
    
    if (error) throw error;
}

export async function getCorePlayersForAttendance() {
    const { data, error } = await getSupabase()
        .from('core_players')
        .select('id');
    
    if (error) throw error;
    return data || [];
}

export async function createAttendances(matchId: number, playerIds: number[]) {
    const records = playerIds.map(playerId => ({
        match_id: matchId,
        player_id: playerId,
        status: 'NotPresent'
    }));
    
    const { error } = await getSupabase()
        .from('attendances')
        .insert(records);
    
    if (error && !error.message.includes('duplicate')) throw error;
}

// ============================================================================
// WEB PUSH
// ============================================================================

export interface PushSubscriptionRow {
    endpoint: string;
    p256dh: string;
    auth: string;
    player_id: number | null;
}

export interface PushOutboxRow {
    id: number;
    endpoint: string;
    title: string;
    body: string;
    url: string | null;
    tag: string | null;
    attempts: number;
    push_subscriptions: { p256dh: string; auth: string } | null;
}

export async function getPushSubscriptionsForPlayers(playerIds: number[]): Promise<PushSubscriptionRow[]> {
    if (playerIds.length === 0) return [];
    const { data, error } = await getSupabase()
        .from('push_subscriptions')
        .select('endpoint, p256dh, auth, player_id')
        .in('player_id', playerIds);

    if (error) throw error;
    return data || [];
}

/** Inserts sent markers and returns only the ones that were new (i.e. not yet sent). */
export async function claimPushSent(
    rows: { player_id: number; match_id: number; kind: string }[],
): Promise<{ player_id: number; match_id: number; kind: string }[]> {
    if (rows.length === 0) return [];
    const { data, error } = await getSupabase()
        .from('push_sent')
        .upsert(rows, { onConflict: 'player_id,match_id,kind', ignoreDuplicates: true })
        .select('player_id, match_id, kind');

    if (error) throw error;
    return data || [];
}

export async function insertPushOutbox(
    rows: { endpoint: string; title: string; body: string; url: string; tag: string }[],
): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await getSupabase().from('push_outbox').insert(rows);
    if (error) throw error;
}

export async function getDuePushOutbox(now: Date, limit: number): Promise<PushOutboxRow[]> {
    const { data, error } = await getSupabase()
        .from('push_outbox')
        .select('id, endpoint, title, body, url, tag, attempts, push_subscriptions(p256dh, auth)')
        .lte('send_at', now.toISOString())
        .order('send_at', { ascending: true })
        .limit(limit);

    if (error) throw error;
    return (data || []) as unknown as PushOutboxRow[];
}

export async function deletePushOutbox(id: number): Promise<void> {
    const { error } = await getSupabase().from('push_outbox').delete().eq('id', id);
    if (error) throw error;
}

export async function recordPushOutboxFailure(id: number, attempts: number): Promise<void> {
    const { error } = await getSupabase().from('push_outbox').update({ attempts }).eq('id', id);
    if (error) throw error;
}

/** Drops a subscription the push service reported gone; its outbox rows cascade. */
export async function deletePushSubscription(endpoint: string): Promise<void> {
    const { error } = await getSupabase().from('push_subscriptions').delete().eq('endpoint', endpoint);
    if (error) throw error;
}
