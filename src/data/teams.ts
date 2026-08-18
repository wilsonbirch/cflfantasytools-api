// The nine CFL clubs, with every identifier needed to join across sources.
//
// THREE ID SPACES, none interchangeable:
//   geniusTeamId     Genius/BetGenius competitorId — joins play-by-play
//   gameZoneSquadId  CFL Game Zone squad id (1-9) — joins the public JSON feeds
//   legacyTeamId     3DF's positional Team.id (1-9) — ONLY for the phase 1 migration
//
// Game Zone's 1-9 and 3DF's 1-9 are nearly reversed (Game Zone 1 = OTT, 3DF 1 =
// SSK). Everything maps through `abbreviation`; the integers are never compared.
//
// Verified 2026-08-17 against gamezone.cfl.ca/json/fantasy/squads.json.

export type TeamSeed = {
    slug: string
    abbreviation: string
    name: string
    nameFr: string
    shortName: string
    city: string
    geniusTeamId: string
    gameZoneSquadId: number
    legacyTeamId: number
    depthChartUrl: string
    strategy: string
    config: Record<string, unknown>
    requiresBrowser: boolean
}

// Extractor parameter shapes, by strategy:
//   tableRowCells      { titleCells, linkCell, minCells, hrefMustMatch?,
//                        hrefMustInclude?, skipHeaderMatch? }
//   tableCellLookback  { lookback }
//   cardList           { cardSelector, titleSelectors }
export const TEAMS: TeamSeed[] = [
    {
        slug: 'saskatchewan-roughriders',
        abbreviation: 'SSK',
        name: 'Saskatchewan Roughriders',
        nameFr: 'Roughriders de la Saskatchewan',
        shortName: 'Roughriders',
        city: 'Regina',
        geniusTeamId: '106752',
        gameZoneSquadId: 8,
        legacyTeamId: 1,
        depthChartUrl: 'https://www.riderville.com/position-charts-and-game-notes/',
        strategy: 'tableCellLookback',
        config: { lookback: 3 },
        requiresBrowser: false,
    },
    {
        slug: 'bc-lions',
        abbreviation: 'BC',
        name: 'BC Lions',
        nameFr: 'Lions de la Colombie-Britannique',
        shortName: 'Lions',
        city: 'Vancouver',
        geniusTeamId: '93775',
        gameZoneSquadId: 5,
        legacyTeamId: 2,
        // The 2025 slug 301s to this; recorded resolved so a redirect isn't load-bearing.
        depthChartUrl: 'https://www.bclions.com/2026-depth-chart-and-notes/',
        strategy: 'tableRowCells',
        config: { titleCells: [0, 1, 2], linkCell: 4, minCells: 5 },
        requiresBrowser: false,
    },
    {
        slug: 'edmonton-elks',
        abbreviation: 'EDM',
        name: 'Edmonton Elks',
        nameFr: 'Elks d’Edmonton',
        shortName: 'Elks',
        city: 'Edmonton',
        geniusTeamId: '114347',
        gameZoneSquadId: 9,
        legacyTeamId: 3,
        depthChartUrl: 'https://www.goelks.com/gamenotes/',
        strategy: 'tableRowCells',
        config: { titleCells: [0, 1, 2], linkCell: 4, minCells: 5 },
        requiresBrowser: false,
    },
    {
        slug: 'calgary-stampeders',
        abbreviation: 'CGY',
        name: 'Calgary Stampeders',
        nameFr: 'Stampeders de Calgary',
        shortName: 'Stampeders',
        city: 'Calgary',
        geniusTeamId: '112939',
        gameZoneSquadId: 6,
        legacyTeamId: 4,
        depthChartUrl: 'https://www.stampeders.com/game-notes/',
        strategy: 'tableRowCells',
        config: { titleCells: [0, 1, 2], linkCell: 4, minCells: 5 },
        requiresBrowser: false,
    },
    {
        slug: 'montreal-alouettes',
        abbreviation: 'MTL',
        name: 'Montreal Alouettes',
        nameFr: 'Alouettes de Montréal',
        shortName: 'Alouettes',
        city: 'Montreal',
        geniusTeamId: '86680',
        gameZoneSquadId: 4,
        legacyTeamId: 5,
        depthChartUrl: 'https://en.montrealalouettes.com/depth-chart/',
        strategy: 'tableRowCells',
        config: { titleCells: [0, 1, 2], linkCell: 5, minCells: 6 },
        requiresBrowser: false,
    },
    {
        slug: 'winnipeg-blue-bombers',
        abbreviation: 'WPG',
        name: 'Winnipeg Blue Bombers',
        nameFr: 'Blue Bombers de Winnipeg',
        shortName: 'Blue Bombers',
        city: 'Winnipeg',
        geniusTeamId: '110380',
        gameZoneSquadId: 7,
        legacyTeamId: 6,
        // 3DF still pointed at the 2025 page, which does NOT redirect — it has been
        // serving last season's charts all year. This is the corrected URL.
        depthChartUrl: 'https://www.bluebombers.com/2026-depth-position-charts/',
        strategy: 'tableRowCells',
        config: { titleCells: [0, 1, 2], linkCell: 4, minCells: 5 },
        requiresBrowser: false,
    },
    {
        slug: 'hamilton-tiger-cats',
        abbreviation: 'HAM',
        name: 'Hamilton Tiger-Cats',
        nameFr: 'Tiger-Cats de Hamilton',
        shortName: 'Ticats',
        city: 'Hamilton',
        geniusTeamId: '83579',
        gameZoneSquadId: 3,
        legacyTeamId: 7,
        depthChartUrl: 'https://www.ticats.ca/depth-charts/',
        strategy: 'tableRowCells',
        config: {
            titleCells: [0, 1, 2],
            linkCell: 4,
            minCells: 5,
            hrefMustMatch: '\\.pdf$',
            hrefMustInclude: ['Depth', 'Roster'],
            skipHeaderMatch: ['HAM Depth', 'OPP Depth'],
        },
        requiresBrowser: false,
    },
    {
        slug: 'toronto-argonauts',
        abbreviation: 'TOR',
        name: 'Toronto Argonauts',
        nameFr: 'Argonauts de Toronto',
        shortName: 'Argos',
        city: 'Toronto',
        geniusTeamId: '122345',
        gameZoneSquadId: 2,
        legacyTeamId: 8,
        depthChartUrl: 'https://www.argonauts.ca/depth-chart-and-game-notes/',
        strategy: 'tableCellLookback',
        config: { lookback: 3 },
        requiresBrowser: false,
    },
    {
        slug: 'ottawa-redblacks',
        abbreviation: 'OTT',
        name: 'Ottawa REDBLACKS',
        nameFr: 'ROUGE et NOIR d’Ottawa',
        shortName: 'REDBLACKS',
        city: 'Ottawa',
        geniusTeamId: '88019',
        gameZoneSquadId: 1,
        legacyTeamId: 9,
        depthChartUrl: 'https://www.ottawaredblacks.com/depth-charts/',
        strategy: 'cardList',
        // Redesigned since 3DF: .redblacks-primary-card no longer exists, and
        // the cards are rendered client-side — the raw HTML contains no PDF
        // links at all, so this is the one club that genuinely needs a browser.
        config: { cardSelector: '.depth-card', titleSelectors: ['h3', 'p'] },
        requiresBrowser: true,
    },
]
