# Load test results

## Collaboration, k6

Not run yet. See loadtest/README.md.

## Collaboration, local Node driver, by scale

One laptop, load generator and server on the same machine, in-memory stand-in for Redis and PostgreSQL.

Machine: Intel(R) Core(TM) i5-10210U CPU @ 1.60GHz, 8 logical cores, 7.8 GB RAM.

| Rooms | Users | Keys/s each | p50 ms | p95 ms | p99 ms | Max ms | Delivered | Server CPU avg | Server RSS peak |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 20 | 3 | 1 | 2 | 3 | 27 | 100% | 4.0% | 102.0 MB |
| 5 | 100 | 3 | 3 | 9 | 13 | 79 | 100% | 18.1% | 140.8 MB |
| 10 | 500 | 1 | 12 | 39 | 71 | 134 | 100% | 50.9% | 154.9 MB |
| 10 | 200 | 5 | 16 | 317 | 685 | 915 | 100% | 75.6% | 229.4 MB |

Each row is a single run. CPU is a percentage of one core. The 10 rooms × 50 users run at 5 keys/s did not finish: it asks
for about 122,500 deliveries a second, which one Node process cannot generate and absorb, so
there is no measurement for that row. Only the k6 test from a separate machine can answer it.

## Execution, k6

Not run yet. It needs Docker, the sandbox images and a worker. See loadtest/README.md.

