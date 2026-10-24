# Artistry360 API server

The one API for theartistry360.com, the Studio, stream.theartistry360.com and the Flutter app, at `api.theartistry360.com/api/v1`.

- **What it must do:** `../client/docs/17-api-server.md`.
- **Every endpoint path:** `../client/docs/12-backend-integration.md`, the one list for all clients.
- **Stack:** Node 22, Express 5, plain ESM (`.mjs`) bundled by esbuild, Prisma on MongoDB, zod, Redis (rate limits, locks, Socket.IO adapter), BullMQ, Socket.IO.

## Run it

```sh
cp .env.example .env        # then fill in AUTH_SECRET (openssl rand -hex 32)
yarn install                # also runs prisma generate
yarn dev                    # esbuild watch + nodemon on dist/index.cjs
```

MongoDB must run as a replica set (Prisma needs transactions). The local command is in `.env.example`. Then:

```sh
yarn db:push                # create the collections and indexes from schema.prisma
yarn staff:create --email you@theartistry360.com --name "Your Name"   # the first Super Admin
yarn seed:voting            # the client's demo campaigns, contestants and requests (--reset to start over)
```

Check `GET /api/v1/health` and the docs at `/api-docs`. To use the real API from the client, set `VITE_API_MOCKS=false` in `client/.env.local`.

## Layout

```
server/
├── prisma/
│   ├── schema.prisma            all models, grouped by area under // ── Area ── headers
│   └── seed.mjs                 demo data matching the clients' fixtures
├── public/                      favicon for the status page
└── src/
    ├── index.mjs                start-up: Redis → app → Socket.IO → listen → scheduler and workers
    ├── app.mjs                  middleware order, docs, rate limits, /api, the error envelope
    ├── env.mjs                  every env var, validated with zod; import { env } from here only
    ├── swagger.yaml             the API docs at /api-docs
    │
    ├── api/
    │   ├── index.js             mounts /v1
    │   └── v1/
    │       ├── index.mjs        endpoints[]: { path, router }, one line per routes file
    │       ├── routes/          <area>Routes.mjs: paths, guards, validate(schema), controller. Nothing else
    │       ├── controllers/     <area>Controller.mjs: reads req, calls services, sends { data }
    │       └── schemas/         <area>.mjs: the zod request schemas for that area
    │
    ├── services/<area>/         the business logic and every Prisma call. No req or res
    ├── middleware/              auth guards, validate, requestLogger, rawBody, audit
    ├── jobs/
    │   ├── scheduler.mjs        recurring tasks behind a Redis lock
    │   └── queues/              BullMQ queues and their workers (releases, emails, push, reminders)
    └── utils/                   db, redis, tokens, AppError, rateLimits, corsOptions, sockets
```

## The areas

Each area keeps the same name in all four places. Mount paths are relative to `/api/v1`.

| Area | Mount path(s) → routes file | Service folder | Build step |
|---|---|---|---|
| system | `/health` → `healthRoutes` | `system/` (health, app config, audit log) | 0 ✅ |
| app | `/app` → `appRoutes` (`app/config`) | `system/` | 1 |
| auth | `/auth` → `authRoutes` (login, register, refresh, logout, me, google, apple, otp, password) | `auth/` (members, sessions, providers, otp) | 1 |
| studio auth | `/auth/studio` → `studioAuthRoutes` (login, refresh, logout, me; 2FA later) | `auth/` (staff, sessions, passwords) | 1 ✅ |
| account | `/auth/me` → `accountRoutes`, `/auth/sessions` → `sessionRoutes`, `/me` → `meRoutes` (devices, notification preferences) | `account/` | 4 |
| support | `/support` → `supportRoutes` | `support/` | 4b |
| content | `/content` → `contentRoutes` (programmes, events, news, legal, faq) | `content/` | 4b, 6 |
| gallery | `/gallery` → `galleryRoutes` | `gallery/` | 6 |
| media | `/media` → `mediaRoutes` (image uploads) | `media/` | 6 |
| talent | `/talent/bookings` → `bookingRoutes`, `/talent/monologues` → `monologueRoutes`, `/talent` → `talentRoutes` (talent, profiles) | `talent/` | 6 |
| enquiries | `/enquiries` → `enquiryRoutes` | `enquiries/` | 6 |
| analytics | `/analytics` → `analyticsRoutes` | `analytics/` | 6 |
| streaming | `/streaming/titles` → `titleRoutes`, `/streaming/playback` → `playbackRoutes`, `/streaming` → `streamingRoutes` (types, categories, plans, subscribers, ads), `/streaming/uploads` + `/streaming/assets` → `uploadRoutes` | `streaming/` (titles, visibility, playback, releases, video provider) | 2, 6 |
| stream site | `/stream` → `streamSiteRoutes` (`stream/site`) | `streaming/` | 2 |
| comments | `/streaming/titles/:id/comments` → `commentRoutes` (`mergeParams`) | `comments/` | 3 |
| library | `/library` → `libraryRoutes` | `library/` | 3 |
| payments | `/payments` → `paymentRoutes` (orders, catalog, history, subscription, apple and google verify), `/payments` → `paymentWebhookRoutes` (PesaPal IPN, Apple and Google notifications) | `payments/` (orders, entitlements, pesapal, appStore, googlePlay) | 4, 4b |
| academy | `/academy` → `academyRoutes` | `academy/` (live classes, ingest, chat) | 5 |
| voting | `/voting/studio` → `studioVotingRoutes` (campaigns, contestants, stats), `/voting` → `votingRoutes` (published campaigns; free votes next) | `voting/` (campaigns, contestants, phase; votes and fraud checks next) | 7: campaigns ✅, free votes, paid votes |
| organisers | `/organisers` → `organiserRoutes` (requests ✅; accounts, invites and payouts next) | `organisers/` | 7 |
| notify | none (used by other services) | `notify/` (push via FCM, socket `invalidate`) | 1+ |
| emails | none | `emails/` (zohoMail, templates, queue) | 1+ |

**Mount order matters.** List the more specific path first in `endpoints[]`: `/auth/studio` and `/auth/me` before `/auth`, and `/talent/bookings` before `/talent`. Otherwise `/talent/:id` catches `bookings`.

## What goes where

**Route file** (`routes/titleRoutes.mjs`): the URL, who may call it, what it accepts, and which controller function answers. Nothing else.

```js
import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { requireAdmin, allow } from '../../../middleware/auth.mjs';
import * as schema from '../schemas/streaming.mjs';
import * as controller from '../controllers/titleController.mjs';

const router = express.Router();

router.get('/', validate(schema.listTitlesQuery, 'query'), controller.list);
router.get('/:id', controller.get);
router.post('/', requireAdmin, allow('content-manager'), validate(schema.titleBody), controller.create);

export default router;
```

**Controller** (`controllers/titleController.mjs`): takes what it needs from `req` (`body`, `params`, `query`, `req.member`, `req.admin`), calls one or more services, and answers `{ data }` or `{ data, meta }`. It sets the status code and the refresh cookie. It never imports Prisma. Express 5 forwards a thrown error or rejected promise to the error handler, so there is no try/catch.

```js
import * as titles from '../../../services/streaming/titles.mjs';

export const list = async (req, res) => {
    const { items, meta } = await titles.listVisible(req.query);
    res.json({ data: items, meta });
};

export const create = async (req, res) => {
    res.status(201).json({ data: await titles.create(req.body, { by: req.admin }) });
};
```

**Service** (`services/streaming/titles.mjs`): the rules, the Prisma calls, the response shapes (`toTitle(row)`), and the side effects after a write commits (`invalidateSite('titles')`, queueing a job, an email). It reports failures with `throw new AppError('…', 4xx)`, written for the person reading it. It never touches `req` or `res`, so routes, socket handlers and jobs can all call it.

**Schema** (`schemas/streaming.mjs`): named zod schemas such as `titleBody` and `listTitlesQuery`. They are shared with the route through `validate(schema, 'body' | 'query' | 'params')`. Links take `https://` only, never a bare `z.url()` (12-backend-integration.md, Security).

**Between areas:** one area calls another only through that area's service exports, never its models. For example, `payments/` calls `streaming/titles.mjs#getForSale`, never `prisma.title`.

## Shared pieces

| Piece | File | Notes |
|---|---|---|
| Error envelope | `app.mjs` + `utils/AppError.js` | `{ error: { code, message, details?, requestId } }`. Prisma P2002 becomes 409 |
| Request id | `app.mjs` | `req.id`, the `X-Request-Id` header, and in every error and 5xx log line |
| Validation | `middleware/validate.mjs` | 422 with `details.fieldErrors` |
| Auth guards | `middleware/auth.mjs` | `requireAdmin` (open session, active account → `req.admin`), `allow(...roles)` (MOU 3C roles; a Super Admin always passes), `knownOrigin` for cookie-only routes. `requireMember` and `optionalMember` come with member auth |
| Sessions | `services/auth/sessions.mjs` | Both realms: one row per device, refresh rotation with a 30 s grace, reuse revokes the session |
| Refresh cookies | `utils/cookies.mjs` | `a360_rt_staff` (`/api/v1/auth/studio`), `a360_rt_member` (`/api/v1/auth`) |
| Tokens | `utils/tokens.mjs` | 15-minute access JWT signed with the realm's own secret; `aud` = realm, `sid` = session, `client` = web or mobile |
| Rate limits | `utils/rateLimits.js` | Redis-backed. Add a public POST's path to `PUBLIC_RULES` |
| Realtime | `utils/sockets.js` | `/public`, `/member`, `/admin`. `invalidate`, `invalidateSite`, `invalidateMember`, emitted after commit and debounced 250 ms |
| Webhooks | `middleware/rawBody.mjs` (step 4) | Keeps the raw body so PesaPal, Apple, Google and video-provider signatures can be verified |
| Audit | `middleware/audit.mjs` + `services/system/audit.mjs` (step 6) | Every admin write: who, what, when |

## Adding an endpoint

1. Confirm the path and shape in `12-backend-integration.md` (change it there first if needed).
2. Add or extend the model in `schema.prisma`, then run `yarn prisma generate`.
3. Write the service function, then the zod schema, then the controller function, then the route.
4. If the routes file is new, add its line to `endpoints[]` in `api/v1/index.mjs`.
5. Document it in `swagger.yaml`.
6. Switch the client service from mock to HTTP.
# ArtistryServer
