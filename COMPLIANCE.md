# Conformidade com os termos da API do YouTube

Este arquivo é o checklist revisado antes de cada release. Cada restrição tem um
identificador estável (R1–R13), usado nos comentários do código e nas mensagens de
commit. Restrição sem cobertura é dívida declarada, não item esquecido.

Documentos normativos:

- [Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
- [Guia de conformidade](https://developers.google.com/youtube/terms/developer-policies-guide)
- [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality)
- [API Services ToS](https://developers.google.com/youtube/terms/api-services-terms-of-service)
- [Quota e auditorias](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)

## Situação

| #   | Restrição                                                           | Como é atendida                                                                                                                            | Cobertura                         |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| R1  | Histórico de exibição não existe na API (depreciado em 2016)        | `parseWatchHistory` (Takeout) + `computeAffinity` combinando Takeout, inscrições, favoritos e tracking interno com decaimento              | 🟡 parcial — falta a UI de import |
| R2  | `search.list` custa 100 de 10.000 unidades/dia                      | `QuotaLedger` debita antes de cada chamada e recusa quando não cabe; reserva de 20% protege o interativo dos jobs de fundo                 | ✅ coberto (15 testes)            |
| R3  | Dados da API expiram em 30 dias corridos                            | `refreshedAtMs` em todo registro; `isCacheExpired`/`needsRefresh` com folga de 5 dias; vencido é recusado antes de qualquer outra checagem | 🟡 parcial — falta o job de purga |
| R4  | Scraping proibido, inclusive obter dados raspados de terceiros      | Só a API oficial. Sem bookmarklet, sem yt-dlp, sem Apify/EnsembleData/Zyla                                                                 | ✅ por construção                 |
| R5  | Proibido overlay na frente do player, inclusive sobre os controles  | Chrome (número do canal, badge LIVE, EPG) fica fora do retângulo do iframe; no zapping o player é desmontado                               | ⏳ pendente (M3)                  |
| R6  | Viewport mínima 200×200 (recomendado ≥480×270 em 16:9)              | CSS garante mínimo; nenhum modo de exibição encolhe o player abaixo disso                                                                  | ⏳ pendente (M3)                  |
| R7  | Um só player com autoplay por tela; autoplay só com >50% visível    | Um único player montado por vez; sem pré-carregamento do próximo vídeo                                                                     | ⏳ pendente (M3)                  |
| R8  | Embedding Restriction: só web e apps mobile/web não-embutidos       | Sem app de Android TV / Fire TV. TV apenas via navegador da smart TV ou espelhamento pelo usuário                                          | ✅ decisão de escopo              |
| R9  | Atribuição ao YouTube obrigatória e não obscurecível                | Marca YouTube + nome do canal + título + link "Assistir no YouTube" sempre visíveis                                                        | ⏳ pendente (M3)                  |
| R10 | Proibido cobrar pelo conteúdo ou inserir ads próprios               | Produto gratuito, sem ads, sem bloquear ou adiar os ads do YouTube                                                                         | ✅ por construção                 |
| R11 | `youtube.readonly` é escopo sensível                                | Sem verificação OAuth: 100 usuários no total, consentimento expira em 7 dias. Documentado no README                                        | ✅ documentado                    |
| R12 | Navegadores bloqueiam autoplay com som                              | O botão "Ligar TV" é o gesto exigido; início mudo com `unMute` no gesto como reforço                                                       | ⏳ pendente (M3)                  |
| R13 | Vídeos podem ser não-embutíveis, bloqueados, restritos ou removidos | Filtro prévio (`checkEligibility`) + `onError` e re-fluxo no motor. Falta só o watchdog de 8s, que vive no player                          | 🟡 parcial — falta o watchdog     |

## R13 em detalhe

É a causa número um de "canal travado", então tem três camadas independentes:

1. **Filtro prévio** — `checkEligibility` em `packages/yt` exige
   `embeddable === true`, `privacyStatus === 'public'`,
   `uploadStatus === 'processed'`, ausência de classificação indicativa e região do
   usuário fora de `regionRestriction.blocked` (respeitando também `allowed`).
   `buildPool` devolve a contagem por motivo de recusa, para a interface poder
   explicar um pool pequeno em vez de mostrar canal vazio sem justificativa.
   **Implementado**, 29 testes.
2. **Watchdog de carregamento** — se o player não atingir `PLAYING` em 8s após o
   `load`, `ChannelEngine.tick` trata como falha. É a falha mais insidiosa do gênero:
   há vídeos que não iniciam no iframe e **nunca** disparam `onError`, então sem esta
   camada o canal fica em tela preta para sempre, sem nada nos logs.
   **Implementado** em `packages/player`, com código de erro sintético `-1` para
   distinguir do que veio do player.
3. **`onError`** — códigos 2, 5, 100, 101 e 150 marcam o vídeo como injogável e
   disparam re-fluxo pelo relógio. Depois de três falhas seguidas, o motor passa a
   `trouble` e a interface admite o problema — insistir em silêncio é pior.
   **Implementado**: `isUnplayableError`/`dropUnplayable` em `packages/core` e
   `ChannelEngine.onError` em `packages/player`.

## Invariantes do motor de grade já garantidos por teste

Não são exigências da ToS, mas são as promessas do produto, e quebrá-las é o pior
defeito possível num app que imita TV:

- O slot no ar e a zona congelada são bit-idênticos antes e depois de qualquer patch.
- O passado nunca é reescrito — nem por descarte de vídeo injogável.
- A grade permanece contígua (sem buraco nem sobreposição) após qualquer mutação.
- Um vídeo vai ao ar no máximo uma vez por dia.
- `base(seed) + patches em ordem` reproduz a grade materializada em qualquer dispositivo.
