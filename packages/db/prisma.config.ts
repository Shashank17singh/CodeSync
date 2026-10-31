import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Not env(): `prisma generate` must work in CI without a database.
    url: process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/codesync',
  },
})
