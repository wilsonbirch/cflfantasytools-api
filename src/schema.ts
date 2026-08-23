import { builder } from '~/builder'

// Importing each module registers its types and fields on the shared builder.
import '~/schemas/enums.server'
import '~/schemas/health.server'
import '~/schemas/teams.server'
import '~/schemas/depthCharts.server'
import '~/schemas/games.server'
import '~/schemas/fantasy.server'
import '~/schemas/auth.server'
import '~/schemas/subscriptions.server'
import '~/schemas/admin.server'

export const schema = builder.toSchema({})
