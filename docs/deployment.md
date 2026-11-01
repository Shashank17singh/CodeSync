# Deployment

This puts CodeSync on GitHub and online. Collaboration, chat, comments, history, sign-in and the
practice pages work on one server. **Running code, judging and AI review stay off** until a second
server exists, because sandboxes must never share a machine with the database, and the sandbox
attack suite has not passed yet. Those buttons show "Running code is turned off on this deployment".

Docker builds, Nginx and the compose files have never run. Expect to fix something on the first
deployment, and use `docker compose logs` to see what. See [Status](#status).

## 1. Push to GitHub

On your computer, from the repository root:

```sh
gh repo create codesync --private --source=. --push
```

Use `--public` instead if you want the code public. The history holds no secrets, but each commit
shows your Git email address. Check that you are happy with that before making it public.

Then open the repository's Actions tab. Fix whatever fails before deploying. These workflows run on
Linux for the first time here, so a failure would not be surprising:

| Workflow | Proves |
| --- | --- |
| CI | Lint, types, unit tests, browser tests, and it publishes the images |
| Integration | Real Redis, PostgreSQL 16, and the sandbox attack suite under gVisor |

## 2. Get a server and a domain

You need:

- A Linux server running Ubuntu 24.04, with at least 2 GB of memory and a public IP address.
- A domain or subdomain you control.
- SMTP details for sending mail. Without them nobody can verify a new account.

Hosts for static sites and serverless functions will not work. CodeSync needs long-lived WebSockets
and several running services.

## 3. Run the setup wizard

On the server:

```sh
git clone https://github.com/<owner>/codesync.git
cd codesync
sudo bash infra/deploy/setup-server.sh
```

For a private repository, sign in first with `gh auth login` or use a token in the clone URL.

The wizard checks your domain, installs Docker and Certbot, sets the firewall, generates secrets,
asks for mail details, gets a certificate and starts everything. Re-running it is safe, because it
keeps what is already in `.env.prod`.

## Update a running server

```sh
git pull
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env.prod pull
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env.prod up -d --no-build
```

If you build on the server instead, replace the last two commands with `up -d --build`.

Back up the database. It holds all code as well as accounts:

```sh
docker exec codesync-postgres-1 pg_dump -U codesync codesync | gzip > codesync-$(date +%F).sql.gz
```

Copy that file off the server. A backup on the same disk does not survive losing the server.

## Monitoring

```sh
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env.prod --profile monitoring up -d
```

Reach Grafana through an SSH tunnel, then open <http://localhost:3001>. The user is `admin`, and the
password is `GRAFANA_PASSWORD` in `.env.prod`.

```sh
ssh -L 3001:127.0.0.1:3001 user@your-server
```

## Turn on running code

Only do this after the Integration workflow's attack suite has passed under gVisor.

1. Get a second server on the same private network, with Docker and a recent gVisor (`runsc`).
   Register it with `sudo runsc install -- --oci-seccomp`, then restart Docker. Without that flag,
   gVisor ignores Docker's seccomp profile and programs can create user namespaces.
2. On it, clone the repository, run `services/executor/build-images.sh`, and start the worker:

   ```sh
   REDIS_URL=redis://:<REDIS_PASSWORD>@<app private IP>:6379 \
   API_URL=http://<app private IP>:3000 \
   INTERNAL_SERVICE_TOKEN=<same value as the app server> \
   PRIVATE_IP=<this server's private IP> \
   docker compose -f infra/compose/docker-compose.executor.yml up -d
   ```

3. On the application server, set `PRIVATE_IP` in `.env.prod`, and firewall ports 3000 and 6379 so
   that only the executor host can reach them. Then:

   ```sh
   docker compose -f infra/compose/docker-compose.prod.yml \
     -f infra/compose/docker-compose.executor-link.yml --env-file .env.prod up -d
   ```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Certificate stage fails | DNS does not point here yet, or port 80 is blocked by the provider's firewall |
| Nginx keeps restarting | No certificate for `DOMAIN`. Check `docker compose logs nginx` |
| Build is killed | Out of memory. Use prebuilt images, or add swap |
| `denied` when pulling images | Private repository: run `docker login ghcr.io` with a `read:packages` token |
| Sign-up mail never arrives | Check `SMTP_URL`, then `docker compose logs api` |
| Editor shows Reconnecting | Check `docker compose logs collab`. The origin must match `https://DOMAIN` |
| Certificate renewal fails | Run `certbot renew --dry-run`. If the wizard could not switch renewal to webroot, run `certbot reconfigure --cert-name <domain> --webroot --webroot-path /var/www/certbot` |

## Status

| Part | Status on 2026-11-01 |
| --- | --- |
| Fresh clone installs, builds, lints and type-checks | Tested on Windows |
| Packaged API starts | Tested without Docker |
| Production bundle under the Nginx security policy | Tested in a browser |
| Nginx configuration syntax | Parsed by a tool, never loaded by Nginx |
| Compose and workflow files | Parsed as YAML, never run |
| Docker images, certificate steps, setup wizard | Never run |
