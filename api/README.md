# Rapportportal API

Forelopig deploybar Node.js-tjeneste med `GET /health`. Den har **ingen offentlige rapport- eller innloggingsendepunkter** enna.

Neste steg er migreringer, passordhashing, invitasjonsflyt, sikre sesjoner og tilgangskontroll pa alle kunde- og rapportendepunkter. Databasepassord skal kun ligge som Railway-miljovariabler.

Railway: sett Root Directory til `/api` og Healthcheck Path til `/health`. Ikke koble kundedomenet til tjenesten for autentisering og tilgangskontroll er pa plass.
