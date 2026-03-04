---
name: acc-tools
description: Nota Autodesk Construction Cloud (ACC) API til ad lista verkefni og issues.
---

# ACC Tools

Skillid notar Autodesk Platform Services / ACC API fyrir verkefni og issues.

## Forsendur

- Gild OAuth access token fyrir ACC tenant.
- Group hefur heimild fyrir `acc-tools`.
- Hafa:
- `ACC_ACCESS_TOKEN`
- `ACC_HUB_ID`
- `ACC_PROJECT_ID` (valfrjals i verkefnalista)

## API hausar

```bash
export ACC_ACCESS_TOKEN="<token>"
AUTH_HEADER="Authorization: Bearer $ACC_ACCESS_TOKEN"
JSON_HEADER="Content-Type: application/json"
```

## 1) Lista verkefni i hub

```bash
HUB_ID="<hub-id>"
curl -s "https://developer.api.autodesk.com/project/v1/hubs/$HUB_ID/projects" \
  -H "$AUTH_HEADER"
```

Skila i svari:
- `id`
- `attributes.name`
- `attributes.status`
- `attributes.startDate` / `attributes.endDate` ef til er

## 2) Lista issues i verkefni

```bash
PROJECT_ID="<project-id>"
curl -s "https://developer.api.autodesk.com/construction/issues/v1/projects/$PROJECT_ID/issues" \
  -H "$AUTH_HEADER"
```

Valfrjals sfilter:

```bash
curl -s "https://developer.api.autodesk.com/construction/issues/v1/projects/$PROJECT_ID/issues?status=open&limit=100" \
  -H "$AUTH_HEADER"
```

## 3) Samantekt fyrir BIM teymi

Eftir API kall:
- Flokka issues eftir `status` og `due_date`.
- Merkja overdue issues serstaklega.
- Benda a issues sem hafa bein ahraif a samraemingu (MEP/STR/ARK clashes).

## Svarformat til notanda (islenska)

- Verkefni: nafn, staða, id.
- Issues: opid, i vinnslu, lokid, overdue.
- Ljuka alltaf a:
- `Naesta adgerd`
- `Abyrgdaraðili`
- `Skiladagur`
