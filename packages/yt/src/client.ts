/**
 * Cliente da YouTube Data API v3.
 *
 * O transporte é injetável para que os testes rodem contra fixtures gravadas e nunca
 * toquem na API real — bater na API em CI queimaria cota compartilhada e faria os
 * testes falharem por motivos alheios ao código.
 *
 * Toda chamada passa pelo `QuotaLedger` antes de sair (R2).
 */

import type { QuotaLedger } from './quota.js';
import { type QuotaMethod } from './quota.js';
import {
  normalizeChannel,
  normalizeVideo,
  playlistVideoIds,
  subscribedChannelIds,
} from './normalize.js';
import type { ChannelRecord } from './normalize.js';
import type {
  ListResponse,
  RawChannel,
  RawPlaylistItem,
  RawSubscription,
  RawVideo,
  RawVideoCategory,
  VideoRecord,
} from './types.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

/** Máximo de ids por chamada de `videos.list`/`channels.list`. Fixado pela API. */
export const MAX_IDS_PER_CALL = 50;
/** Máximo de itens por página. Fixado pela API. */
export const MAX_PAGE_SIZE = 50;

export interface Transport {
  (
    url: string,
    init: { readonly headers: Record<string, string> },
  ): Promise<{
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export interface Credentials {
  /** Chave de API, para leituras públicas. */
  readonly apiKey?: string;
  /** Token OAuth do usuário, necessário para `mine=true`. */
  readonly accessToken?: string;
}

export class YouTubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly method: QuotaMethod,
    message: string,
  ) {
    super(message);
    this.name = 'YouTubeApiError';
  }

  /** `true` quando a API recusou por cota, e não por erro do pedido. */
  get isQuotaError(): boolean {
    return this.status === 403 && /quota/i.test(this.reason);
  }
}

export interface ClientOptions {
  readonly credentials: Credentials;
  readonly ledger: QuotaLedger;
  readonly transport?: Transport;
  /** Fonte do tempo. Injetável para testes; em produção é `Date.now`. */
  readonly now?: () => number;
}

interface CallOptions {
  readonly background?: boolean;
  readonly requiresAuth?: boolean;
}

export class YouTubeClient {
  readonly #creds: Credentials;
  readonly #ledger: QuotaLedger;
  readonly #transport: Transport;
  readonly #now: () => number;

  constructor(opts: ClientOptions) {
    this.#creds = opts.credentials;
    this.#ledger = opts.ledger;
    this.#transport = opts.transport ?? ((url, init) => fetch(url, init));
    this.#now = opts.now ?? (() => Date.now());
  }

  get ledger(): QuotaLedger {
    return this.#ledger;
  }

  async #call<T>(
    method: QuotaMethod,
    path: string,
    params: Record<string, string | undefined>,
    opts: CallOptions = {},
  ): Promise<T> {
    const nowMs = this.#now();
    // Debita antes de sair: se a cota não cobre, nem tentamos a chamada.
    this.#ledger.charge(method, nowMs, opts.background ?? false);

    const url = new URL(`${API_BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.#creds.accessToken) {
      headers['authorization'] = `Bearer ${this.#creds.accessToken}`;
    } else if (opts.requiresAuth) {
      throw new Error(`${method} exige token OAuth do usuário`);
    }
    if (this.#creds.apiKey && !this.#creds.accessToken) {
      url.searchParams.set('key', this.#creds.apiKey);
    }

    const res = await this.#transport(url.toString(), { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new YouTubeApiError(
        res.status,
        extractReason(body),
        method,
        `${method} falhou com HTTP ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }

  /**
   * Percorre todas as páginas de um endpoint paginado.
   *
   * O `pageToken` da primeira chamada é omitido — mandar string vazia devolve
   * `invalidPageToken`, uma armadilha bem documentada por quem já implementou isso.
   */
  async #paginate<TItem>(
    method: QuotaMethod,
    path: string,
    params: Record<string, string | undefined>,
    opts: CallOptions & { readonly maxItems?: number } = {},
  ): Promise<TItem[]> {
    const out: TItem[] = [];
    let pageToken: string | undefined;

    do {
      const page = await this.#call<ListResponse<TItem>>(
        method,
        path,
        pageToken ? { ...params, pageToken } : params,
        opts,
      );
      out.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
      if (opts.maxItems !== undefined && out.length >= opts.maxItems) {
        return out.slice(0, opts.maxItems);
      }
    } while (pageToken);

    return out;
  }

  /** Inscrições do usuário autenticado. 1 unidade por página de 50. */
  async listMySubscriptions(opts: { readonly maxItems?: number } = {}): Promise<string[]> {
    const items = await this.#paginate<RawSubscription>(
      'subscriptions.list',
      'subscriptions',
      { part: 'snippet', mine: 'true', maxResults: String(MAX_PAGE_SIZE) },
      { requiresAuth: true, ...opts },
    );
    return subscribedChannelIds(items);
  }

  /** Metadados de canais em lotes de 50. 1 unidade por lote. */
  async listChannels(ytChannelIds: readonly string[]): Promise<ChannelRecord[]> {
    const nowMs = this.#now();
    const out: ChannelRecord[] = [];

    for (const batch of chunk(ytChannelIds, MAX_IDS_PER_CALL)) {
      const page = await this.#call<ListResponse<RawChannel>>('channels.list', 'channels', {
        part: 'snippet,contentDetails',
        id: batch.join(','),
        maxResults: String(MAX_PAGE_SIZE),
      });
      for (const raw of page.items ?? []) {
        const rec = normalizeChannel(raw, nowMs);
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  /**
   * Ids de vídeo da playlist de uploads de um canal, do mais recente para o mais antigo.
   * 1 unidade por página de 50 — é este o caminho barato que substitui `search.list`.
   */
  async listUploadIds(
    uploadsPlaylistId: string,
    opts: { readonly maxItems?: number; readonly background?: boolean } = {},
  ): Promise<string[]> {
    const items = await this.#paginate<RawPlaylistItem>(
      'playlistItems.list',
      'playlistItems',
      {
        part: 'contentDetails',
        playlistId: uploadsPlaylistId,
        maxResults: String(MAX_PAGE_SIZE),
      },
      opts,
    );
    return playlistVideoIds(items);
  }

  /**
   * Metadados completos de vídeos, em lotes de 50. 1 unidade por lote.
   *
   * As `part` pedidas são exatamente as necessárias para R13 (`status` para
   * `embeddable`/`privacyStatus`, `contentDetails` para duração e restrição regional)
   * e para a detecção de live.
   */
  async listVideos(
    videoIds: readonly string[],
    opts: { readonly background?: boolean } = {},
  ): Promise<VideoRecord[]> {
    const nowMs = this.#now();
    const out: VideoRecord[] = [];

    for (const batch of chunk(videoIds, MAX_IDS_PER_CALL)) {
      const page = await this.#call<ListResponse<RawVideo>>(
        'videos.list',
        'videos',
        {
          part: 'snippet,contentDetails,status,liveStreamingDetails',
          id: batch.join(','),
          maxResults: String(MAX_PAGE_SIZE),
        },
        opts,
      );
      for (const raw of page.items ?? []) {
        const rec = normalizeVideo(raw, nowMs);
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  /** Categorias atribuíveis de uma região. 1 unidade. */
  async listVideoCategories(
    regionCode: string,
  ): Promise<{ readonly id: string; readonly title: string }[]> {
    const page = await this.#call<ListResponse<RawVideoCategory>>(
      'videoCategories.list',
      'videoCategories',
      { part: 'snippet', regionCode },
    );
    return (
      (page.items ?? [])
        // Só as atribuíveis: as demais não aparecem em vídeo nenhum e virariam canal vazio.
        .filter((c) => c.snippet?.assignable === true)
        .map((c) => ({ id: c.id, title: c.snippet?.title ?? c.id }))
    );
  }

  /**
   * Busca por texto/hashtag. **100 unidades por chamada.**
   *
   * Só deve ser chamada em resposta a uma ação explícita do usuário, nunca em job de
   * fundo: cem chamadas esgotam a cota diária inteira. O parâmetro `background` é
   * recusado de propósito.
   */
  async searchVideos(
    query: string,
    opts: { readonly maxResults?: number; readonly regionCode?: string } = {},
  ): Promise<string[]> {
    const page = await this.#call<ListResponse<{ readonly id?: { readonly videoId?: string } }>>(
      'search.list',
      'search',
      {
        part: 'id',
        q: query,
        type: 'video',
        maxResults: String(Math.min(opts.maxResults ?? 25, MAX_PAGE_SIZE)),
        regionCode: opts.regionCode,
      },
      { background: false },
    );
    const ids: string[] = [];
    for (const item of page.items ?? []) {
      if (item.id?.videoId) ids.push(item.id.videoId);
    }
    return ids;
  }
}

function extractReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { errors?: { reason?: string }[]; message?: string };
    };
    return parsed.error?.errors?.[0]?.reason ?? parsed.error?.message ?? '';
  } catch {
    return '';
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('tamanho de lote tem de ser positivo');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
