# Untangled Nexus API

Production backend for the website and Windows desktop client.

## Repo layout (required for Render)

```
untangled-nexus-api/          ← GitHub repo root
  package.json                ← must be here
  server/index.ts
  ...
```

Do **not** nest the project in a subfolder like `untangled-nexus-api-main/`.

## Render settings

| Setting | Value |
|---------|--------|
| Root Directory | *(leave empty)* |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Node version | 20 or 22 (optional) |

### Environment variables

- `MONGODB_URI` — required (Atlas connection string)
- `JWT_SECRET` — required in production
- `NODE_ENV=production`
- `PORT` — set automatically by Render

## Local run

```bash
cp .env.example .env
# edit MONGODB_URI
npm install
npm start
```

## Desktop client

Point `API_BASE_URL` at this service, e.g. `https://untangled-nexus-api.onrender.com`.
