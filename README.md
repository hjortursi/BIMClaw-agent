<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="BIMClaw-agent" width="360">
</p>

<p align="center">
  BIMClaw-agent is a fork of NanoClaw: an agent runtime backend for BIM teams in construction.
</p>

# BIMClaw-agent

`BIMClaw-agent` er sérhæfð útgáfa af [NanoClaw](https://github.com/qwibitai/nanoclaw) fyrir BIM teymi.

Markmið forksins:
- Halda NanoClaw kjarnaarkitektúrnum óbreyttum eins og hægt er (auðveldara að merge-a upstream)
- Bæta við BIM-sértækri hegðun í aðskildum slóðum (`src/bimclaw/`, `.claude/skills/bim/`)
- Styðja verkferla fyrir Procore, ACC, Solibri, RFIs, issues, clash detection og skilafresti

## Hvað er nýtt í þessum fork

- Sjálfgefið BIM group prompt: [`groups/bim-default/CLAUDE.md`](groups/bim-default/CLAUDE.md)
- BIM skills:
- `.claude/skills/bim/procore-tools`
- `.claude/skills/bim/acc-tools`
- `.claude/skills/bim/deadline-checker`
- `.claude/skills/bim/weekly-summary`
- BIMClaw API bridge: [`src/bimclaw-api.ts`](src/bimclaw-api.ts)
- BIM tenant/token/permissions/notification config model: [`src/bimclaw/config.ts`](src/bimclaw/config.ts)
- BIM config dæmi: [`config-examples/bim-settings.json`](config-examples/bim-settings.json)
- Docker runtime image fyrir Railway: [`Dockerfile`](Dockerfile)

## Quick Start

```bash
git clone <this-fork-url>
cd NanoClaw-fork
npm install
npm run build
npm test
```

Keyrðu svo þjónustuna:

```bash
npm start
```

## BIM Skills (íslensk verkferli)

Skill pakkinn undir `.claude/skills/bim/` er hannaður fyrir daglega BIM notkun:

- `procore-tools`
- Lista verkefni, RFIs og issues
- Búa til/uppfæra RFI og bæta við comments
- `acc-tools`
- Lista ACC verkefni og issues
- `deadline-checker`
- Sjálfvirk frestaeftirlit og viðvaranir
- `weekly-summary`
- Vikuleg stöðuskýrsla fyrir verkefni

Athugið: runtime syncar bæði `container/skills/*` og `.claude/skills/bim/*` inn í session skills.

## BIMClaw API Bridge

API bridge er HTTP þjónusta sem dashboard getur kallað á.

API er virkjað með:

```bash
BIMCLAW_API_ENABLED=true
BIMCLAW_API_PORT=8787
# BIMCLAW_API_TOKEN=optional-bearer-token
```

Helstu endpointar:

- `GET /bimclaw-api/status`
- Agent status, queue state, registered groups og BIM config summary
- `GET /bimclaw-api/conversations`
- Lista samtöl/chats
- `GET /bimclaw-api/conversations/:chatJid/messages?limit=100`
- Lista skilaboð í samtali
- `POST /bimclaw-api/messages`
- Senda skilaboð í agent og fá svör
- `POST /bimclaw-api/tools/execute`
- Triggera tools (IPC tools og BIM tools)

Dæmi (`messages`):

```bash
curl -X POST http://localhost:8787/bimclaw-api/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "chatJid": "1203633@g.us",
    "text": "Gerðu stöðu á opnum RFIs",
    "waitForResponse": true
  }'
```

## BIM Config Model

Hver group getur haft BIM stillingar í `registered_groups.bim_config`:

- tenant auðkenni
- Procore OAuth tokenar
- ACC OAuth tokenar
- tool permissions
- notification preferences

Types:
- `BimGroupConfig`
- `BimOAuthConfig`
- `BimToolPermissions`
- `BimNotificationPreferences`

Sjá `config-examples/bim-settings.json` og `.env.example` fyrir fallback env vars.

## Docker + Railway

Nýr root `Dockerfile` keyrir BIMClaw-agent sem app service (fyrir Railway og sambærilegt).

```bash
docker build -t bimclaw-agent .
docker run --rm -p 8787:8787 --env BIMCLAW_API_ENABLED=true bimclaw-agent
```

Athugið:
- Þetta Docker image er fyrir host runtime þjónustuna.
- Upprunalega `container/Dockerfile` er áfram agent container image sem runtime notar.

## Arkitektúr (óbreyttur kjarni)

NanoClaw kjarni er enn:

```text
Channels -> SQLite -> Polling loop -> Container runner -> Agent response
```

Helstu skrár:
- `src/index.ts` - orchestrator
- `src/db.ts` - SQLite
- `src/group-queue.ts` - per-group queue
- `src/ipc.ts` - IPC watcher + task handling
- `src/container-runner.ts` - keyrir agent container
- `src/task-scheduler.ts` - scheduler
- `src/bimclaw-api.ts` - BIMClaw HTTP bridge

## Upstream Strategy

Til að auðvelda merges frá NanoClaw upstream eru BIM breytingar haldnar aðskildar:
- `src/bimclaw/*`
- `src/bimclaw-api.ts`
- `.claude/skills/bim/*`
- `groups/bim-default/CLAUDE.md`

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
npm run format:check
```

## License

MIT (arfast frá NanoClaw).
