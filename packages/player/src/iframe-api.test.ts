/**
 * Testes do carregador do IFrame API, contra um DOM mínimo montado à mão.
 *
 * Um DOM falso em vez de jsdom: só precisamos de `createElement`, `head.appendChild` e
 * `defaultView`, e um duplo de 20 linhas deixa explícito o que o carregador realmente
 * exige do ambiente.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  channelPlayerVars,
  loadIframeApi,
  PlayerState,
  resetIframeApiLoader,
} from './iframe-api.js';
import type { YtNamespace } from './iframe-api.js';

interface FakeScript {
  src: string;
  async: boolean;
  onerror: (() => void) | null;
}

function fakeDom() {
  const scripts: FakeScript[] = [];
  const win: {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  } = {};

  const doc = {
    defaultView: win,
    createElement: () => {
      const el: FakeScript = { src: '', async: false, onerror: null };
      return el as unknown as HTMLScriptElement;
    },
    head: {
      appendChild: (el: unknown) => {
        scripts.push(el as FakeScript);
        return el;
      },
    },
  } as unknown as Document;

  /** Simula o script do YouTube terminando de carregar. */
  const finishLoading = (): void => {
    win.YT = {
      Player: class {} as unknown as YtNamespace['Player'],
      PlayerState,
    };
    win.onYouTubeIframeAPIReady?.();
  };

  return { doc, win, scripts, finishLoading };
}

beforeEach(() => {
  resetIframeApiLoader();
});

describe('loadIframeApi', () => {
  it('injeta o script e resolve quando o YouTube avisa que está pronto', async () => {
    const { doc, scripts, finishLoading } = fakeDom();

    const promise = loadIframeApi(doc);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.src).toBe('https://www.youtube.com/iframe_api');
    expect(scripts[0]!.async).toBe(true);

    finishLoading();
    await expect(promise).resolves.toHaveProperty('Player');
  });

  it('resolve na hora se o YT já estiver na página', async () => {
    const { doc, win } = fakeDom();
    win.YT = { Player: class {} as unknown as YtNamespace['Player'], PlayerState };

    await expect(loadIframeApi(doc)).resolves.toBe(win.YT);
  });

  it('injeta o script uma única vez, mesmo com chamadas concorrentes', async () => {
    /*
     * `onYouTubeIframeAPIReady` é um callback global de uso exclusivo do YouTube e só
     * pode ser definido uma vez por página. Sem a memoização, cada montagem de player
     * sobrescreveria o callback da anterior e alguma promessa nunca resolveria.
     */
    const { doc, scripts, finishLoading } = fakeDom();

    const a = loadIframeApi(doc);
    const b = loadIframeApi(doc);
    finishLoading();

    await Promise.all([a, b]);
    expect(scripts).toHaveLength(1);
    expect(a).toBe(b);
  });

  it('rejeita quando o script falha em carregar', async () => {
    const { doc, scripts } = fakeDom();
    const promise = loadIframeApi(doc);

    scripts[0]!.onerror?.();

    await expect(promise).rejects.toThrow(/falha ao carregar/);
  });

  it('rejeita se o script carregar sem expor YT.Player', async () => {
    const { doc, win } = fakeDom();
    const promise = loadIframeApi(doc);

    win.onYouTubeIframeAPIReady?.();

    await expect(promise).rejects.toThrow(/sem expor/);
  });

  it('rejeita documento sem window', async () => {
    const doc = { defaultView: null } as unknown as Document;
    await expect(loadIframeApi(doc)).rejects.toThrow(/sem window/);
  });
});

describe('channelPlayerVars', () => {
  it('mantém os controles visíveis, como os termos exigem', () => {
    // Alterar o player além do que a documentação descreve é proibido (R5/R9).
    expect(channelPlayerVars().controls).toBe(1);
  });

  it('liga playsinline para o vídeo não abrir em tela cheia no iOS', () => {
    // Sem isto o iOS assume o player nativo e a metáfora de TV se perde.
    expect(channelPlayerVars().playsinline).toBe(1);
  });

  it('liga autoplay e a API JS', () => {
    const vars = channelPlayerVars();
    expect(vars.autoplay).toBe(1);
    expect(vars.enablejsapi).toBe(1);
  });

  it('inclui origin quando informado', () => {
    expect(channelPlayerVars('https://app.minhatv.example').origin).toBe(
      'https://app.minhatv.example',
    );
    expect(channelPlayerVars().origin).toBeUndefined();
  });

  it('não passa parâmetros descontinuados', () => {
    /*
     * `modestbranding`, `showinfo`, `autohide` e `theme` foram descontinuados e não
     * fazem nada. Passá-los criaria a falsa impressão de que a marca do YouTube está
     * sendo escondida — o que, além de não funcionar, seria proibido (R9).
     */
    const vars = channelPlayerVars() as Record<string, unknown>;
    for (const morto of ['modestbranding', 'showinfo', 'autohide', 'theme']) {
      expect(vars[morto]).toBeUndefined();
    }
  });
});

describe('PlayerState', () => {
  it('espelha os códigos do IFrame API', () => {
    expect(PlayerState).toEqual({
      UNSTARTED: -1,
      ENDED: 0,
      PLAYING: 1,
      PAUSED: 2,
      BUFFERING: 3,
      CUED: 5,
    });
  });
});
