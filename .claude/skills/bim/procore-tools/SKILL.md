---
name: procore-tools
description: Nota Procore REST API til ad lista verkefni, RFIs og issues. Bua til/uppfaera RFI og baeta vid comments.
---

# Procore Tools

Notad fyrir BIM verkefni sem keyra a Procore. Skillid vinnur beint gegn Procore REST API med OAuth access token.

## Forsendur

- THarf gildan access token fyrir tenant/group.
- Lesa fyrst BIM stillingar fyrir vidkomandi group (tenant, project ids, permissions).
- Hafa eftirfarandi gildi tiltæk:
- `PROCORE_BASE_URL` (oftast `https://api.procore.com`)
- `PROCORE_COMPANY_ID`
- `PROCORE_ACCESS_TOKEN`

## Almenn API stilling

```bash
export PROCORE_BASE_URL="https://api.procore.com"
export PROCORE_ACCESS_TOKEN="<token>"
export PROCORE_COMPANY_ID="<company-id>"

AUTH_HEADER="Authorization: Bearer $PROCORE_ACCESS_TOKEN"
JSON_HEADER="Content-Type: application/json"
```

## 1) Lista verkefni

```bash
curl -s "$PROCORE_BASE_URL/rest/v1.0/projects?company_id=$PROCORE_COMPANY_ID" \
  -H "$AUTH_HEADER"
```

Skila i svari:
- `project_id`
- `name`
- `project_number`
- `status`

## 2) Lista RFIs fyrir verkefni

```bash
PROJECT_ID="<project-id>"
curl -s "$PROCORE_BASE_URL/rest/v1.0/projects/$PROJECT_ID/rfis" \
  -H "$AUTH_HEADER"
```

Skila i svari:
- `id`
- `subject`
- `status`
- `assignee`
- `due_date`

## 3) Lista issues fyrir verkefni

```bash
PROJECT_ID="<project-id>"
curl -s "$PROCORE_BASE_URL/rest/v1.0/projects/$PROJECT_ID/issues" \
  -H "$AUTH_HEADER"
```

Ef endpoint er ekki virkt i tenant, nota Procore docs fyrir rettan issues endpoint fyrir account.

## 4) Bua til RFI

```bash
PROJECT_ID="<project-id>"

curl -s -X POST "$PROCORE_BASE_URL/rest/v1.0/projects/$PROJECT_ID/rfis" \
  -H "$AUTH_HEADER" \
  -H "$JSON_HEADER" \
  -d '{
    "subject": "Skyring a loftahæð i tæknirom",
    "question": "Stadfestid lokahæð i AA-102 vegna MEP arekstra.",
    "due_date": "2026-03-12",
    "responsible_contractor_id": 12345
  }'
```

## 5) Uppfaera RFI

```bash
PROJECT_ID="<project-id>"
RFI_ID="<rfi-id>"

curl -s -X PATCH "$PROCORE_BASE_URL/rest/v1.0/projects/$PROJECT_ID/rfis/$RFI_ID" \
  -H "$AUTH_HEADER" \
  -H "$JSON_HEADER" \
  -d '{
    "status": "open",
    "subject": "Uppfaerd fyrirspurn - loftahæð i tæknirom"
  }'
```

## 6) Baeta comment vid RFI

```bash
PROJECT_ID="<project-id>"
RFI_ID="<rfi-id>"

curl -s -X POST "$PROCORE_BASE_URL/rest/v1.0/projects/$PROJECT_ID/rfis/$RFI_ID/comments" \
  -H "$AUTH_HEADER" \
  -H "$JSON_HEADER" \
  -d '{
    "body": "Athugid ad Solibri clash #MEP-214 tengist þessum lið."
  }'
```

## Svarformat til notanda (islenska)

- Byrja a stuttri stödu: hvad fannst / hvad var uppfaert.
- Birta id, status og skiladagsetningar i skyrri lista.
- Ef API svarar villu: birta `http status`, stutta orsok og naestu skref.
