# LAST STATUS
Date: 2026-05-15 (atualizado após diagnóstico de logs)

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

### ❌ Pendente / com problema
- [ ] **Healthcheck usa `curl`** mas container não tem curl — sempre falha com exitCode=-1.  
  Fix já aplicado: trocar para `node -e fetch(...)`. Requer rebuild para valer.
- [ ] **`depends_on: condition: service_healthy`** bloqueia start do `deepsproxy` enquanto healthcheck falha.  
  Workaround atual: subir `deepsproxy` manualmente ou via container temporário.
- [ ] **Login automático** ainda não funciona (captcha na primeira sessão) — requer intervenção manual no browser headed.
- [ ] Testar fluxo completo de chat via API após login manual.

## Próximo passo imediato
1. Fazer login manual no browser que está aberto (chat.deepseek.com)
2. Após login, testar: `curl -s http://localhost:9300/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"deepseek-thinking","messages":[{"role":"user","content":"Olá!"}],"stream":false}'`
3. Rebuild com `--no-cache` para o novo healthcheck (node fetch) entrar na imagem

## Comandos úteis
```bash
# Rebuild e subir
docker compose build && docker compose up -d

# Acompanhar logs do playwright (ver se browser subiu)
docker logs -f deepsproxy-playwright

# Health check manual
curl http://localhost:9301/health
curl http://localhost:9300/health

# Limpar locks manualmente se necessário
find deepseek_profile -name 'Singleton*' -delete

# Testar API
curl -sS http://localhost:9300/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"deepseek-thinking","messages":[{"role":"user","content":"Olá!"}],"stream":false}' | jq
```


## Estado atual
- Serviço `deepsproxy-playwright` em escuta (porta 9301). API `deepsproxy` responde (porta 9300).
- Playwright está iniciando Chromium dentro do container; atualmente a execução cabeada está rodando via `xvfb-run` (framebuffer virtual).
- Tentativas de rodar Chromium diretamente contra o `DISPLAY` do host falharam com erro "Missing X server" quando não havia socket X acessível ao container.

## Problemas reportados pelo usuário
- Chromium não aparece na tela do usuário (o browser abre em Xvfb virtual ou falha com "Missing X server").
- Perfil persistente (`deepseek_profile`) às vezes trava com arquivos `Singleton*` e problemas de permissões.
- Processos Chrome/Chromium deixados no container aparecem como defunct em algumas execuções.

## Estratégia tentada até agora
- Separar Playwright em serviço próprio (`deepsproxy-playwright`) para manter sessão/browser abertos entre reinícios.
- Montar `./deepseek_profile` no container e chown para `node:node` para persistência.
- Permitir acesso X do host ao container usando `xhost +si:localuser:$USER` e montar `/tmp/.X11-unix` (quando possível).
- Fallback: usar `xvfb-run` para iniciar um X virtual quando o host X não estava disponível.
- Limpar locks (`find deepseek_profile -name 'Singleton*' -delete`) e encerrar processos chrome/crashpad antes de iniciar.

## Observações de logs relevantes
- Mensagens Playwright: `Looks like you launched a headed browser without having a XServer running.` — indica que o container tentou abrir em modo headed sem DISPLAY funcional.
- `xvfb-run` permitiu abrir o browser e navegar até `https://chat.deepseek.com/` (login visual no framebuffer virtual).

## Comandos seguros para VERIFICAR (sem matar processos)
Execute estes comandos no host (pasta `deepsproxy`) para inspecionar antes de qualquer kill:

```
echo "HOST DISPLAY: $DISPLAY"
ls -la /tmp/.X11-unix
pgrep -a chrome || pgrep -a chromium || ps aux | egrep 'chrom(e|ium)' || true
docker ps --filter name=deepsproxy-playwright --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker exec deepsproxy-playwright ps aux | egrep 'chrom|playwright|xvfb' || true
docker logs --tail 200 deepsproxy-playwright || true
```

Use esses resultados para decidir se devemos encerrar processos ou apenas ajustar permissões/XACL.

## Próximos passos recomendados
1. Execute os comandos de verificação acima e cole a saída aqui (ou permita que eu a verifique).  
2. Se `/tmp/.X11-unix` do host estiver montado e `xhost` autorizar o usuário, iniciar `docker compose up -d deepsproxy-playwright` e executar `docker exec -d -u node -e DISPLAY=$DISPLAY deepsproxy-playwright npm run login` (sem `xvfb-run`) para abrir o Chromium visível.  
3. Se isso falhar, podemos: (a) ajustar montagem/permissões de `/tmp/.X11-unix` e `xauth`, ou (b) manter `xvfb-run` e usar VNC/novnc para ver a tela virtual.

## Notas sobre validação com outros modelos/novo contexto
- Para validar o comportamento em outro ambiente ou modelo, exporte `deepseek_profile` e rode Playwright localmente fora do container, ou reproduza em uma VM com X disponível.  
- Posso preparar um script curto que coleta logs, faz checagens e tenta ligar o browser no DISPLAY automaticamente (precisa de autorização para executar kills/changes).

---
Documento criado para iniciar um novo contexto de diagnóstico e validação.
