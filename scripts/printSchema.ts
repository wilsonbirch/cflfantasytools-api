// Writes the GraphQL SDL to schema.graphql at the repo root. The committed file is
// the codegen input for BOTH cflfantasytools-web and -native; CI fails if it drifts
// from the code-first Pothos schema (see the typecheck job in ci.yml). This file is
// the cross-repo contract, which is why a schema change ships as a stacked PR set
// with api first.
import { writeFileSync } from 'node:fs'
import { lexicographicSortSchema, printSchema } from 'graphql'

import { schema } from '~/schema'

const sdl = printSchema(lexicographicSortSchema(schema))
writeFileSync('schema.graphql', `${sdl}\n`)
console.log('Wrote schema.graphql')
