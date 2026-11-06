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
│   ├── services/       (later phases) nasa/ climate/ handoff/ geospatial/ ai/
│   ├── models/         (later phases) Mongoose schemas
│   ├── middleware/     error handling, request logging
│   ├── utils/          response helpers
│   ├── validators/     (later phases) input validation
│   ├── jobs/           (later phases) scheduled ingestion
│   ├── app.js          express application
│   └── server.js       entry point + graceful shutdown
├── tests/              (later phases)
├── .env.example        environment template (no real credentials)
└── package.json
```

## Getting started

1. `npm install`
2. `cp .env.example .env` and fill in values (MongoDB Atlas URI — keep it in `.env` only)
3. Development: `npm run dev` (nodemon) · Production: `npm start`

## API

| Method | Path                | Description                                |
|--------|---------------------|--------------------------------------------|
| GET    | `/api/v1/health`    | Liveness/readiness + database state        |

All responses follow the format:

```json
{ "success": true, "data": { ... } }
// errors:
{ "success": false, "error": { "message": "..." } }
```

## Security ground rules

- Secrets live only in `.env` — it is gitignored; `.env.example` contains placeholders only.
- NASA (Earthdata) credentials are backend-only, never sent to the frontend.
