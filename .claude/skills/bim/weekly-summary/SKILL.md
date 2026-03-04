---
name: weekly-summary
description: Byr til vikulega stoduuppgjör fyrir BIM verkefni ur Procore, ACC, Solibri og innri verkefnaskram.
---

# Weekly Summary

Skillid framkvaemir vikulega samantekt fyrir verkefnasteymi.

## Markmid

- Gefa stutta og adgerdarmiðada mynd af stodu verkefnis.
- Samkeyra upplýsingar ur RFIs, issues, clash-listum og skiladogum.
- Bera kennsl a atridi sem krefjast adgerda i naestu viku.

## Inntak

- Procore: opnar RFIs, nyr issues, lokud atridi.
- ACC: opnar/overdue issues.
- Solibri: ny clash atridi og unresolved clashes.
- Innri skrar i group (`/workspace/group/`) sem geyma verkefnaathuganir.

## Mælt schedule

```text
cron: "0 16 * * 5"
```

Keyrir a fostudegi kl. 16:00.

## Prompt snið fyrir schedule_task

```text
Gerdu vikulega BIM stödu fyrir verkefnid.
Nidurstada skal vera a islensku med þessum koflum:
1) Helstu framfarir vikunnar
2) RFIs (opnar, svaradar, critical)
3) Issues og fravik (opid/overdue)
4) Clash detection stada (hard/soft/workflow)
5) Ahattur fyrir naestu viku
6) 5 skyr naestu skref med eiganda og dagsetningu
```

## Skilasnið (islenska)

- Nota stuttar, skyrar setningar.
- Dagsetningar alltaf i fullu sniði.
- Hafa lokakafla:
- `Mikilvaegast i naestu viku`
- `Atridi sem þurfa akvordun verkkaupa/radgjafa`

## Notkun

- Bua til vikulegt task ef það vantar.
- Endurkeyra handvirkt ef beðið er um "vikuyfirlit nuna".
- Vista afrit i group folder ef notandi biður um skjalfestingu (`weekly-summary-YYYY-MM-DD.md`).
