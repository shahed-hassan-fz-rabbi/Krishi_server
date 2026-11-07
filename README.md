# Krishi Mama — Backend

Express.js + MongoDB (Mongoose) REST API for the Krishi Mama platform:
NASA-powered climate-informed agricultural decision support for Bangladesh.

## Folder structure

```
server/
├── src/
│   ├── config/         env loading, MongoDB connection
│   ├── controllers/    request handlers per resource
│   ├── routes/         v1 router tree
│   ├── services/       NASA ingestion and climate analysis
│   ├── models/         Mongoose schemas
│   ├── middleware/     error handling, request logging
│   ├── utils/          response helpers
│   ├── validators/     NASA POWER input validation
│   ├── jobs/           controlled ingestion and audit scripts
│   ├── app.js          express application
│   └── server.js       entry point + graceful shutdown
├── tests/              unit, contract, validation, and database integration tests
├── .env.example        environment template (no real credentials)
└── package.json
```

## Getting started

1. `npm install`
2. `cp .env.example .env` and fill in values (MongoDB Atlas URI — keep it in `.env` only)
3. Development: `npm run dev` (nodemon) · Production: `npm start`

## Tests

- `npm run test:unit` runs validator, ingestion-helper, API validation, health-policy, and Python contract tests. It does not connect to MongoDB.
- `npm run test:integration` requires `MONGODB_URI` (or `MONGODB_TEST_URI`) in `server/.env` and a database user allowed to create and write databases. The climate and auth test files each force a unique `km_api_*` or `km_auth_*` database name and use isolated test data; they never target the URI's configured application database.
- `npm test` runs the unit suite and then the integration suite. If MongoDB cannot be reached or the test database cannot be created, the integration setup fails explicitly with a sanitized connection class; it does not skip or mark the API integration as passed.

Connection diagnostics never print the MongoDB URI. Do not grant broader database privileges or change Atlas network access solely to make tests pass without reviewing that change.

## Read-only database audit

`src/jobs/audit-data-readonly.js` is a standalone query-only audit for an environment that can already reach MongoDB. It reports district and dataset records, observation counts and ranges, quality/sentinel counts, coverage by district/parameter/year, missing record-days, incomplete years, duplicate current-key groups, existing unique indexes, cross-dataset key-collision candidates, and recent ingestion summaries. It does not insert, update, delete, replace, drop, or create indexes/collections. Mongoose auto-create and auto-index are disabled before model loading.

Run from `server/` with Node.js after the server environment has loaded its existing MongoDB setting:

```powershell
node src/jobs/audit-data-readonly.js
```

`MONGODB_TEST_URI`, when configured, takes precedence over `MONGODB_URI` through the shared connection manager; verify that the selected environment points at the intended database without printing its value. Use an account with read-only database privileges for the audit. The script was prepared and reviewed here but was not executed against MongoDB in this restricted environment.

## API

| Method | Path                | Description                                |
|--------|---------------------|--------------------------------------------|
| GET    | `/api/v1/health`    | Liveness/readiness, database, and dataset state |
| GET    | `/api/v1/districts` | Supported districts and coordinates        |
| GET    | `/api/v1/climate/summary` | Historical climate summary           |
| GET    | `/api/v1/climate/rainfall` | Historical rainfall analysis         |
| GET    | `/api/v1/climate/temperature` | Historical temperature analysis  |
| GET    | `/api/v1/data-sources` | Dataset provenance and coverage          |

All responses follow the format:

```json
{ "success": true, "data": { ... } }
// errors:
{ "success": false, "error": { "code": "...", "message": "..." }, "meta": {} }
```

## Security ground rules

- Secrets live only in `.env` — it is gitignored; `.env.example` contains placeholders only.
- NASA (Earthdata) credentials are backend-only, never sent to the frontend.
