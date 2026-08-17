/**
 * Testes do cliente e da normalização, contra um transporte falso.
 *
 * Nada aqui toca a API real: bater nela em CI queimaria cota compartilhada e faria os
 * testes falharem por motivos alheios ao código.
 */

import { describe, expect, it, vi } from 'vitest';
import { chunk, MAX_IDS_PER_CALL, YouTubeApiError, YouTubeClient } from './client.js';
import { QuotaExhaustedError, QuotaLedger } from './quota.js';
import {
  normalizeChannel,
  normalizeVideo,
  pickThumbnail,
  playlistVideoIds,
  subscribedChannelIds,
  uploadsPlaylistIdFor,
} from './normalize.js';
import { NOW, rawChannel, rawPlaylistItem, rawSubscription, rawVideo } from './fixtures.js';
import type { Transport } from './client.js';

// ---------------------------------------------------------------------------
// Transporte falso
// ---------------------------------------------------------------------------

interface Recorded {
  readonly url: string;
  readonly params: URLSearchParams;
  readonly headers: Record<string, string>;
}

function fakeTransport(responses: unknown[]): { transport: Transport; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const transport: Transport = async (url, init) => {
    calls.push({
      url,
      params: new URL(url).searchParams,
      headers: init.headers,
    });
    const body = responses[i++] ?? { items: [] };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { transport, calls };
}

/**
 * Captura o erro de uma promessa como `YouTubeApiError`.
 *
 * Sem isto, `catch((e) => e)` faz o TypeScript inferir a união do valor de sucesso
 * com o erro, e cada acesso a `.status` precisa de asserção.
 */
async function captureApiError(promise: Promise<unknown>): Promise<YouTubeApiError> {
  try {
    await promise;
    throw new Error('esperava YouTubeApiError, mas a chamada teve sucesso');
  } catch (err) {
    if (err instanceof YouTubeApiError) return err;
    throw err;
  }
}

function errorTransport(status: number, body: unknown): Transport {
  return async () => ({
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function makeClient(responses: unknown[], limit = 10_000) {
  const { transport, calls } = fakeTransport(responses);
  const ledger = new QuotaLedger(NOW, limit);
  const client = new YouTubeClient({
    credentials: { apiKey: 'chave-de-teste' },
    ledger,
    transport,
    now: () => NOW,
  });
  return { client, calls, ledger };
}

// ---------------------------------------------------------------------------

describe('chunk', () => {
  it('divide em lotes do tamanho pedido', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('devolve vazio para entrada vazia', () => {
    expect(chunk([], 50)).toEqual([]);
  });

  it('recusa tamanho não positivo', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('uploadsPlaylistIdFor', () => {
  it('converte UC… em UU…, economizando um channels.list', () => {
    expect(uploadsPlaylistIdFor('UCuAXFkgsw1L7xaCfnd5JJOw')).toBe('UUuAXFkgsw1L7xaCfnd5JJOw');
  });

  it('devolve null para id que não segue a convenção', () => {
    expect(uploadsPlaylistIdFor('PL123')).toBeNull();
    expect(uploadsPlaylistIdFor('')).toBeNull();
  });
});

describe('pickThumbnail', () => {
  it('prefere a maior resolução disponível', () => {
    expect(pickThumbnail({ default: { url: 'd' }, high: { url: 'h' }, maxres: { url: 'm' } })).toBe(
      'm',
    );
    expect(pickThumbnail({ default: { url: 'd' }, medium: { url: 'me' } })).toBe('me');
  });

  it('devolve null quando não há miniatura', () => {
    expect(pickThumbnail(undefined)).toBeNull();
    expect(pickThumbnail({})).toBeNull();
  });
});

describe('normalizeVideo', () => {
  it('traduz os campos que a aplicação usa', () => {
    const rec = normalizeVideo(rawVideo(), NOW);
    expect(rec).toMatchObject({
      id: 'dQw4w9WgXcQ',
      ytChannelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
      durationSec: 600,
      categoryId: '20',
      embeddable: true,
      privacyStatus: 'public',
      uploadStatus: 'processed',
      liveState: 'none',
      refreshedAtMs: NOW,
    });
    expect(rec?.tags).toEqual(['minecraft', 'gameplay']);
  });

  it('devolve null sem id de vídeo ou de canal', () => {
    expect(normalizeVideo({ id: '', snippet: { channelId: 'UC1' } }, NOW)).toBeNull();
    expect(normalizeVideo({ id: 'v1', snippet: {} }, NOW)).toBeNull();
  });

  it('devolve null com data de publicação inválida', () => {
    expect(normalizeVideo(rawVideo({ publishedAt: 'não é data' }), NOW)).toBeNull();
  });

  it('converte PT0S de live em duração desconhecida', () => {
    const rec = normalizeVideo(rawVideo({ duration: 'PT0S', liveBroadcastContent: 'live' }), NOW);
    expect(rec?.durationSec).toBeNull();
    expect(rec?.liveState).toBe('live');
  });

  it('trata embeddable ausente como falso', () => {
    const raw = { ...rawVideo(), status: { privacyStatus: 'public', uploadStatus: 'processed' } };
    expect(normalizeVideo(raw, NOW)?.embeddable).toBe(false);
  });

  it('captura restrições regionais', () => {
    const rec = normalizeVideo(rawVideo({ blocked: ['BR'], allowed: ['US'] }), NOW);
    expect(rec?.blockedRegions).toEqual(['BR']);
    expect(rec?.allowedRegions).toEqual(['US']);
  });

  it('detecta classificação indicativa', () => {
    const semRating = normalizeVideo(rawVideo(), NOW);
    const comRating = normalizeVideo(
      rawVideo({ contentRating: { ytRating: 'ytAgeRestricted' } }),
      NOW,
    );
    expect(semRating?.hasContentRating).toBe(false);
    expect(comRating?.hasContentRating).toBe(true);
  });

  it('lê os horários da transmissão', () => {
    const rec = normalizeVideo(
      rawVideo({
        liveBroadcastContent: 'live',
        actualStartTime: '2026-08-17T14:00:00Z',
        scheduledStartTime: '2026-08-17T13:55:00Z',
      }),
      NOW,
    );
    expect(rec?.liveActualStartMs).toBe(Date.UTC(2026, 7, 17, 14, 0, 0));
    expect(rec?.liveScheduledStartMs).toBe(Date.UTC(2026, 7, 17, 13, 55, 0));
    expect(rec?.liveActualEndMs).toBeNull();
  });
});

describe('normalizeChannel', () => {
  it('extrai a playlist de uploads', () => {
    const rec = normalizeChannel(rawChannel('UCabc12345678901234567'), NOW);
    expect(rec?.uploadsPlaylistId).toBe('UUabc12345678901234567');
  });

  it('devolve null sem id', () => {
    expect(normalizeChannel({ id: '' }, NOW)).toBeNull();
  });
});

describe('extração de ids', () => {
  it('lê ids de canal das inscrições', () => {
    expect(subscribedChannelIds([rawSubscription('UC1'), rawSubscription('UC2')])).toEqual([
      'UC1',
      'UC2',
    ]);
  });

  it('ignora inscrição sem id de canal', () => {
    expect(subscribedChannelIds([{ snippet: {} }, rawSubscription('UC1')])).toEqual(['UC1']);
  });

  it('lê ids de vídeo de playlistItems por qualquer um dos dois campos', () => {
    const items = [
      rawPlaylistItem('vid1'),
      { snippet: { resourceId: { kind: 'youtube#video', videoId: 'vid2' } } },
      { snippet: {} },
    ];
    expect(playlistVideoIds(items)).toEqual(['vid1', 'vid2']);
  });
});

describe('YouTubeClient — cota', () => {
  it('debita cada chamada no livro-caixa', () => {
    const { client, ledger } = makeClient([{ items: [rawVideo()] }]);
    return client.listVideos(['dQw4w9WgXcQ']).then(() => {
      expect(ledger.snapshot(NOW).spent).toBe(1);
    });
  });

  it('debita 100 por busca', async () => {
    const { client, ledger } = makeClient([{ items: [{ id: { videoId: 'v1' } }] }]);
    await client.searchVideos('#minecraft');
    expect(ledger.snapshot(NOW).spent).toBe(100);
  });

  it('não faz a chamada quando a cota não cobre', async () => {
    const { client, calls } = makeClient([{ items: [] }], 50);
    await expect(client.searchVideos('#minecraft')).rejects.toThrow(QuotaExhaustedError);
    // O ponto: a rede nem foi tocada.
    expect(calls).toHaveLength(0);
  });

  it('debita uma unidade por página, não por item', async () => {
    // Três páginas de 50 inscrições = 150 canais por 3 unidades. É o que torna o
    // caminho barato viável: o custo acompanha as páginas, não o volume de dados.
    const page = (token?: string) => ({
      items: Array.from({ length: 50 }, (_, i) => rawSubscription(`UC${token ?? 'a'}${i}`)),
      ...(token ? { nextPageToken: token } : {}),
    });
    const { transport } = fakeTransport([page('p2'), page('p3'), page()]);
    const ledger = new QuotaLedger(NOW);
    const client = new YouTubeClient({
      credentials: { accessToken: 'token' },
      ledger,
      transport,
      now: () => NOW,
    });

    const ids = await client.listMySubscriptions();

    expect(ids).toHaveLength(150);
    expect(ledger.snapshot(NOW).spent).toBe(3);
  });
});

describe('YouTubeClient — paginação', () => {
  it('percorre todas as páginas e omite pageToken na primeira', async () => {
    const { transport, calls } = fakeTransport([
      { items: [rawPlaylistItem('v1')], nextPageToken: 'p2' },
      { items: [rawPlaylistItem('v2')], nextPageToken: 'p3' },
      { items: [rawPlaylistItem('v3')] },
    ]);
    const client = new YouTubeClient({
      credentials: { apiKey: 'k' },
      ledger: new QuotaLedger(NOW),
      transport,
      now: () => NOW,
    });

    const ids = await client.listUploadIds('UU1');

    expect(ids).toEqual(['v1', 'v2', 'v3']);
    expect(calls).toHaveLength(3);
    /*
     * Mandar pageToken vazio na primeira chamada devolve `invalidPageToken` — uma
     * armadilha bem documentada por quem já implementou paginação nesta API.
     */
    expect(calls[0]!.params.has('pageToken')).toBe(false);
    expect(calls[1]!.params.get('pageToken')).toBe('p2');
    expect(calls[2]!.params.get('pageToken')).toBe('p3');
  });

  it('respeita maxItems e para de paginar', async () => {
    const { transport, calls } = fakeTransport([
      { items: [rawPlaylistItem('v1'), rawPlaylistItem('v2')], nextPageToken: 'p2' },
      { items: [rawPlaylistItem('v3')] },
    ]);
    const client = new YouTubeClient({
      credentials: { apiKey: 'k' },
      ledger: new QuotaLedger(NOW),
      transport,
      now: () => NOW,
    });

    const ids = await client.listUploadIds('UU1', { maxItems: 2 });
    expect(ids).toEqual(['v1', 'v2']);
    expect(calls).toHaveLength(1);
  });

  it('lida com resposta sem items', async () => {
    const { client } = makeClient([{}]);
    expect(await client.listUploadIds('UU1')).toEqual([]);
  });
});

describe('YouTubeClient — lotes de ids', () => {
  it('divide videos.list em lotes de 50', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
    const { transport, calls } = fakeTransport([
      { items: [rawVideo({ id: 'v0' })] },
      { items: [rawVideo({ id: 'v50' })] },
      { items: [rawVideo({ id: 'v100' })] },
    ]);
    const ledger = new QuotaLedger(NOW);
    const client = new YouTubeClient({
      credentials: { apiKey: 'k' },
      ledger,
      transport,
      now: () => NOW,
    });

    await client.listVideos(ids);

    expect(calls).toHaveLength(3);
    expect(calls[0]!.params.get('id')!.split(',')).toHaveLength(MAX_IDS_PER_CALL);
    expect(calls[2]!.params.get('id')!.split(',')).toHaveLength(20);
    expect(ledger.snapshot(NOW).spent).toBe(3);
  });

  it('pede exatamente as part necessárias para R13 e para lives', async () => {
    const { client, calls } = makeClient([{ items: [] }]);
    await client.listVideos(['v1']);

    const part = calls[0]!.params.get('part')!;
    // `status` para embeddable/privacyStatus, `contentDetails` para duração e região.
    expect(part).toContain('status');
    expect(part).toContain('contentDetails');
    expect(part).toContain('liveStreamingDetails');
  });
});

describe('YouTubeClient — autenticação', () => {
  it('usa a chave de API quando não há token', async () => {
    const { client, calls } = makeClient([{ items: [] }]);
    await client.listVideos(['v1']);
    expect(calls[0]!.params.get('key')).toBe('chave-de-teste');
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('usa o token OAuth quando disponível, e não a chave', async () => {
    const { transport, calls } = fakeTransport([{ items: [] }]);
    const client = new YouTubeClient({
      credentials: { apiKey: 'k', accessToken: 'token-abc' },
      ledger: new QuotaLedger(NOW),
      transport,
      now: () => NOW,
    });
    await client.listVideos(['v1']);

    expect(calls[0]!.headers['authorization']).toBe('Bearer token-abc');
    expect(calls[0]!.params.has('key')).toBe(false);
  });

  it('recusa mine=true sem token OAuth', async () => {
    const { client } = makeClient([{ items: [] }]);
    await expect(client.listMySubscriptions()).rejects.toThrow(/OAuth/);
  });

  it('lista inscrições com token', async () => {
    const { transport } = fakeTransport([
      { items: [rawSubscription('UC1'), rawSubscription('UC2')] },
    ]);
    const client = new YouTubeClient({
      credentials: { accessToken: 'token' },
      ledger: new QuotaLedger(NOW),
      transport,
      now: () => NOW,
    });
    expect(await client.listMySubscriptions()).toEqual(['UC1', 'UC2']);
  });
});

describe('YouTubeClient — erros da API', () => {
  it('embrulha HTTP de erro em YouTubeApiError com o motivo', async () => {
    const client = new YouTubeClient({
      credentials: { apiKey: 'k' },
      ledger: new QuotaLedger(NOW),
      transport: errorTransport(403, {
        error: { errors: [{ reason: 'quotaExceeded' }], message: 'sem cota' },
      }),
      now: () => NOW,
    });

    await expect(client.listVideos(['v1'])).rejects.toThrow(YouTubeApiError);
    const err = await captureApiError(client.listVideos(['v1']));
    expect(err.status).toBe(403);
    expect(err.reason).toBe('quotaExceeded');
    expect(err.isQuotaError).toBe(true);
    expect(err.method).toBe('videos.list');
  });

  it('distingue erro de cota de outros 403', async () => {
    const client = new YouTubeClient({
      credentials: { apiKey: 'k' },
      ledger: new QuotaLedger(NOW),
      transport: errorTransport(403, { error: { errors: [{ reason: 'forbidden' }] } }),
      now: () => NOW,
    });
    const err = await captureApiError(client.listVideos(['v1']));
    expect(err.isQuotaError).toBe(false);
  });

  it('tolera corpo de erro que não é JSON', async () => {
    const client = new YouTubeClient({
      credentials: { apiKey: 'k' },
      ledger: new QuotaLedger(NOW),
      transport: async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '<html>erro do gateway</html>',
      }),
      now: () => NOW,
    });
    const err = await captureApiError(client.listVideos(['v1']));
    expect(err.status).toBe(500);
    expect(err.reason).toBe('');
  });
});

describe('YouTubeClient — categorias', () => {
  it('devolve só as categorias atribuíveis', async () => {
    const { client } = makeClient([
      {
        items: [
          { id: '20', snippet: { title: 'Gaming', assignable: true } },
          { id: '18', snippet: { title: 'Short Movies', assignable: false } },
          { id: '10', snippet: { title: 'Music', assignable: true } },
        ],
      },
    ]);
    // Categorias não atribuíveis não aparecem em vídeo nenhum e virariam canal vazio.
    expect(await client.listVideoCategories('BR')).toEqual([
      { id: '20', title: 'Gaming' },
      { id: '10', title: 'Music' },
    ]);
  });

  it('passa o regionCode', async () => {
    const { client, calls } = makeClient([{ items: [] }]);
    await client.listVideoCategories('BR');
    expect(calls[0]!.params.get('regionCode')).toBe('BR');
  });
});

describe('YouTubeClient — busca', () => {
  it('limita maxResults ao teto da API', async () => {
    const { client, calls } = makeClient([{ items: [] }]);
    await client.searchVideos('#minecraft', { maxResults: 500 });
    expect(calls[0]!.params.get('maxResults')).toBe('50');
  });

  it('devolve os ids encontrados', async () => {
    const { client } = makeClient([
      { items: [{ id: { videoId: 'a' } }, { id: {} }, { id: { videoId: 'b' } }] },
    ]);
    expect(await client.searchVideos('#minecraft')).toEqual(['a', 'b']);
  });
});

describe('transporte padrão', () => {
  it('usa fetch quando nenhum transporte é injetado', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    new YouTubeClient({ credentials: { apiKey: 'k' }, ledger: new QuotaLedger(NOW) });
    // Só a construção não deve chamar a rede.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
