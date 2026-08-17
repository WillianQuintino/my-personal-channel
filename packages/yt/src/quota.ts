/**
 * Contabilidade de cota (R2).
 *
 * A cota padrão é de 10.000 unidades por dia e `search.list` sozinho custa 100 —
 * cem buscas queimam o dia inteiro. Por isso toda chamada passa por aqui e é
 * debitada antes de sair: quando o orçamento acaba, a camada de dados serve cache
 * com aviso, em vez de deixar a API devolver `quotaExceeded` cru na cara do usuário.
 */

import { localDayKey } from '@minhatv/core';

/**
 * A cota do YouTube zera à meia-noite do Pacífico, não no fuso do usuário.
 * Contabilizar no fuso errado faz o orçamento parecer disponível quando não está.
 */
export const QUOTA_RESET_TZ = 'America/Los_Angeles';

export const DEFAULT_DAILY_QUOTA = 10_000;

/** Custo em unidades de cada método. Os valores são fixados pela API, não estimados. */
export const QUOTA_COST = {
  'channels.list': 1,
  'playlistItems.list': 1,
  'playlists.list': 1,
  'subscriptions.list': 1,
  'videoCategories.list': 1,
  'videos.list': 1,
  /** Cem vezes mais caro que qualquer alternativa. Só sob ação explícita do usuário. */
  'search.list': 100,
} as const;

export type QuotaMethod = keyof typeof QUOTA_COST;

/** Dia de cota (`YYYY-MM-DD` no fuso do Pacífico) a que um instante pertence. */
export function quotaDayKey(nowMs: number): string {
  return localDayKey(nowMs, QUOTA_RESET_TZ);
}

export class QuotaExhaustedError extends Error {
  constructor(
    readonly method: QuotaMethod,
    readonly cost: number,
    readonly remaining: number,
  ) {
    super(`cota diária esgotada: ${method} custa ${cost} unidades, restam ${remaining}`);
    this.name = 'QuotaExhaustedError';
  }
}

export interface QuotaSnapshot {
  readonly dayKey: string;
  readonly spent: number;
  readonly limit: number;
  readonly remaining: number;
  readonly byMethod: Readonly<Record<string, number>>;
}

/**
 * Livro-caixa de cota, em memória, com reset automático na virada do dia do Pacífico.
 *
 * A persistência fica por fora (tabela `quota_ledger`): esta classe é a parte pura e
 * testável, e recebe o "agora" por parâmetro como todo o resto do projeto.
 */
export class QuotaLedger {
  #dayKey: string;
  #spent = 0;
  #byMethod = new Map<string, number>();

  constructor(
    nowMs: number,
    readonly limit: number = DEFAULT_DAILY_QUOTA,
    /**
     * Fração do orçamento reservada para chamadas interativas do usuário.
     * Os jobs de fundo param nesta linha para não deixar a interface sem cota.
     */
    readonly backgroundReserveRatio = 0.2,
  ) {
    this.#dayKey = quotaDayKey(nowMs);
  }

  #rollOver(nowMs: number): void {
    const key = quotaDayKey(nowMs);
    if (key !== this.#dayKey) {
      this.#dayKey = key;
      this.#spent = 0;
      this.#byMethod.clear();
    }
  }

  snapshot(nowMs: number): QuotaSnapshot {
    this.#rollOver(nowMs);
    return {
      dayKey: this.#dayKey,
      spent: this.#spent,
      limit: this.limit,
      remaining: Math.max(0, this.limit - this.#spent),
      byMethod: Object.fromEntries(this.#byMethod),
    };
  }

  /** Orçamento disponível para jobs de fundo, já descontada a reserva interativa. */
  backgroundRemaining(nowMs: number): number {
    this.#rollOver(nowMs);
    const usable = this.limit * (1 - this.backgroundReserveRatio);
    return Math.max(0, Math.floor(usable - this.#spent));
  }

  canAfford(method: QuotaMethod, nowMs: number, background = false): boolean {
    this.#rollOver(nowMs);
    const cost = QUOTA_COST[method];
    return background ? this.backgroundRemaining(nowMs) >= cost : this.limit - this.#spent >= cost;
  }

  /** Debita e devolve o custo. Lança `QuotaExhaustedError` se não couber. */
  charge(method: QuotaMethod, nowMs: number, background = false): number {
    this.#rollOver(nowMs);
    const cost = QUOTA_COST[method];
    const remaining = background ? this.backgroundRemaining(nowMs) : this.limit - this.#spent;

    if (remaining < cost) {
      throw new QuotaExhaustedError(method, cost, Math.max(0, remaining));
    }

    this.#spent += cost;
    this.#byMethod.set(method, (this.#byMethod.get(method) ?? 0) + cost);
    return cost;
  }
}

/**
 * Custo estimado de percorrer `total` itens em páginas de `pageSize`.
 * Serve para o planejador de refresh decidir o que cabe no orçamento antes de começar.
 */
export function estimatePagedCost(method: QuotaMethod, total: number, pageSize = 50): number {
  if (total <= 0) return 0;
  return Math.ceil(total / pageSize) * QUOTA_COST[method];
}

/**
 * Orçamento do caminho barato de montagem de pool, por canal do YouTube:
 * `playlistItems.list` para listar os uploads + `videos.list` para os metadados.
 *
 * Existe para tornar explícito o motivo de nunca usarmos `search.list` aqui: com
 * 200 canais × 50 vídeos o caminho barato custa ~400 unidades, enquanto uma busca
 * por canal custaria 20.000 — o dobro da cota diária inteira.
 */
export function estimatePoolRefreshCost(channels: number, videosPerChannel: number): number {
  const listing = estimatePagedCost('playlistItems.list', videosPerChannel) * channels;
  const details = estimatePagedCost('videos.list', channels * videosPerChannel);
  return listing + details;
}
