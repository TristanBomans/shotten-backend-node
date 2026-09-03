const GENERIC_TEAM_TOKENS = new Set([
    'fc',
    'cf',
    'sc',
    'ac',
    'sv',
    'vk',
    'kv',
    'vc',
    'vv',
    'kfc',
    'ksk',
    'rc',
]);

function normalizeWhitespace(value: string): string {
    return value.replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ');
}

function tokenize(value: string): string[] {
    const normalized = normalizeTeamName(value);
    if (!normalized) return [];
    return normalized.split(' ').filter(Boolean);
}

function coreTokens(value: string): string[] {
    return tokenize(value).filter(token => !GENERIC_TEAM_TOKENS.has(token));
}

function hasPhraseBoundary(haystack: string, phrase: string): boolean {
    if (!haystack || !phrase) return false;
    if (haystack === phrase) return true;
    return haystack.startsWith(`${phrase} `) || haystack.endsWith(` ${phrase}`) || haystack.includes(` ${phrase} `);
}

function sortedTokenKey(tokens: string[]): string {
    if (tokens.length === 0) return '';
    return [...tokens].sort().join(' ');
}

function calculateTokenOverlapScore(baseTeam: string, candidateTeam: string): number {
    const base = new Set(coreTokens(baseTeam));
    const candidate = new Set(coreTokens(candidateTeam));

    if (base.size === 0 || candidate.size === 0) return 0;

    let overlap = 0;
    for (const token of base) {
        if (candidate.has(token)) overlap += 1;
    }

    return overlap / Math.max(base.size, candidate.size);
}

export function normalizeTeamName(value: string): string {
    return normalizeWhitespace(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[\'`’´]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function isSameTeamName(left: string, right: string): boolean {
    const leftNormalized = normalizeTeamName(left);
    const rightNormalized = normalizeTeamName(right);

    if (!leftNormalized || !rightNormalized) return false;
    if (leftNormalized === rightNormalized) return true;

    const leftCore = coreTokens(left);
    const rightCore = coreTokens(right);

    if (leftCore.length > 0 && rightCore.length > 0) {
        const leftCoreJoined = leftCore.join(' ');
        const rightCoreJoined = rightCore.join(' ');

        if (leftCoreJoined === rightCoreJoined) return true;
        if (sortedTokenKey(leftCore) === sortedTokenKey(rightCore)) return true;

        const [longerCore, shorterCore] = leftCoreJoined.length >= rightCoreJoined.length
            ? [leftCoreJoined, rightCoreJoined]
            : [rightCoreJoined, leftCoreJoined];

        if (shorterCore.length >= 6 && hasPhraseBoundary(longerCore, shorterCore)) {
            return true;
        }
    }

    const [longerNormalized, shorterNormalized] = leftNormalized.length >= rightNormalized.length
        ? [leftNormalized, rightNormalized]
        : [rightNormalized, leftNormalized];

    return shorterNormalized.length >= 8 && hasPhraseBoundary(longerNormalized, shorterNormalized);
}

export function isHomeTeamForMatch(teamName: string, homeTeam: string, awayTeam: string): boolean {
    const matchesHome = isSameTeamName(teamName, homeTeam);
    const matchesAway = isSameTeamName(teamName, awayTeam);

    if (matchesHome && !matchesAway) return true;
    if (matchesAway && !matchesHome) return false;
    if (matchesHome && matchesAway) return true;

    const homeScore = calculateTokenOverlapScore(teamName, homeTeam);
    const awayScore = calculateTokenOverlapScore(teamName, awayTeam);

    if (homeScore === awayScore) {
        // Conservative fallback: avoid accidental home-side positives on weak matches.
        return false;
    }

    return homeScore > awayScore;
}

export function findNamedTeam<T extends { name: string }>(teams: T[], teamName: string): T | undefined {
    const exactOrNear = teams.find(t => isSameTeamName(t.name, teamName));
    if (exactOrNear) return exactOrNear;

    const normalized = normalizeTeamName(teamName);
    if (!normalized) return undefined;

    return teams.find(t => {
        const normalizedTeamName = normalizeTeamName(t.name);
        return normalizedTeamName.includes(normalized) || normalized.includes(normalizedTeamName);
    });
}
