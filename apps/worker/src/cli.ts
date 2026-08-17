/**
 * CLI dos jobs, para desenvolvimento e para rodar fora da Vercel.
 *
 * Chama exatamente o mesmo `runJob` que o endpoint HTTP usa. É deliberado: um job que
 * funciona na CLI e não em produção porque o endpoint chama outro caminho é um modo de
 * falha comum e difícil de perceber.
 *
 *   pnpm --filter @minhatv/worker run:job detectLives
 *   pnpm --filter @minhatv/worker run:job refreshPools --max-items 10
 */

import { createNeonDb, databaseUrlFromEnv } from '@minhatv/db';
import { QuotaLedger, YouTubeClient } from '@minhatv/yt';
import { JOBS, runJob } from './registry.js';
import { DEFAULT_BUDGET, type JobBudget } from './types.js';

function parseArgs(argv: readonly string[]): {
  readonly job: string | undefined;
  readonly budget: JobBudget;
} {
  const [job, ...rest] = argv;
  let quotaUnits = DEFAULT_BUDGET.quotaUnits;
  let maxItems = DEFAULT_BUDGET.maxItems;

  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = Number(rest[i + 1]);
    if (!Number.isFinite(value)) continue;
    if (flag === '--quota') quotaUnits = value;
    if (flag === '--max-items') maxItems = value;
  }

  return { job, budget: { quotaUnits, maxItems } };
}

async function main(): Promise<void> {
  const { job, budget } = parseArgs(process.argv.slice(2));

  if (!job) {
    console.error('uso: run:job <nome> [--quota N] [--max-items N]\n');
    console.error('jobs disponíveis:');
    for (const j of JOBS) {
      const cota = j.usesQuota ? 'consome cota' : 'sem cota';
      console.error(`  ${j.name.padEnd(22)} ${j.cadence.padEnd(12)} ${cota}  ${j.describe}`);
    }
    process.exitCode = 1;
    return;
  }

  const db = createNeonDb(databaseUrlFromEnv(process.env));

  /*
   * O cliente da API só é montado quando há credencial. Jobs que não consomem cota
   * (purgas, materialização de grade) rodam sem nenhuma, e é útil poder rodá-los sem
   * configurar o Google Cloud.
   */
  const apiKey = process.env['YOUTUBE_API_KEY'];
  const accessToken = process.env['YOUTUBE_ACCESS_TOKEN'];
  const yt =
    apiKey || accessToken
      ? new YouTubeClient({
          credentials: {
            ...(apiKey ? { apiKey } : {}),
            ...(accessToken ? { accessToken } : {}),
          },
          ledger: new QuotaLedger(Date.now()),
        })
      : null;

  const report = await runJob(job, { db, yt, now: () => Date.now(), log: logLine }, budget);

  console.error(JSON.stringify(report, null, 2));
  // Saída diferente de zero quando houve erro: o agendador precisa ver a falha.
  if (report.errors.length > 0) process.exitCode = 1;
}

function logLine(message: string, data?: Record<string, unknown>): void {
  console.error(data ? `${message} ${JSON.stringify(data)}` : message);
}

await main();
