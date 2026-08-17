/**
 * Tipos e carregamento do IFrame Player API.
 *
 * O player embutido é a **única** forma de reprodução compatível com os termos da API
 * do YouTube: não há como baixar, transcodificar ou servir o vídeo por conta própria.
 * Daí toda a arquitetura de "TV" ser simulada no cliente, com relógio e `startSeconds`.
 */

/** Estados de `onStateChange`, conforme a documentação do IFrame API. */
export const PlayerState = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

export type PlayerStateValue = (typeof PlayerState)[keyof typeof PlayerState];

export interface YtPlayer {
  loadVideoById(args: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  cueVideoById(args: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): PlayerStateValue;
  getVideoUrl(): string;
  destroy(): void;
}

export interface YtPlayerEvent {
  readonly target: YtPlayer;
  readonly data?: number;
}

export interface YtPlayerVars {
  readonly autoplay?: 0 | 1;
  readonly controls?: 0 | 1;
  readonly playsinline?: 0 | 1;
  readonly rel?: 0 | 1;
  readonly cc_load_policy?: 0 | 1;
  readonly start?: number;
  readonly origin?: string;
  readonly enablejsapi?: 0 | 1;
}

export interface YtPlayerOptions {
  readonly videoId?: string;
  readonly width?: string | number;
  readonly height?: string | number;
  readonly playerVars?: YtPlayerVars;
  readonly events?: {
    onReady?: (e: YtPlayerEvent) => void;
    onStateChange?: (e: YtPlayerEvent) => void;
    onError?: (e: YtPlayerEvent) => void;
  };
}

export interface YtNamespace {
  Player: new (element: HTMLElement | string, options: YtPlayerOptions) => YtPlayer;
  PlayerState: typeof PlayerState;
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';

let loadPromise: Promise<YtNamespace> | null = null;

/**
 * Carrega o IFrame API uma única vez e resolve quando `window.YT` estiver pronto.
 *
 * O callback global `onYouTubeIframeAPIReady` é de uso exclusivo do YouTube e só pode
 * ser definido uma vez por página — por isso a promessa é memoizada em vez de o script
 * ser injetado a cada montagem do player.
 */
export function loadIframeApi(doc: Document = document): Promise<YtNamespace> {
  if (doc.defaultView?.YT?.Player) {
    return Promise.resolve(doc.defaultView.YT);
  }
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<YtNamespace>((resolve, reject) => {
    const win = doc.defaultView;
    if (!win) {
      reject(new Error('sem window: o IFrame API precisa de um documento com view'));
      return;
    }

    win.onYouTubeIframeAPIReady = () => {
      const yt = win.YT;
      if (yt?.Player) resolve(yt);
      else reject(new Error('IFrame API carregou sem expor YT.Player'));
    };

    const script = doc.createElement('script');
    script.src = IFRAME_API_SRC;
    script.async = true;
    script.onerror = () => reject(new Error('falha ao carregar o IFrame Player API'));
    doc.head.appendChild(script);
  });

  return loadPromise;
}

/** Zera a memoização. Só para testes. */
export function resetIframeApiLoader(): void {
  loadPromise = null;
}

/**
 * Parâmetros do player usados pelo produto.
 *
 * `controls: 1` e nenhuma tentativa de esconder a marca do YouTube são exigências dos
 * termos (R5/R9): alterar o player além do que a documentação descreve é proibido.
 * `modestbranding`, `showinfo`, `autohide` e `theme` foram descontinuados e não
 * fazem nada — passá-los só cria falsa impressão de controle.
 */
export function channelPlayerVars(origin?: string): YtPlayerVars {
  return {
    autoplay: 1,
    controls: 1,
    // Sem isto o iOS abre o vídeo em tela cheia nativa e a metáfora de TV se perde.
    playsinline: 1,
    rel: 0,
    enablejsapi: 1,
    ...(origin ? { origin } : {}),
  };
}
