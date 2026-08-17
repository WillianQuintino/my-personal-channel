# MinhaTV

Transforma os canais do YouTube que você acompanha em **canais de TV lineares
contínuos** — no estilo da TV aberta antiga. Você liga a TV, cai no meio de um vídeo
que já estava rolando, e o conteúdo emenda sozinho. Web (PWA) e Android.

Dois modos de conteúdo por canal: **lives**, **vídeos (VOD)** ou **ambos**. Canais
podem reunir todas as inscrições, os canais que você mais assiste, uma categoria do
YouTube, ou uma hashtag (`#minecraft`).

## Duas regras de programação

O que dá a sensação de TV, e não de playlist:

- **R-A — mais recente antes do mais antigo.** A grade desce a linha do tempo. Vídeo
  novo passa antes do de semana passada. A recência é medida em janelas de 6h
  (configurável); dentro de uma janela, afinidade e jitter variam a ordem entre dias.
- **R-B — um canal do YouTube por dia.** Um dia de programação são criadores
  distintos, para o canal "tudo" não virar maratona de um só. Quando o pool é estreito
  demais para isso, o relaxamento desce em cascata (distância ≥6 slots → ≥2 → qualquer)
  e o slot registra até onde relaxou, para a interface poder avisar.

## Inserção a quente

Vídeo novo e relevante entra na programação do **próprio dia** e reajusta o resto.
Três zonas protegem quem está assistindo:

| Zona          | Alcance                     | Comportamento                           |
| ------------- | --------------------------- | --------------------------------------- |
| **Ao ar**     | slot atual                  | Imutável. Nunca é trocado nem cortado   |
| **Congelada** | próximos 10 min (ajustável) | Imutável. É a promessa que o EPG já fez |
| **Cauda**     | resto do dia                | Re-fluível a qualquer momento           |

Só entra a quente conteúdo de canal no top-20 de afinidade, de canal favorito, ou
live começando agora — senão todo upload de todo canal viraria uma reordenação e a
grade nunca assentaria. Limites anti-turbulência: no máximo 6 inserções por dia e
20 min entre elas.

## Determinismo

A grade materializada é sempre `base(seed) + patches em ordem de seqNo`, com
`seed = hash(tvChannelId + diaLocal)`. Um dispositivo que ficou offline reconstrói a
programação exata ao reconectar aplicando só os patches que perdeu — sem isso, dois
dispositivos divergiriam em silêncio, um defeito quase impossível de diagnosticar.

Por isso `packages/core` é livre de I/O e o tempo entra sempre por parâmetro: nada de
`Date.now()` nem `Math.random()` dentro do motor.

## Estrutura

```
packages/core/    Motor de grade/EPG — TypeScript puro, sem I/O, 145 testes
packages/yt/      Cliente da Data API v3 com contabilidade de quota      (a fazer)
packages/db/      Drizzle ORM + migrations                               (a fazer)
apps/web/         Next.js + PWA, player IFrame                           (a fazer)
apps/mobile/      Capacitor envolvendo o build web (Android)             (a fazer)
apps/worker/      Cron: refresh de pools, detecção de live, purga de 30d  (a fazer)
```

## Desenvolvimento

```bash
pnpm install
pnpm test          # suíte completa
pnpm test:watch
pnpm typecheck
pnpm lint
pnpm format
```

Requer Node 22+ e pnpm 10+.

## Antes de rodar com dados reais

Este projeto usa a YouTube Data API v3 e está sujeito aos termos dela. Pontos que
mudam o que é possível fazer — os detalhes e o checklist completo estão em
[`COMPLIANCE.md`](./COMPLIANCE.md):

- **Histórico de exibição não é acessível pela API.** As playlists `watchHistory` e
  `watchLater` foram depreciadas em 2016 e retornam listas vazias. O ranking de "mais
  assistidos" vem de import do Google Takeout, das inscrições e do tracking interno.
- **Sem app de Android TV.** A Embedding Restriction limita o player embutido a
  páginas web e apps mobile/web não-embutidos; TV conectada fica fora, e a Play Store
  reprova apps de TV com conteúdo de terceiros embutido. Para assistir na TV, abra a
  web app no navegador da smart TV ou espelhe a tela.
- **Cache de metadados tem validade de 30 dias**, por exigência das Developer Policies.
- **`youtube.readonly` é escopo sensível.** Sem passar pela verificação OAuth do
  Google, o app fica limitado a 100 usuários no total e o consentimento expira em
  7 dias — suficiente para uso pessoal, insuficiente para distribuição pública.
- **Cota diária de 10.000 unidades.** Um `search.list` custa 100; o caminho
  `subscriptions → uploads playlist → playlistItems → videos` custa ~400 unidades para
  200 canais × 50 vídeos. Nunca monte pools por busca.

## Licença

MIT — ver [LICENSE](./LICENSE).
