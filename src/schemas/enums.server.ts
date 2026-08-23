import { builder } from '~/builder'
import {
    CoachingRole,
    DepthChartParseStatus,
    Role,
    ScrapeStatus,
    EmailStatus,
    JobStatus,
    PassDepth,
    PassDirection,
    RuleEra,
} from '~/generated/prisma/client'

// Prisma enums exposed to GraphQL. Registered centrally so a domain module never
// races another to define the same enum.
export const RoleEnum = builder.enumType(Role, { name: 'Role' })
export const ScrapeStatusEnum = builder.enumType(ScrapeStatus, { name: 'ScrapeStatus' })
builder.enumType(EmailStatus, { name: 'EmailStatus' })
export const JobStatusEnum = builder.enumType(JobStatus, { name: 'JobStatus' })
export const PassDepthEnum = builder.enumType(PassDepth, { name: 'PassDepth' })
export const PassDirectionEnum = builder.enumType(PassDirection, { name: 'PassDirection' })
export const RuleEraEnum = builder.enumType(RuleEra, { name: 'RuleEra' })
export const CoachingRoleEnum = builder.enumType(CoachingRole, { name: 'CoachingRole' })
export const DepthChartParseStatusEnum = builder.enumType(DepthChartParseStatus, {
    name: 'DepthChartParseStatus',
    description:
        "OK: positions were read. UNSUPPORTED: this club's layout has no parser yet. FAILED: the parser ran and could not read the file.",
})
