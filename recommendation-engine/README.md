# Personalized Recommendation Engine

Production-grade backend module for the **AI-Assisted Proctored Learning & Assessment Platform**. Analyzes a student's post-test performance at the subtopic level, identifies weak areas, and serves targeted, non-repetitive practice questions with an instant-load Redis-cached read path.

---

## 1. Architecture & Folder Structure

```
recommendation-engine/
├── prisma/
│   └── schema.prisma                     # Maps to EXISTING tables (topics, subtopics, questions, test_responses)
├── src/
│   ├── config/
│   │   ├── prisma.js                     # Prisma client singleton (prevents connection-pool exhaustion)
│   │   ├── redis.js                      # ioredis client (cache) + BullMQ connection config
│   │   └── recommendation.config.js      # All tunable thresholds (accuracy %, TTLs, counts) — single source of truth
│   │
│   ├── db/
│   │   └── recommendation.queries.js     # Raw data-access layer: accuracy aggregation, dedup question fetches. No business logic.
│   │
│   ├── services/
│   │   ├── recommendation.service.js     # CORE LOGIC: weakness analysis, difficulty scaling, selection, orchestration
│   │   └── recommendation.cache.js       # Redis key conventions + get/set/invalidate wrappers
│   │
│   ├── queues/
│   │   └── recommendation.queue.js       # BullMQ Queue definition + enqueue helper
│   │
│   ├── workers/
│   │   └── recommendation.worker.js      # BullMQ Worker — consumes jobs, runs the async calculation, writes to Redis
│   │
│   ├── controllers/
│   │   ├── recommendation.controller.js  # GET /api/recommendations handler
│   │   └── testSubmission.controller.js  # Example integration point for POST /api/tests/submit
│   │
│   ├── middleware/
│   │   ├── validate.middleware.js        # Lightweight input validation (UUID checks, body shape)
│   │   └── errorHandler.middleware.js    # Centralized error handler
│   │
│   ├── routes/
│   │   └── recommendation.routes.js      # Express router wiring
│   │
│   ├── utils/
│   │   └── difficulty.util.js            # Pure function: accuracy % -> difficulty tier
│   │
│   ├── app.js                            # Standalone Express app (for isolated running/testing)
│   └── server.js                         # API process entrypoint
│
├── tests/
│   ├── setup.jest.js                     # Mocks ioredis so unit tests never hit real network
│   ├── difficulty.util.test.js           # Unit tests: pure difficulty-scaling logic
│   └── recommendation.service.test.js    # Unit tests: service layer with mocked DB/cache
│
├── .env.example
├── jest.config.js
├── package.json
└── README.md
```

### Why this structure

- **`db/` vs `services/` separation**: `recommendation.queries.js` knows *how* to fetch/aggregate data but makes zero business decisions (no thresholds, no difficulty logic). `recommendation.service.js` knows the *rules* (what counts as "weak," which difficulty to serve) but never writes raw SQL directly. This means you can unit-test the service layer by mocking the query layer — which is exactly what `tests/recommendation.service.test.js` does — without needing a live Postgres connection.
- **`queues/` vs `workers/` separation**: The queue module is imported by the API process (to *enqueue*). The worker module is a separate consumer process (to *process*). This mirrors how you'd deploy them in production — API pods never run job processing in-process.
- **Config centralization**: Every magic number (60% weak threshold, 40/75 difficulty bands, 30-day exhaustion window, cache TTLs) lives in `recommendation.config.js`. Product/pedagogy teams will want to tune these — you want that to be a one-file diff, not a grep-and-replace across the codebase.

---

## 2. Core Logic Walkthrough

### Weakness detection (`computeWeakSubtopics`)
1. Runs a single grouped SQL aggregation (`getSubtopicAccuracyForStudent`) computing `accuracy = correct/total * 100` per subtopic, using the existing `test_responses(student_id, subtopic_id)` index.
2. Filters to subtopics with `accuracy < 60` (configurable via `WEAK_ACCURACY_THRESHOLD`) and at least 1 recorded attempt.
3. Sorts ascending by accuracy (weakest first) and caps at the **3** weakest (`MAX_WEAK_SUBTOPICS`). If fewer than 2–3 subtopics genuinely qualify, we return however many actually do — the engine never manufactures false weaknesses to hit a quota.

### Difficulty scaling (`resolveDifficultyForAccuracy`)
A pure, independently-unit-tested function:

| Accuracy | Difficulty |
|---|---|
| `< 40%` | `EASY` |
| `40% – 75%` | `MEDIUM` |
| no data | `MEDIUM` (neutral default) |

### Question selection & exhaustion safety (`selectQuestionsForWeakSubtopics`)
For each weak subtopic, the engine:
1. Fetches recently-attempted question IDs (last 30 days, configurable) and excludes them.
2. Distributes the total **5** recommendations across the weak subtopics as evenly as possible (e.g., 3 weak subtopics → `[2, 2, 1]`).
3. **Primary attempt**: unattempted questions at the subtopic's scaled difficulty.
4. **Secondary attempt**: if `EASY` came up short, relax to `MEDIUM` within the *same subtopic* first (more targeted than jumping straight to topic fallback).
5. **Tertiary attempt (exhaustion fallback)**: if the subtopic is still short, fall back to the **parent topic**, pulling from sibling subtopics, preferring the original difficulty via `ORDER BY (difficulty = preferred) DESC, RANDOM()`.

### Cold-start (`buildColdStartRecommendations`)
For students with zero `test_responses` rows: samples 5 random top-level topics and pulls a random `EASY`/`MEDIUM` mix from each via a single `LATERAL JOIN` query (avoids N+1 round trips), then trims to 5 total.

### Cache-then-DB read path (`getRecommendations`)
```
GET /api/recommendations
   │
   ▼
Redis GET reco:questions:<studentId>
   │
   ├── HIT  → return immediately (source: "CACHE")
   │
   └── MISS → determine cold-start vs. personalized vs. no-weakness
              → compute synchronously
              → write back to Redis (self-healing cache)
              → return (source: "DB_FALLBACK")
```

---

## 3. Async Processing Flow (BullMQ)

```
POST /api/tests/submit
   │
   ├── 1. Persist test_responses rows (existing platform logic)
   ├── 2. enqueueRecommendationRecalculation(studentId)  ◄── ONE LINE, non-blocking
   └── 3. Respond 201 to client immediately
                                          │
                                          ▼
                     ┌─────────────────────────────────────┐
                     │  BullMQ Queue: recommendation-calc   │
                     │  jobId = "recalc:<studentId>"        │
                     │  (built-in de-dupe for rapid re-      │
                     │   submits — a still-waiting job with  │
                     │   the same id is not duplicated)      │
                     └───────────────┬───────────────────────┘
                                      ▼
                     ┌─────────────────────────────────────┐
                     │  Worker Process (separate from API)  │
                     │  1. Invalidate old cache               │
                     │  2. computeWeakSubtopics()             │
                     │  3. selectQuestionsForWeakSubtopics()  │
                     │  4. Write BOTH weak-subtopics AND      │
                     │     final question payload to Redis    │
                     └─────────────────────────────────────┘
```

**Why a dedicated worker process, not `setImmediate`/in-process async?**
Running the worker as its own process (own container/PM2 entry) means:
- The API's event loop is never blocked by aggregation queries, even under load spikes (e.g., end-of-week test submission rush).
- You can scale worker concurrency independently of API replica count.
- A worker crash/restart doesn't take down the API.

---

## 4. Setup Instructions (Local, from Zero)

You have no backend or database running yet — this section takes you from an empty machine to a fully working, testable module using Docker for Postgres/Redis and Prisma migrations to create the tables.

### Prerequisites
- Node.js ≥ 18
- Docker Desktop (or Docker Engine + Compose) — this gives you Postgres and Redis with no manual installs

### Step-by-step

```bash
# 1. Install dependencies
cd recommendation-engine
npm install

# 2. Start Postgres + Redis locally via Docker
docker compose up -d
docker ps   # confirm reco-postgres and reco-redis are both "Up"

# 3. Configure environment
cp .env.example .env
```

Edit `.env` to match the credentials Docker just created (already the default in `.env.example`):

```dotenv
PORT=4000
NODE_ENV=development

DATABASE_URL="postgresql://reco_user:reco_pass@localhost:5432/reco_db?schema=public"
REDIS_URL="redis://localhost:6379"

RECO_WORKER_CONCURRENCY=5
```

```bash
# 4. Generate the Prisma client
npx prisma generate

# 5. Create the actual database tables from schema.prisma
#    (this is the step that matters when starting from zero — it runs a
#    real migration against your fresh local Postgres and creates
#    topics / subtopics / questions / test_responses)
npx prisma migrate dev --name init

# 6. Seed sample data (topics, subtopics, questions, and test history
#    for one "weak" student + one "new" student with no history)
npx prisma db seed

# 7. Run the API process
npm run dev

# 8. In a SEPARATE terminal, run the worker
npm run worker:dev
```

### Try it immediately

The seed script prints two ready-to-use student IDs. With the API running:

```bash
curl "http://localhost:4000/api/recommendations?studentId=11111111-1111-1111-1111-111111111111"
# -> personalized recommendations (this student is seeded weak in Algebra + Trigonometry)

curl "http://localhost:4000/api/recommendations?studentId=22222222-2222-2222-2222-222222222222"
# -> cold-start baseline (this student has zero test history)
```

To simulate a real test submission and watch the async recalculation run:
```bash
curl -X POST http://localhost:4000/api/tests/submit \
  -H "Content-Type: application/json" \
  -d '{
    "studentId": "11111111-1111-1111-1111-111111111111",
    "testId": "33333333-3333-3333-3333-333333333333",
    "responses": [
      { "questionId": "<copy a real question id from prisma studio>", "subtopicId": "<matching subtopic id>", "isCorrect": false }
    ]
  }'
```
Watch the worker terminal — you'll see it pick up the job and log the recomputed weak subtopics within a second or two. Use `npx prisma studio` (opens a local DB browser at `http://localhost:5555`) to grab real question/subtopic IDs for testing.

### Later: pointing this at a real/existing platform database
Once your team's actual platform backend exists, skip steps 5–6 above (`migrate` + `seed` are for local testing only) and instead run `npx prisma db pull` to confirm the schema matches the real tables, per the "Integrating into the Existing Application" section below.

### Required environment variables

| Variable | Description | Example |
|---|---|---|
| `PORT` | API server port | `4000` |
| `NODE_ENV` | `development` \| `production` | `production` |
| `DATABASE_URL` | Postgres connection string | `postgresql://reco_user:reco_pass@localhost:5432/reco_db?schema=public` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `RECO_WORKER_CONCURRENCY` | Concurrent jobs the worker processes at once | `5` |

---

## 5. Integrating into the Existing Application

This module is designed to **drop into** your existing Express monorepo with minimal footprint. You do **not** need to run `app.js`/`server.js` from this module in production if you already have an Express app — instead:

### Step A — Mount the read route
In your existing app's route index (e.g. `src/routes/index.js`):
```js
const recommendationRoutes = require('<path-to-this-module>/src/routes/recommendation.routes');
app.use('/api', recommendationRoutes); // exposes GET /api/recommendations
```
Or, more surgically, just import the controller directly and wire your own route:
```js
const { getRecommendationsHandler } = require('<path>/controllers/recommendation.controller');
router.get('/recommendations', authMiddleware, getRecommendationsHandler);
```

### Step B — Hook into your EXISTING `POST /api/tests/submit`
This is the only required change to your current test-submission code. After your existing logic commits `test_responses` rows, add:

```js
const { enqueueRecommendationRecalculation } = require('<path>/queues/recommendation.queue');

// ... inside your existing submit handler, after test_responses are saved:
await enqueueRecommendationRecalculation(studentId, { testId });
```

That's it — one import, one function call, non-blocking. Do **not** `await` anything after it that depends on the recommendation calculation being finished; the whole point is that it runs out-of-band.

### Step C — Deploy the worker
Add a new process/container to your deployment (PM2 ecosystem file, Docker Compose service, or K8s Deployment) running:
```bash
node src/workers/recommendation.worker.js
```
This must run continuously alongside your API — it's a long-lived consumer, not a cron job.

### Step D — Share Prisma / DB connection strategy
If your platform already uses Prisma with a schema covering `topics`/`subtopics`/`questions`/`test_responses`, **skip `prisma/schema.prisma` in this module entirely** and instead point `src/config/prisma.js` at your existing generated client:
```js
// Replace the contents of src/config/prisma.js with:
module.exports = require('<your-existing-prisma-client-path>');
```
If your platform uses raw `pg` or another ORM instead of Prisma, only `src/db/recommendation.queries.js` needs rewriting — the service/controller/worker/queue layers are DB-client-agnostic and will work unchanged as long as the query functions preserve their return shapes.

---

## 6. API Reference

### `GET /api/recommendations?studentId=<uuid>`
Also accepts an authenticated `req.user.id` if your auth middleware sets it (preferred over the query param in production).

**Response 200:**
```json
{
  "success": true,
  "data": {
    "studentId": "uuid",
    "mode": "PERSONALIZED",      // PERSONALIZED | COLD_START | BASELINE_NO_WEAKNESS
    "weakSubtopics": [
      {
        "subtopicId": "uuid",
        "subtopicName": "Quadratic Equations",
        "topicId": "uuid",
        "topicName": "Algebra",
        "accuracyPct": 33.33,
        "totalAttempts": 6,
        "correctAttempts": 2,
        "recommendedDifficulty": "EASY"
      }
    ],
    "questions": [
      {
        "id": "uuid",
        "subtopicId": "uuid",
        "difficulty": "EASY",
        "questionText": "...",
        "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
        "sourceSubtopicId": "uuid",
        "sourceSubtopicName": "Quadratic Equations",
        "reason": "Weak area: Quadratic Equations (33.33% accuracy)"
      }
    ],
    "generatedAt": "2026-08-23T10:00:00.000Z",
    "source": "CACHE"            // CACHE | DB_FALLBACK
  }
}
```

Note: `correct_option` is **never** included in the response payload — the query layer explicitly excludes it.

### `POST /api/tests/submit` (example integration route)
See `src/controllers/testSubmission.controller.js` — this is a reference implementation showing where the enqueue call belongs. In your real app this logic lives in your existing controller.

---

## 7. Testing

```bash
npm test
```

Runs Jest unit tests covering:
- `difficulty.util.test.js` — pure difficulty-scaling boundary conditions (39.99 vs 40, 75 vs 75.01, null/NaN handling)
- `recommendation.service.test.js` — weakness filtering/sorting/capping, even distribution of question counts, exhaustion → topic fallback, cache-hit vs. cache-miss read paths

Unit tests mock the DB (`recommendation.queries.js`) and cache (`recommendation.cache.js`) modules entirely — they run in milliseconds with **no live Postgres/Redis required** (`ioredis` itself is mocked in `tests/setup.jest.js`).

**For integration testing** against real Postgres/Redis (recommended before production deploy), spin up:
```yaml
# docker-compose.test.yml (not included — add per your infra conventions)
services:
  postgres-test: ...
  redis-test: ...
```
and point `.env.test` at those instances, then write a small integration suite hitting `recomputeAndCache` and `getRecommendations` end-to-end against seeded data.

---

## 8. Performance & Scaling Notes

- **Read path (`GET /api/recommendations`)** is O(1) Redis GET on cache hit — this is the common case and what makes dashboard load instant.
- **Write path** (post-submission) is fully decoupled via BullMQ; the HTTP response to `POST /api/tests/submit` never waits on aggregation.
- **Job de-duplication**: rapid consecutive submissions from the same student use a deterministic `jobId` (`recalc:<studentId>`) so BullMQ won't stack redundant recompute jobs while one is still queued.
- **SQL efficiency**: the accuracy aggregation and cold-start sampling both run as single round-trip queries (`GROUP BY` and `LATERAL JOIN` respectively) rather than N+1 patterns, and both lean on the indexes specified in the schema (`test_responses(student_id, subtopic_id)`, `questions(subtopic_id, difficulty)`).
- **Self-healing cache**: on a cache miss, the read endpoint recomputes synchronously *and* repopulates Redis, so a Redis flush or TTL expiry never leaves the system permanently degraded — worst case is one slow request per student until the cache warms again.
