# Execution service

Runs untrusted code in disposable containers. This is the library and CLI. The queue
that feeds it arrives with step 3.6.

Written in Python because BullMQ has official Node and Python clients but no official Go client.

## Security status

**The attack suite has not been run yet.** It needs a Linux host with real Docker. Until
`sandbox-report.md` exists from a real run, treat this sandbox as unproven and do not run untrusted
code with it.

Without Docker, `pytest -m docker` reports `skipped`. Skipped does not mean contained.

## Run it

Python 3.12 is required.

```sh
python -m venv .venv
.venv/bin/pip install -e '.[dev]'
sh build-images.sh

.venv/bin/pytest -m "not docker"   # no Docker needed
.venv/bin/pytest -m docker -s      # attack suite, writes sandbox-report.md
python -m executor.cli request.json
```

`.github/workflows/integration.yml` runs the attack suite on both `runc` and gVisor.

## How a run works

1. Take a started container from the pool, or create one. Each container is used once.
2. Write the source files and stdin into `/tmp/work`. They go through `tar` on an exec's stdin,
   because `docker cp` cannot write to a tmpfs and the root filesystem is read-only.
3. Compile if the language needs it, then run with stdin redirected from a file.
4. Stream output to the room while keeping it under the 64 KB cap.
5. Classify the result and destroy the container.

All timing and kills happen in the worker. A program cannot extend its own limit, and a kill stops
the whole container, so forked children cannot outlive it.

## Isolation

Every setting is in `src/executor/container_spec.py` so that it can be reviewed in one place:

| Setting | Value | Stops |
| --- | --- | --- |
| Runtime | gVisor (`runsc`) when installed | Kernel exploits, as syscalls hit a user-space kernel |
| Network | `none` | Exfiltration, attacks on internal services |
| Root filesystem | Read-only | Tampering with the image |
| `/tmp` | 64 MB tmpfs, `nosuid,nodev` | Disk filling, setuid tricks |
| User | `10001:10001` | Root inside the container |
| Capabilities | All dropped | Privileged kernel operations |
| `no-new-privileges` | On | Gaining privileges through setuid binaries |
| Seccomp | Docker's default profile | Dangerous syscalls |
| PIDs | 64 | Fork bombs |
| Memory | 256 MB, no swap | Memory bombs, host swapping |
| CPU | 1 core | CPU starvation |
| Time | 10 s compile, 5 s run | Infinite loops, sleeping forever |
| Output | 64 KB | Memory exhaustion in the worker |
| Core dumps, open files | 0, 256 | Disk filling, descriptor exhaustion |
| Daemon logs | Off | Filling the host's disk through container logs |

Set `SANDBOX_REQUIRE_GVISOR=true` in production, so a host without gVisor refuses to start instead
of quietly running on a weaker boundary.

Never run this service on the same machine as the database. It holds access to the Docker socket,
which is equivalent to root on its host.

## Status meanings

| Status | Meaning |
| --- | --- |
| `OK` | Exit code 0 |
| `COMPILE_ERROR` | The compiler failed or passed 10 seconds |
| `RUNTIME_ERROR` | Nonzero exit, not explained by a limit |
| `TIME_LIMIT_EXCEEDED` | Passed the run limit |
| `MEMORY_LIMIT_EXCEEDED` | cgroup out-of-memory kill, or the runtime reported its heap was full |
| `OUTPUT_LIMIT_EXCEEDED` | Passed 64 KB across stdout and stderr |
| `INTERNAL_ERROR` | The sandbox failed. Users see a generic message, and detail goes to logs |

## Known limits

- Time is wall-clock, measured by the worker, and includes a little exec overhead. Step 3.7 may
  need CPU time for fair judging.
- Memory comes from cgroup v2. gVisor may not expose those files, in which case `memory_kb` is empty
  and an unexplained SIGKILL is reported as a memory limit. Check this on the first gVisor run.
- A background process holding stdout open makes a run wait until the time limit.
- Java classes must match their path: `com/acme/App.java` runs `com.acme.App`.
- Interactive stdin, a stretch goal, is not built. Stdin is supplied once, up front.
