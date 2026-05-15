# LAST STATUS
Date: 2026-05-15 (atualizado após validação end-to-end com Nanobrowser)

## Problemas identificados nos logs (15/05/2026)

### Problema 1 — CRÍTICO (RESOLVIDO): Profile Singleton Lock
- **Erro:** `process_singleton_posix.cc:363 — profile in use by another computer (3d53ce7583a9), exitCode=21`
- **Causa:** Ao reiniciar o container, o Docker atribui um novo hostname. O arquivo `Singleton` do Chrome ficava para trás com PID + hostname do container anterior. O novo Chromium lia o lock de uma "máquina diferente" e recusava iniciar.
- **Fix aplicado em `src/services/playwright.ts`:**
  - Função `clearProfileLocks()` que remove arquivos `Singleton*` antes de cada `launchPersistentContext`.
  - Try/catch no launch: se falhar com erro de "profile" ou "Singleton", limpa e faz um retry automático.

### Problema 2 — CRÍTICO (RESOLVIDO): Cascata de retries sem cleanup
- **Erro:** 3 chamadas seguidas a `launchPersistentContext` no playwright-service, todas falhando com o mesmo lock.
- **Causa:** O `chat.ts` fazia retry no `createDeepSeekStream`, que chamava `/headers` no playwright-service, que tentava `launchPersistentContext` sem limpar locks entre tentativas.
- **Fix:** O `clearProfileLocks` antes de cada launch garante que mesmo os retries externos agora funcionam.

### Problema 3 — MÉDIO (RESOLVIDO): Browser não inicializado na subida
- **Causa:** O `playwright-service.ts` só inicializava o browser sob demanda (na primeira chamada `/headers`). Qualquer requisição chegando antes disso falhava.
- **Fix aplicado em `src/playwright-service.ts`:**
  - `initPlaywright()` é chamado na inicialização do serviço (eager init).
  - `/health` retorna HTTP 503 enquanto o browser não estiver pronto (`browserReady = false`).
  - Tratamento de SIGTERM adicionado ao playwright-service.

### Problema 4 — MÉDIO (RESOLVIDO): Sem ordering entre containers
- **Causa:** `deepsproxy` subia junto com `deepsproxy-playwright` sem esperar o browser estar pronto.
- **Fix aplicado em `docker-compose.yml`:**
  - `healthcheck` no container `playwright`: `curl -sf http://localhost:9301/health` a cada 5s, até 10 tentativas, com `start_period: 30s`.
  - `depends_on` no container `deepsproxy` com `condition: service_healthy`.

## Estado atual após fixes
- Containers sobem em ordem: `playwright` → (healthy) → `deepsproxy`.
- Locks do profile são limpos automaticamente no startup do `playwright-service`.
- Recovery automático em caso de lock residual (retry após limpeza).
- `/health` do playwright-service reflete o estado real do browser.

## Checklist

### ✅ Feito
- [x] Singleton lock cleanup automático no startup do playwright-service
- [x] Retry automático após falha de lock (clearProfileLocks + try/catch)
- [x] Eager init do browser no playwright-service (não espera primeira requisição)
- [x] `/health` do playwright-service reflete estado real do browser (`browserReady`)
- [x] `docker-compose.dev.yml` com `network_mode: host` para acesso ao X11 do host
- [x] `dev.sh` para subir em modo headed (browser visível na tela)
- [x] Browser abrindo visível na tela do host com `./dev.sh` ✅ (confirmado 15/05)
- [x] Sessão DeepSeek válida e carregada no browser ✅
- [x] API respondendo: `GET /health` → `{"status":"ok"}` em :9300 e :9301 ✅
- [x] `/chat/completions` e `/v1/chat/completions` ambos roteados ao handler ✅
- [x] `stream: false` retorna `application/json` correto (não SSE) ✅
- [x] `response_format: json_schema` / `json_object` → injeta instrução JSON no systemPrompt + schema ✅
- [x] Strip de tags `<think>...</think>` na resposta non-streaming ✅
- [x] Extração do bloco `{...}` do conteúdo quando `needsJson=true` ✅
- [x] Smart windowing: KEEP_HEAD=3 + KEEP_TAIL=4, MAX_PROMPT_CHARS=14000 ✅
- [x] `console.log` de debug: `[chat] model=... stream=... msgs=... promptLen=... needsJson=...` ✅
- [x] Fluxo end-to-end com Nanobrowser validado ✅

### ❌ Pendente / com problema
- [ ] **Login automático** ainda não funciona (captcha na primeira sessão) — requer intervenção manual no browser headed.
- [ ] Erro `Cannot convert undefined or null to object` no Navigator do Nanobrowser — pode ocorrer se o JSON retornado não for válido. Monitorar.

## Próximo passo imediato
Testar o fluxo completo do Nanobrowser com tarefas reais (navegar, analisar página, executar ações).

## Comandos úteis
```bash
# Subir em modo headed (browser visível)
./dev.sh logs

# Rebuild e subir produção
docker compose build && docker compose up -d

# Acompanhar logs filtrados
docker logs -f deepsproxy 2>&1 | grep -E "\[chat\]|GET |POST "

# Health check manual
curl http://localhost:9301/health
curl http://localhost:9300/health

# Limpar locks manualmente se necessário
find deepseek_profile -name 'Singleton*' -delete

# Testar API non-streaming com json_schema
curl -s http://localhost:9300/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-no-thinking","messages":[{"role":"user","content":"Say hello"}],"stream":false,"response_format":{"type":"json_object"}}' | jq

# Testar API streaming
curl -sS http://localhost:9300/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-thinking","messages":[{"role":"user","content":"Olá!"}],"stream":true}'
```

## Próximos passos recomendados
1. Execute os comandos de verificação acima e cole a saída aqui (ou permita que eu a verifique).  
2. Se `/tmp/.X11-unix` do host estiver montado e `xhost` autorizar o usuário, iniciar `docker compose up -d deepsproxy-playwright` e executar `docker exec -d -u node -e DISPLAY=$DISPLAY deepsproxy-playwright npm run login` (sem `xvfb-run`) para abrir o Chromium visível.  
3. Se isso falhar, podemos: (a) ajustar montagem/permissões de `/tmp/.X11-unix` e `xauth`, ou (b) manter `xvfb-run` e usar VNC/novnc para ver a tela virtual.

## Notas sobre validação com outros modelos/novo contexto
- Para validar o comportamento em outro ambiente ou modelo, exporte `deepseek_profile` e rode Playwright localmente fora do container, ou reproduza em uma VM com X disponível.  
- Posso preparar um script curto que coleta logs, faz checagens e tenta ligar o browser no DISPLAY automaticamente (precisa de autorização para executar kills/changes).

---
Documento criado para iniciar um novo contexto de diagnóstico e validação.
