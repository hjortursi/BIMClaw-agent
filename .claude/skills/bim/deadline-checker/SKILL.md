---
name: deadline-checker
description: Timaáætlað BIM verkefni sem fylgist med komandi skilafrestum og sendir vidvaranir.
---

# Deadline Checker

Skillid setur upp og keyrir reglulega athugun a frestum i BIM verkefnum.

## Tilgangur

- Finna skil innan nasta tids (t.d. 3/7/14 dagar).
- Merkja fresti sem eru liðnir.
- Senda skyrar vidvaranir med abyrgdaraðila og adgerd.

## Gagnagjafar

- Procore RFIs og issues
- ACC issues
- Innri verkefnalisti i group folder (t.d. `deadlines.json` eller `deadlines.md`)

## Mælt schedule

```text
cron: "0 7 * * 1-5"
```

Keyrir alla virka daga kl. 07:00 i local timezone.

## Prompt snið fyrir schedule_task

Notad eftirfarandi prompt þegar task er stofnad:

```text
Athugadu alla opna RFIs og issues i Procore og ACC fyrir þetta verkefni.
Finndu skil sem eru:
1) lidnir
2) innan 3 daga
3) innan 7 daga
Skilaðu nidurstodu i islensku med:
- atridi
- eiganda
- skiladag
- ahattu (ha/mi/la)
Sendu skilabod med mcp__nanoclaw__send_message ef eitthvad er overdue eða innan 3 daga.
```

## Vidvorunarsnið (islenska)

- Fyrirsogn: `Frestavidvorun - <verkefni>`
- Flokkar:
- `Overdue`
- `Innan 3 daga`
- `Innan 7 daga`
- Lokalinur:
- `Naesta adgerd: ...`
- `Abyrgd: ...`

## Notkun

- Ef task er ekki til: bua hann til med `schedule_task`.
- Ef task er til: sannreyna schedule og context.
- Fyrir ad hoc keyrslu: keyra sama prompt strax i virku groupi.
