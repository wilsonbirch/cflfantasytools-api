// Head coaches and coordinators, 2023 to date. HAND DATA: no feed carries it.
//
// Every row names its source in the trailing comment. A cell that could not be
// sourced is left out rather than guessed — see the notes at the bottom. Dates:
// `from` is 2023-01-01 for someone already in post at the start of 2023, else
// the announcement date; `to` is the date the person left the role, null while
// current. A head coach who is also the coordinator has a row per role.
//
// Seeded by prisma/seed.ts, upserting on (team, role, person, effectiveFrom), and
// editable from the admin surface — a correction made there survives a re-seed
// because the seed only fills in what is missing.

export type CoachingRoleSeed = 'HC' | 'OC' | 'DC'

export type CoachingStaffSeed = {
    team: string
    role: CoachingRoleSeed
    person: string
    from: string
    to: string | null
}

export const COACHING_STAFF: CoachingStaffSeed[] = [
    // saskatchewan-roughriders
    {
        team: 'saskatchewan-roughriders',
        role: 'HC',
        person: 'Craig Dickenson',
        from: '2023-01-01',
        to: '2023-10-23',
    }, // source: https://www.cbc.ca/news/canada/saskatchewan/roughriders-saskatchewan-coach-1.7005249
    {
        team: 'saskatchewan-roughriders',
        role: 'HC',
        person: 'Corey Mace',
        from: '2023-12-01',
        to: null,
    }, // source: https://www.cfl.ca/2023/11/30/report-riders-hire-corey-mace-as-head-coach/
    {
        team: 'saskatchewan-roughriders',
        role: 'OC',
        person: 'Kelly Jeffrey',
        from: '2023-01-01',
        to: '2023-12-01',
    }, // source: https://en.wikipedia.org/wiki/2023_Saskatchewan_Roughriders_season (end date approximated to HC transition; exact departure date not found)
    {
        team: 'saskatchewan-roughriders',
        role: 'OC',
        person: 'Marc Mueller',
        from: '2024-01-01',
        to: null,
    }, // source: https://en.wikipedia.org/wiki/2024_Saskatchewan_Roughriders_season
    {
        team: 'saskatchewan-roughriders',
        role: 'DC',
        person: 'Jason Shivers',
        from: '2023-01-01',
        to: '2024-03-18',
    }, // source: https://en.wikipedia.org/wiki/2023_Saskatchewan_Roughriders_season ; end: https://www.cfl.ca/2024/03/18/elks-announce-coaching-staff-bring-back-jason-shivers/
    {
        team: 'saskatchewan-roughriders',
        role: 'DC',
        person: 'Corey Mace',
        from: '2024-01-01',
        to: null,
    }, // source: https://en.wikipedia.org/wiki/2024_Saskatchewan_Roughriders_season

    // bc-lions
    { team: 'bc-lions', role: 'HC', person: 'Rick Campbell', from: '2023-01-01', to: '2024-11-20' }, // source: https://www.cbc.ca/news/canada/british-columbia/bc-lions-fire-rick-campbell-1.7388585
    { team: 'bc-lions', role: 'HC', person: 'Buck Pierce', from: '2024-12-03', to: null }, // source: https://www.bclions.com/2024/12/03/buck-pierce-named-the-28th-head-coach-in-lions-history/
    {
        team: 'bc-lions',
        role: 'OC',
        person: 'Jordan Maksymic',
        from: '2023-01-01',
        to: '2024-12-04',
    }, // source: https://en.wikipedia.org/wiki/2023_BC_Lions_season ; end: https://3downnation.com/2024/12/04/homecoming-jordan-maksymic-j-c-sherritt-joining-edmonton-elks-as-coordinators/
    { team: 'bc-lions', role: 'OC', person: 'Buck Pierce', from: '2024-12-03', to: null }, // source: https://en.wikipedia.org/wiki/2025_BC_Lions_season
    { team: 'bc-lions', role: 'DC', person: 'Ryan Phillips', from: '2023-01-01', to: '2025-01-02' }, // source: https://en.wikipedia.org/wiki/2023_BC_Lions_season ; end: https://3downnation.com/2025/01/02/b-c-lions-confirm-mike-benevides-as-dc-demote-ryan-phillips-on-finalized-coaching-staff/
    { team: 'bc-lions', role: 'DC', person: 'Mike Benevides', from: '2025-01-02', to: null }, // source: https://3downnation.com/2025/01/02/b-c-lions-confirm-mike-benevides-as-dc-demote-ryan-phillips-on-finalized-coaching-staff/

    // calgary-stampeders
    {
        team: 'calgary-stampeders',
        role: 'HC',
        person: 'Dave Dickenson',
        from: '2023-01-01',
        to: null,
    }, // source: https://en.wikipedia.org/wiki/2023_Calgary_Stampeders_season
    {
        team: 'calgary-stampeders',
        role: 'OC',
        person: 'Pat DelMonaco',
        from: '2023-01-01',
        to: null,
    }, // source: https://en.wikipedia.org/wiki/2023_Calgary_Stampeders_season
    {
        team: 'calgary-stampeders',
        role: 'DC',
        person: 'Brent Monson',
        from: '2023-01-01',
        to: '2024-12-16',
    }, // source: https://en.wikipedia.org/wiki/2023_Calgary_Stampeders_season ; end: https://3downnation.com/2024/12/16/calgary-stampeders-finalize-2025-coaching-staff-promote-bob-slowik-to-defensive-coordinator/
    { team: 'calgary-stampeders', role: 'DC', person: 'Bob Slowik', from: '2024-12-16', to: null }, // source: https://3downnation.com/2024/12/16/calgary-stampeders-finalize-2025-coaching-staff-promote-bob-slowik-to-defensive-coordinator/

    // edmonton-elks
    {
        team: 'edmonton-elks',
        role: 'HC',
        person: 'Chris Jones',
        from: '2023-01-01',
        to: '2024-07-15',
    }, // source: https://www.tsn.ca/cfl/edmonton-elks-fire-head-coach-gm-chris-jones-appoint-jarious-jackson-interim-head-coach-1.2148667
    {
        team: 'edmonton-elks',
        role: 'HC',
        person: 'Jarious Jackson',
        from: '2024-07-15',
        to: '2024-12-02',
    }, // source: https://www.tsn.ca/cfl/edmonton-elks-fire-head-coach-gm-chris-jones-appoint-jarious-jackson-interim-head-coach-1.2148667 (interim) ; end: https://www.oursportscentral.com/services/releases/mark-kilam-named-edmonton-elks-head-coach/n-6169802
    { team: 'edmonton-elks', role: 'HC', person: 'Mark Kilam', from: '2024-12-02', to: null }, // source: https://www.tsn.ca/cfl/mark-kilam-officially-named-edmonton-elks-head-coach-1.2212881
    {
        team: 'edmonton-elks',
        role: 'OC',
        person: 'Stephen McAdoo',
        from: '2023-01-01',
        to: '2023-07-31',
    }, // source: https://www.cfl.ca/2023/07/31/elks-promote-jarious-jackson-to-offensive-coordinator/
    {
        team: 'edmonton-elks',
        role: 'OC',
        person: 'Jarious Jackson',
        from: '2023-07-31',
        to: '2024-12-04',
    }, // source: https://www.cfl.ca/2023/07/31/elks-promote-jarious-jackson-to-offensive-coordinator/ ; end: https://3downnation.com/2024/12/04/homecoming-jordan-maksymic-j-c-sherritt-joining-edmonton-elks-as-coordinators/
    { team: 'edmonton-elks', role: 'OC', person: 'Jordan Maksymic', from: '2024-12-04', to: null }, // source: https://3downnation.com/2024/12/04/homecoming-jordan-maksymic-j-c-sherritt-joining-edmonton-elks-as-coordinators/
    {
        team: 'edmonton-elks',
        role: 'DC',
        person: 'Chris Jones',
        from: '2023-01-01',
        to: '2024-03-18',
    }, // source: https://en.wikipedia.org/wiki/2023_Edmonton_Elks_season ; end: https://www.cfl.ca/2024/03/18/elks-announce-coaching-staff-bring-back-jason-shivers/
    {
        team: 'edmonton-elks',
        role: 'DC',
        person: 'Jason Shivers',
        from: '2024-03-18',
        to: '2024-12-04',
    }, // source: https://www.cfl.ca/2024/03/18/elks-announce-coaching-staff-bring-back-jason-shivers/ ; end: https://3downnation.com/2024/12/04/homecoming-jordan-maksymic-j-c-sherritt-joining-edmonton-elks-as-coordinators/
    { team: 'edmonton-elks', role: 'DC', person: 'J.C. Sherritt', from: '2024-12-04', to: null }, // source: https://3downnation.com/2024/12/04/homecoming-jordan-maksymic-j-c-sherritt-joining-edmonton-elks-as-coordinators/

    // winnipeg-blue-bombers
    {
        team: 'winnipeg-blue-bombers',
        role: 'HC',
        person: "Mike O'Shea",
        from: '2023-01-01',
        to: null,
    }, // source: https://en.wikipedia.org/wiki/2023_Winnipeg_Blue_Bombers_season
    {
        team: 'winnipeg-blue-bombers',
        role: 'OC',
        person: 'Buck Pierce',
        from: '2023-01-01',
        to: '2024-12-03',
    }, // source: https://en.wikipedia.org/wiki/2023_Winnipeg_Blue_Bombers_season ; end: https://www.bclions.com/2024/12/03/buck-pierce-named-the-28th-head-coach-in-lions-history/
    {
        team: 'winnipeg-blue-bombers',
        role: 'OC',
        person: 'Jason Hogan',
        from: '2025-02-04',
        to: '2025-12-22',
    }, // source: https://www.bluebombers.com/2025/02/04/winnipeg-blue-bombers-name-jason-hogan-offensive-coordinator-jarious-jackson-quarterbacks-coach/ ; end: https://3downnation.com/2025/12/22/winnipeg-blue-bombers-hire-tommy-condell-as-offensive-coordinator-jake-thomas-as-defensive-line-coach/
    {
        team: 'winnipeg-blue-bombers',
        role: 'OC',
        person: 'Tommy Condell',
        from: '2025-12-22',
        to: null,
    }, // source: https://3downnation.com/2025/12/22/winnipeg-blue-bombers-hire-tommy-condell-as-offensive-coordinator-jake-thomas-as-defensive-line-coach/
    {
        team: 'winnipeg-blue-bombers',
        role: 'DC',
        person: 'Richie Hall',
        from: '2023-01-01',
        to: '2024-01-08',
    }, // source: https://en.wikipedia.org/wiki/2023_Winnipeg_Blue_Bombers_season ; end: https://3downnation.com/2024/01/08/winnipeg-blue-bombers-promote-jordan-younger-to-defensive-coordinator-hire-mike-miller/
    {
        team: 'winnipeg-blue-bombers',
        role: 'DC',
        person: 'Jordan Younger',
        from: '2024-01-08',
        to: null,
    }, // source: https://3downnation.com/2024/01/08/winnipeg-blue-bombers-promote-jordan-younger-to-defensive-coordinator-hire-mike-miller/

    // hamilton-tiger-cats
    {
        team: 'hamilton-tiger-cats',
        role: 'HC',
        person: 'Orlondo Steinauer',
        from: '2023-01-01',
        to: '2023-12-05',
    }, // source: https://3downnation.com/2023/12/05/tiger-cats-name-ed-hervey-gm-orlondo-steinauer-focusing-on-president-of-football-operations-role/
    {
        team: 'hamilton-tiger-cats',
        role: 'HC',
        person: 'Scott Milanovich',
        from: '2023-12-05',
        to: null,
    }, // source: https://3downnation.com/2023/12/05/tiger-cats-name-ed-hervey-gm-orlondo-steinauer-focusing-on-president-of-football-operations-role/
    {
        team: 'hamilton-tiger-cats',
        role: 'OC',
        person: 'Tommy Condell',
        from: '2023-01-01',
        to: '2023-08-07',
    }, // source: https://3downnation.com/2023/08/07/tommy-condell-out-as-hamilton-tiger-cats-offensive-coordinator/
    {
        team: 'hamilton-tiger-cats',
        role: 'OC',
        person: 'Scott Milanovich',
        from: '2023-12-05',
        to: null,
    }, // source: https://3downnation.com/2023/12/05/tiger-cats-name-ed-hervey-gm-orlondo-steinauer-focusing-on-president-of-football-operations-role/ (confirmed continuing HC/OC through 2024-2026 via https://en.wikipedia.org/wiki/2024_Hamilton_Tiger-Cats_season, https://en.wikipedia.org/wiki/2025_Hamilton_Tiger-Cats_season)
    {
        team: 'hamilton-tiger-cats',
        role: 'DC',
        person: 'Mark Washington',
        from: '2023-01-01',
        to: '2024-08-18',
    }, // source: https://en.wikipedia.org/wiki/2023_Hamilton_Tiger-Cats_season ; end: https://3downnation.com/2024/08/18/ticats-hire-former-elks-head-coach-chris-jones-as-defensive-coordinator-fire-mark-washington-report/
    {
        team: 'hamilton-tiger-cats',
        role: 'DC',
        person: 'Chris Jones',
        from: '2024-08-18',
        to: '2024-12-17',
    }, // source: https://3downnation.com/2024/08/18/ticats-hire-former-elks-head-coach-chris-jones-as-defensive-coordinator-fire-mark-washington-report/ ; end: https://3downnation.com/2024/12/16/brent-monson-hired-as-hamilton-tiger-cats-defensive-coordinator/
    {
        team: 'hamilton-tiger-cats',
        role: 'DC',
        person: 'Brent Monson',
        from: '2024-12-17',
        to: null,
    }, // source: https://www.ticats.ca/2024/12/17/tiger-cats-hire-hamilton-native-brent-monson-as-defensive-coordinator/

    // toronto-argonauts
    {
        team: 'toronto-argonauts',
        role: 'HC',
        person: 'Ryan Dinwiddie',
        from: '2023-01-01',
        to: '2025-11-05',
    }, // source: https://en.wikipedia.org/wiki/2023_Toronto_Argonauts_season ; end: https://www.cfl.ca/2025/11/05/redblacks-name-ryan-dinwiddie-head-coach-general-manager/
    { team: 'toronto-argonauts', role: 'HC', person: 'Mike Miller', from: '2025-12-02', to: null }, // source: https://www.tsn.ca/cfl/article/miller-steps-in-as-argonauts-head-coach-after-dinwiddies-exit/
    {
        team: 'toronto-argonauts',
        role: 'OC',
        person: 'Ryan Dinwiddie',
        from: '2024-01-01',
        to: '2025-11-05',
    }, // source: https://en.wikipedia.org/wiki/2024_Toronto_Argonauts_season (also https://en.wikipedia.org/wiki/2025_Toronto_Argonauts_season); end: https://www.cfl.ca/2025/11/05/redblacks-name-ryan-dinwiddie-head-coach-general-manager/
    { team: 'toronto-argonauts', role: 'OC', person: 'Mike Miller', from: '2025-12-02', to: null }, // source: https://www.tsn.ca/cfl/article/argonauts-to-promote-miller-to-head-coach-position/
    {
        team: 'toronto-argonauts',
        role: 'DC',
        person: 'Corey Mace',
        from: '2023-01-01',
        to: '2023-11-30',
    }, // source: https://en.wikipedia.org/wiki/2023_Toronto_Argonauts_season ; end: https://3downnation.com/2023/11/29/saskatchewan-roughriders-hire-corey-mace-as-head-coach/
    {
        team: 'toronto-argonauts',
        role: 'DC',
        person: 'Kevin Eiben',
        from: '2024-05-01',
        to: '2026-01-08',
    }, // source: https://www.cfl.ca/2024/05/01/argos-announce-william-fields-kevin-eiben-defensive-co-coordinators/ ; end: https://www.cfl.ca/2026/01/08/argonauts-announce-2026-coaching-staff/
    {
        team: 'toronto-argonauts',
        role: 'DC',
        person: 'William Fields',
        from: '2024-05-01',
        to: '2025-01-06',
    }, // source: https://www.cfl.ca/2024/05/01/argos-announce-william-fields-kevin-eiben-defensive-co-coordinators/ ; end: https://www.theglobeandmail.com/sports/football/article-ottawa-redblacks-hire-fields-as-their-defensive-co-ordinator-and/
    {
        team: 'toronto-argonauts',
        role: 'DC',
        person: 'Jason Shivers',
        from: '2025-03-21',
        to: '2026-01-08',
    }, // source: https://3downnation.com/2025/03/21/argos-hire-jason-shivers-as-co-defensive-coordinator-unveil-2025-coaching-staff/ ; end: https://www.cfl.ca/2026/01/08/argonauts-announce-2026-coaching-staff/
    { team: 'toronto-argonauts', role: 'DC', person: 'Greg Quick', from: '2026-01-08', to: null }, // source: https://www.cfl.ca/2026/01/08/argonauts-announce-2026-coaching-staff/

    // ottawa-redblacks
    {
        team: 'ottawa-redblacks',
        role: 'HC',
        person: 'Bob Dyce',
        from: '2023-01-01',
        to: '2025-11-05',
    }, // source: https://en.wikipedia.org/wiki/2023_Ottawa_Redblacks_season ; end: https://www.cfl.ca/2025/11/05/redblacks-name-ryan-dinwiddie-head-coach-general-manager/
    {
        team: 'ottawa-redblacks',
        role: 'HC',
        person: 'Ryan Dinwiddie',
        from: '2025-11-05',
        to: null,
    }, // source: https://www.cfl.ca/2025/11/05/redblacks-name-ryan-dinwiddie-head-coach-general-manager/
    {
        team: 'ottawa-redblacks',
        role: 'OC',
        person: 'Khari Jones',
        from: '2023-01-01',
        to: '2023-12-04',
    }, // source: https://en.wikipedia.org/wiki/2023_Ottawa_Redblacks_season ; end: https://3downnation.com/2023/12/04/ottawa-redblacks-hire-tommy-condell-as-offensive-coordinator/
    {
        team: 'ottawa-redblacks',
        role: 'OC',
        person: 'Tommy Condell',
        from: '2023-12-04',
        to: '2025-12-22',
    }, // source: https://3downnation.com/2023/12/04/ottawa-redblacks-hire-tommy-condell-as-offensive-coordinator/ ; end: https://3downnation.com/2025/12/22/winnipeg-blue-bombers-hire-tommy-condell-as-offensive-coordinator-jake-thomas-as-defensive-line-coach/
    {
        team: 'ottawa-redblacks',
        role: 'OC',
        person: 'Ryan Dinwiddie',
        from: '2025-12-22',
        to: null,
    }, // source: https://en.wikipedia.org/wiki/2026_Ottawa_Redblacks_season
    {
        team: 'ottawa-redblacks',
        role: 'DC',
        person: 'Barron Miles',
        from: '2023-01-01',
        to: '2025-01-06',
    }, // source: https://en.wikipedia.org/wiki/2023_Ottawa_Redblacks_season ; end: https://www.cfl.ca/2025/01/06/redblacks-name-william-fields-defensive-coordinator/
    {
        team: 'ottawa-redblacks',
        role: 'DC',
        person: 'William Fields',
        from: '2025-01-06',
        to: '2026-08-01',
    }, // source: https://www.cfl.ca/2025/01/06/redblacks-name-william-fields-defensive-coordinator/ ; end: https://3downnation.com/2026/08/01/ottawa-redblacks-fire-william-fields-move-jeff-reinebold-to-defensive-coordinator/
    {
        team: 'ottawa-redblacks',
        role: 'DC',
        person: 'Jeff Reinebold',
        from: '2026-08-01',
        to: null,
    }, // source: https://3downnation.com/2026/08/01/ottawa-redblacks-fire-william-fields-move-jeff-reinebold-to-defensive-coordinator/

    // montreal-alouettes
    { team: 'montreal-alouettes', role: 'HC', person: 'Jason Maas', from: '2023-01-01', to: null }, // source: https://en.wikipedia.org/wiki/2023_Montreal_Alouettes_season
    {
        team: 'montreal-alouettes',
        role: 'OC',
        person: 'Anthony Calvillo',
        from: '2023-01-01',
        to: null,
    }, // source: https://en.wikipedia.org/wiki/2023_Montreal_Alouettes_season (play-calling duties shifted from Maas to Calvillo mid-2024 but formal OC title held throughout, per https://www.tsn.ca/cfl/article/calvillo-to-call-plays-this-season-for-alouettes/)
    { team: 'montreal-alouettes', role: 'DC', person: 'Noel Thorpe', from: '2023-01-01', to: null }, // source: https://en.wikipedia.org/wiki/2023_Montreal_Alouettes_season
]

// Not seeded, because no source confirmed them:
// - toronto-argonauts OC 2023: Ryan Dinwiddie called plays as HC; no source gives
//   him the coordinator title that season (2024 onward is documented).
// - toronto-argonauts DC, Dec 2023 to Apr 2024: between Corey Mace leaving and
//   Eiben/Fields being named co-coordinators on 2024-05-01.
// - saskatchewan-roughriders OC Kelly Jeffrey: the row above ends him at the
//   head-coaching change; his exact departure date was not found.
