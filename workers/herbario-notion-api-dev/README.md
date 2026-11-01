# Herbário do Sol — Worker de desenvolvimento

Esta é uma versão isolada do Worker de integração com o Notion. Não está publicada e não altera o Worker de produção.

## Arquivos
- `src/index.js`: API de leitura, gravação e reconciliação do Extrato de XP.
- `wrangler.toml`: configuração sem credenciais.

## Proteção de gravação
As rotas de leitura continuam públicas. Todas as operações de escrita usam o prefixo `/write/` e devem ser protegidas por Cloudflare Access com política restrita ao e-mail da proprietária. Configure a aplicação Access para o hostname do Worker de desenvolvimento e caminho `/write/*), nunca para o Worker de produção.

Variáveis do Worker:
- `NOTION_TOKEN`: secret da integração Notion; nunca versionar.
- `ACCESS_TEAM_DOMAIN`: domínio da equipe Zero Trust (ex.: `sua-equipe.cloudflareaccess.com`).
- `ACCESS_AUD`: Audience (AUD) Tag da aplicação Access.

O Worker valida assinatura RS256, emissor, audiência, expiração e chave pública do JWT em `Cf-Access-Jwt-Assertion), além de exigir Origin exato do site. CORS/Origin não substitui autenticação. O front-end deverá usar `credentials: "include"` nas chamadas protegidas.

## Rotas públicas
- `GET /health`
- `GET /notion/status`
- `GET /notion/check-databases`
- `GET /api/tasks`, `/api/adventures`, `/api/rituals`, `/api/xp`, `/api/recipes`

Consultas aceitam `page_size` e `start_cursor`; o cliente deve continuar enquanto `has_more` for verdadeiro.

## Rotas protegidas
- `POST /write/api/{resource}`: cria página na data source correspondente.
- `PATCH /write/api/{resource}/{page_id}`: atualiza propriedades de uma página.
- `POST /write/api/sync-xp`: reconcilia tarefas colhidas com o Extrato de XP.

Corpo de criação/edição: `{"properties": {...}}`, com os nomes e formatos exatos das propriedades Notion.

## Regras de XP
Apenas tarefas `Colhido` geram XP: Leve = 5, Média = 10, Difícil = 15. Ao sair de Colhido, cria Estorno; quando o valor esperado muda, cria Ajuste pela diferença. O ID da página de origem é guardado no ledger. A reconciliação consulta as bases com paginação.

É idempotente em chamadas sequenciais e coalesce chamadas simultâneas no mesmo isolate. Sem armazenamento transacional compartilhado (ex.: Durable Object), ainda pode haver corrida rara entre isolates/regiões; mitigar antes de uso multi-dispositivo concorrente.

## Pendências antes de publicar
- A data source de recompensas ainda não foi identificada; loja/resgate não está incluída.
- O front-end precisa chamar as rotas protegidas com `credentials: "include"`.
- Configurar Access e variáveis, validar schemas e executar testes de integração.
- Não implantar até concluir a validação. O Worker de produção permanece intacto.
