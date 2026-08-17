/**
 * Contrato dos jobs.
 *
 * Todo job é uma função assíncrona que recebe dependências explícitas e devolve um
 * relatório. Sem `Date.now()` interno, sem importar driver de banco, sem `process.env`:
 * pelo mesmo motivo do `packages/core`, é o que os torna testáveis.
 *
 * Todo job também é **fatiado e retomável**. Isso nasceu de uma restrição concreta — o
 * `maxDuration` de 10 s do Vercel Cron no plano Hobby — mas é o desenho correto de
 * qualquer forma: um job que só deixa o estado consistente se rodar até o fim é um job
 * que quebra no primeiro timeout, e timeouts vão acontecer.
 */

import type { Db } from '@minhatv/db';
import type { YouTubeClient } from '@minhatv/yt';

export interface JobDeps {
  readonly db: Db;
  /**
   * Cliente da API. `null` quando o job não precisa de rede (purgas, materialização de
   * grade) — declarar assim evita exigir credenciais de quem só roda a limpeza.
   */
  readonly yt: YouTubeClient | null;
  /** Fonte do tempo. Sempre injetada. */
  readonly now: () => number;
  /** Onde os avisos vão. Injetável para os testes poderem inspecioná-los. */
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface JobBudget {
  /**
   * Teto de unidades de cota que este job pode gastar nesta invocação.
   * Ao esgotar, o job grava o progresso e devolve `exhausted: true`.
   */
  readonly quotaUnits: number;
  /** Teto de itens processados nesta invocação. Protege do `maxDuration`. */
  readonly maxItems: number;
}

export const DEFAULT_BUDGET: JobBudget = {
  quotaUnits: 500,
  maxItems: 50,
};

export interface JobReport {
  readonly job: string;
  /** Itens efetivamente processados nesta invocação. */
  readonly processed: number;
  /** `true` se o orçamento acabou antes do trabalho — a próxima invocação continua. */
  readonly exhausted: boolean;
  /** `true` se a volta terminou e a próxima invocação começa do início. */
  readonly completed: boolean;
  readonly quotaSpent: number;
  /** Erros por item, sem interromper o restante da fatia. */
  readonly errors: readonly { readonly item: string; readonly message: string }[];
  readonly details?: Readonly<Record<string, unknown>>;
}

export function emptyReport(job: string): JobReport {
  return {
    job,
    processed: 0,
    exhausted: false,
    completed: true,
    quotaSpent: 0,
    errors: [],
  };
}

/**
 * Acumulador de relatório.
 *
 * Erro em um item não derruba a fatia inteira: um canal apagado no YouTube não deve
 * impedir os outros 49 de serem atualizados. Os erros vão para o relatório e o job
 * segue — mas ficam visíveis, em vez de sumirem num `catch` vazio.
 */
export class ReportBuilder {
  #processed = 0;
  #quotaSpent = 0;
  #errors: { item: string; message: string }[] = [];
  #exhausted = false;
  #completed = false;

  constructor(readonly job: string) {}

  countItem(): void {
    this.#processed++;
  }

  addQuota(units: number): void {
    this.#quotaSpent += units;
  }

  get quotaSpent(): number {
    return this.#quotaSpent;
  }

  get processed(): number {
    return this.#processed;
  }

  fail(item: string, err: unknown): void {
    this.#errors.push({ item, message: err instanceof Error ? err.message : String(err) });
  }

  markExhausted(): void {
    this.#exhausted = true;
  }

  markCompleted(): void {
    this.#completed = true;
  }

  build(details?: Record<string, unknown>): JobReport {
    return {
      job: this.job,
      processed: this.#processed,
      exhausted: this.#exhausted,
      completed: this.#completed,
      quotaSpent: this.#quotaSpent,
      errors: [...this.#errors],
      ...(details ? { details } : {}),
    };
  }
}
