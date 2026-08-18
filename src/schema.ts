import { builder } from '~/builder'

// Importing each module registers its types and fields on the shared builder.
// Phase 0 ships the builder and the isUp probe only; domain modules land with
// their features (auth in phase 2, teams and depth charts in phase 3).
import '~/schemas/enums.server'

export const schema = builder.toSchema({})
