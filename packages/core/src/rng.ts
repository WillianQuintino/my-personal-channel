/**
 * PRNG determinístico. A grade tem de ser reproduzível em qualquer dispositivo
 * a partir de `(tvChannelId, dayKey)`, então `Math.random()` está fora de questão.
 */

/** FNV-1a 32 bits. Estável entre plataformas e rápido o suficiente. */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // multiplicação por 16777619 em aritmética de 32 bits sem estourar precisão
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: gerador de 32 bits, pequeno e de qualidade suficiente para embaralhar grade. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Seed da grade base de um canal em um dia. */
export function gridSeed(tvChannelId: string, dayKey: string): number {
  return hashSeed(`${tvChannelId}:${dayKey}`);
}

/**
 * Jitter estável **por vídeo**, não por posição de iteração.
 *
 * Derivar do id do vídeo (e não de chamadas sequenciais do rng) é o que garante
 * que inserir ou remover um vídeo do pool não reembaralhe todos os outros —
 * requisito direto do re-fluxo da §2b.
 */
export function stableJitter(seed: number, videoId: string, amplitude: number): number {
  const rng = mulberry32(seed ^ hashSeed(videoId));
  return 1 + (rng() * 2 - 1) * amplitude;
}
