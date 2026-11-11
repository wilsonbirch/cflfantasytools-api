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
}

// Extractor parameter shapes, by strategy:
//   tableRowCells      { titleCells, linkCell, minCells, hrefMustMatch?,
//                        hrefMustInclude?, skipHeaderMatch? }
//   tableCellLookback  { lookback }
//   cardList           { cardSelector, titleSelectors, linkTextMatch?, linkHrefMatch? }
//   articleList        { linkHrefMatch, titleSelector?, pdfHrefMatch? }
//   composite          { parts: [{ strategy, config }] }
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
        // Moved when the CFL put every club on one site platform in 2026; the old
        // WordPress page 404s. Bare domain: www. now redirects to it.
        depthChartUrl: 'https://riderville.com/position-charts',
        // Rows are regular on the new page; the lookback walk also caught the
        // "3 points of the game" article links that now share the table.
        strategy: 'tableRowCells',
        config: { titleCells: [0, 1, 2], linkCell: 4, minCells: 5 },
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
        // Moved when the CFL put every club on one site platform in 2026; the old
        // WordPress page 404s. Bare domain: www. now redirects to it.
        depthChartUrl: 'https://bclions.com/depth-chart-and-game-notes',
        strategy: 'tableRowCells',
        config: { titleCells: [0, 1, 2], linkCell: 4, minCells: 5 },
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
        // From 2026 Edmonton posts each chart as its own article; the PDF is
        // linked from inside it. The old /gamenotes/ page redirects here.
        depthChartUrl: 'https://goelks.com/depth-chart-updates',
        strategy: 'articleList',
        config: {
            linkHrefMatch: '/article/[^/]*depth-chart',
            titleSelector: 'p.line-clamp-2',
            pdfHrefMatch: '\\.pdf$',
        },
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
        // Moved when the CFL put every club on one site platform in 2026; the old
        // WordPress page 404s. Bare domain: www. now redirects to it.
        depthChartUrl: 'https://stampeders.com/position-charts-game-notes-page',
        strategy: 'tableRowCells',
        config: { titleCells: [0, 1, 2], linkCell: 4, minCells: 5 },
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
        // 2026 platform: five cells (… | Digital Roster | Depth Chart), was six.
        config: { titleCells: [0, 1, 2], linkCell: 4, minCells: 5 },
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
        depthChartUrl: 'https://ticats.ca/depth-charts',
        // 2026 platform. The season is a table (Hamilton's chart in cell 4,
        // the opponent's in 5) carried in the page payload and inlined by
        // fetchPage; the newest game is ALSO a card of its own, and Game 18 is
        // ONLY a card. The card's chart link reads "Hamilton Depth & Roster",
        // "… Roster Chart" or plain "Depth & Roster" — never the opponent's.
        strategy: 'composite',
        config: {
            parts: [
                {
                    strategy: 'tableRowCells',
                    config: {
                        titleCells: [0, 1, 2],
                        linkCell: 4,
                        minCells: 5,
                        hrefMustMatch: '\\.pdf$',
                    },
                },
                {
                    strategy: 'cardList',
                    config: {
                        cardSelector: 'section',
                        titleSelectors: ['h5'],
                        linkTextMatch: '^(Hamilton )?Depth & Roster',
                    },
                },
            ],
        },
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
        depthChartUrl: 'https://ottawaredblacks.com/depth-charts',
        strategy: 'cardList',
        // 2026 platform: server-rendered, so no browser is needed any more —
        // the client-rendered page that made Ottawa the one Chromium club is gone.
        config: {
            cardSelector: 'li',
            titleSelectors: ['h3', 'p'],
            // The button text varies by week; the card's one PDF is the chart.
            linkHrefMatch: '\\.pdf$',
        },
    },
]
