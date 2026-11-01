# Load tests

`k6/collab.ts` and `k6/execution.js` are the tests for a deployed system. `local/collab.ts` drives
the same wire protocol from Node, which needs no k6, Docker or Redis, and produced the numbers in
[results/REPORT.md](results/REPORT.md).

## What has run

| Test | Status |
| --- | --- |
| Local driver against the real collab server | Run on one laptop, up to 10 rooms × 50 users |
| k6 collaboration test, 10 rooms × 50 users | Not run: k6 is not installed. The script bundles but has not executed |
| k6 execution test, 200 concurrent runs | Not run: it needs Docker, the sandbox images and a worker |

## How latency is measured

Each simulated typist writes the send time into the text it inserts. Every receiver finds that
stamp in the raw frame and subtracts it from the clock, without decoding the CRDT. Typists do not
apply each other's updates, so the load generator stays cheap and does not end up measuring itself.

Sender and receiver must share a clock, so run all k6 virtual users from one machine.

## Run the local test

```sh
cd loadtest
ROOMS=10 USERS=20 RATE=5 DURATION=30 OUTPUT=results/collab-local-r10-u20-k5.json pnpm local
pnpm report
```

Use a new `PORT` for each run. A run gives up 60 seconds after its planned end.

## Run k6 against a test deployment

Never point `seed` at production. It writes users straight into the database.

```sh
cd loadtest
DATABASE_URL=... COLLAB_TOKEN_SECRET=... ACCESS_TOKEN_SECRET=... pnpm seed
pnpm build:k6
k6 run -e COLLAB_URL=wss://host -e ORIGIN=https://host -e METRICS_URL=http://collab:4000/metrics dist/collab.js
k6 run -e API_URL=https://host k6/execution.js
pnpm report
```

Run both from a machine other than the server. The collaboration test sends about 125,000 messages
a second at full size, so give the load generator several cores. `METRICS_URL` must be reachable
from that machine, which usually means a private network or an SSH tunnel.

The execution test uses one user and one room per request, because the API limits runs per user and
per room. Those limits are not what it measures.
