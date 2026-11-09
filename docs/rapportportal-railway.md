# Rapportportal – Railway (under utvikling)

Denne grenen etablerer datamodellen for en fremtidig rapportportal. **Ingen innlogging eller kundeportal er aktivert ennå.**

## Planlagt oppsett
- Eksisterende statisk nettside pa GitHub Pages.
- Egen API-tjeneste pa Railway med PostgreSQL.
- Privat fillagring for bilder og PDF-er (leverandor velges for implementering).
- Innlogging med serverbaserte sesjoner, sikker passordhashing og rollebasert tilgang.

## Arbeidsflyt
1. Administrator oppretter ansatte og inviterer kunder.
2. Kunde knyttes til en eller flere eiendommer.
3. Ansatt lager og lagrer rapportutkast.
4. Ansatt sender rapport til kontroll; godkjent versjon fryses.
5. "Overfor til kunde" publiserer godkjent rapport pa eiendommen.
6. Kunden ser kun publiserte rapporter pa eiendommer vedkommende har tilgang til.

## Database
`database/report_portal_schema.sql` er et **startskjema**, ikke en ferdig migrerings- eller produksjonslosning. Det skal videreutvikles med revisjonsspor, sikre migreringer og API-autorisasjon.

## For produksjonssetting
Krever Railway-prosjekt, PostgreSQL-tjeneste, API, sikker autentisering, privat fillagring, backup og ende-til-ende-testing. Ikke legg Railway-hemmeligheter eller databasepassord i GitHub eller nettleserkode.
