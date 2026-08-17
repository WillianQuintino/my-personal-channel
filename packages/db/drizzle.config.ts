import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Só usado por `drizzle-kit push`/`studio`. O `generate` não precisa de conexão,
    // e é ele que roda no fluxo normal — migrations versionadas em vez de push.
    url: process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/placeholder',
  },
  strict: true,
  verbose: true,
});
