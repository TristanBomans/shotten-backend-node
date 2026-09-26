/**
 * Supabase data types
 */

export interface LzvTeamData {
  external_id: number;
  name: string;
  league_id?: number;
  league_name?: string;
  rank?: number;
  points?: number;
  matches_played?: number;
  wins?: number;
  draws?: number;
  losses?: number;
  goals_for?: number;
  goals_against?: number;
  goal_difference?: number;
  points_per_match?: number;
  form?: string[];
  colors?: string;
  manager?: string;
  description?: string;
  image_base64?: string;
  last_updated?: Date;
}

export interface LzvMatchData {
  external_id: string;
  date: Date;
  home_team: string;
  away_team: string;
  home_score?: number;
  away_score?: number;
  location?: string;
  team_id: number;
  home_team_id?: number | null;
  away_team_id?: number | null;
  status?: "Scheduled" | "Played" | "Postponed";
  /** Id of lzvcup.be/results/detail/{id}, present once the match has a result page. */
  lzv_result_id?: number | null;
}

export interface LzvLineupPlayer {
  playerId: number | null;
  name: string;
  number: number | null;
  captain: boolean;
  goals: number;
  assists: number;
}

export interface LzvMatchDetailData {
  result_id: number;
  date: Date | null;
  location: string | null;
  home_team: string;
  away_team: string;
  home_team_id: number | null;
  away_team_id: number | null;
  home_score: number | null;
  away_score: number | null;
  home_lineup: LzvLineupPlayer[];
  away_lineup: LzvLineupPlayer[];
}

export interface LzvPlayerData {
  external_id: number;
  name: string;
  team_stats: {
    team_id: number;
    jersey_number?: number;
    games_played: number;
    goals: number;
    assists: number;
    fairplay_rank?: number;
  }[];
}

export interface CoreMatchData {
  date: Date;
  location?: string;
  name?: string;
  team_name?: string;
  team_id?: number;
  forfait?: boolean;
  lzv_match_external_id?: string | null;
  opponent_lzv_id?: number | null;
}
