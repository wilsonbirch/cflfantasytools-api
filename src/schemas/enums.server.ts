import { builder } from '~/builder'
import { Role, ScrapeStatus, EmailStatus, JobStatus } from '~/generated/prisma/client'

// Prisma enums exposed to GraphQL. Registered centrally so a domain module never
// races another to define the same enum.
builder.enumType(Role, { name: 'Role' })
builder.enumType(ScrapeStatus, { name: 'ScrapeStatus' })
builder.enumType(EmailStatus, { name: 'EmailStatus' })
builder.enumType(JobStatus, { name: 'JobStatus' })
