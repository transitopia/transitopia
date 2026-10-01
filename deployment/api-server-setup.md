# Setting up the API server (api.transitopia.org)

One-time setup of the server's VM, the accounts it uses, and its first start. After this, the server
updates itself from `prod` (`.github/workflows/deploy_server.yml`); day-to-day operations are in
[README.md](README.md#the-server-apitransitopiaorg).

Commands marked **VM (root)** run as root on the VM, **VM (deploy)** as the `deploy` user, **Mac** on
your own machine in a checkout of this repo.

## 1. The VM

FullHost, Toronto: Ubuntu 26.04 LTS, 4 vCPU, 8 GB RAM, 100 GB storage. See
[README.md → Sizing](README.md#sizing): memory peaks around 2.5 GB, and 100 GB lasts about a year
before observed stop times need moving to object storage (V2-PLAN.md §4.4).

Keep Ubuntu's `unattended-upgrades` on (the default), so security updates install themselves.

## 2. Docker

Install Docker Engine and the Compose plugin from Docker's own apt repository, following
https://docs.docker.com/engine/install/ubuntu/ (not Ubuntu's `docker.io` package).

## 3. The deploy user and SSH keys

```sh
# VM (root)
useradd --create-home --shell /bin/bash --groups docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -m 600 -o deploy -g deploy /dev/null /home/deploy/.ssh/authorized_keys
install -d -o deploy -g deploy /opt/transitopia
```

Membership of the `docker` group makes `deploy` root-equivalent on this machine, as is usual for a
Docker deploy user.

Two keys go into `deploy`'s `authorized_keys`: yours, and one only for GitHub Actions.

```sh
# Mac
ssh-keygen -t ed25519 -N "" -C "transitopia deploy (GitHub Actions)" -f ~/.ssh/transitopia_deploy
cat ~/.ssh/transitopia_deploy.pub
```

Paste both public keys into `/home/deploy/.ssh/authorized_keys`.

Keep the private key `~/.ssh/transitopia_deploy` for the GitHub secrets (step 12).

## 4. Key-only SSH

Ensure your own public key is already set up on `root`.

Then make sure password logins are disabled. sshd uses the first value it reads, so a setting in
one config file can hide another; this prints the value in effect, which must be `no`:

```sh
# VM (root)
sshd -T | grep -i passwordauthentication
```

If it says `yes`, add `PasswordAuthentication no` in a file that sorts first (e.g.
`/etc/ssh/sshd_config.d/00-transitopia.conf`; Ubuntu's cloud images may ship
`50-cloud-init.conf` with `yes`), then `sshd -t && systemctl restart ssh`.

Note the host key's fingerprint, to check the GitHub secret against in step 12:

```sh
# VM (root)
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

## 5. Firewall

Docker's published ports (Caddy's 80 and 443) **bypass ufw**: Docker's own iptables rules come
first. So ufw guards SSH and the host, and rules in Docker's `DOCKER-USER` chain let only
Cloudflare reach the containers. (If FullHost's control panel has a network firewall in front of
the VM, you can use that for 80 and 443 instead; Docker can't bypass it.)

ufw, for SSH and the host itself:

```sh
# VM (root)
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw enable
```

Only Cloudflare may open connections to the containers: `infra/firewall/` in this repo. Containers'
own outgoing connections (TransLink, aisstream.io, R2) are unaffected, and if Cloudflare's lists
can't be fetched, the ports stay closed to everyone. Clone the repo (as `deploy`; step 10
configures it) and install the script and its service:

```sh
# VM (root)
sudo -u deploy git clone https://github.com/transitopia/transitopia.git /opt/transitopia
sudo -u deploy git -C /opt/transitopia checkout -q --detach origin/prod   # as deploys leave it
install -m 755 /opt/transitopia/infra/firewall/transitopia-firewall /usr/local/sbin/
install -m 644 /opt/transitopia/infra/firewall/transitopia-firewall.service /etc/systemd/system/
systemctl daemon-reload
```

The service applies the rules whenever Docker starts, including after a reboot. Test it with a
throwaway web server:

```sh
# VM (root)
docker run -d --rm -p 8080:80 --name fwtest nginx
```

1. From your Mac, `curl -m 5 http://<VM IP>:8080` shows nginx's page (the bypass is real).
2. Turn on the rules:

   ```sh
   # VM (root)
   systemctl enable --now transitopia-firewall
   iptables -L DOCKER-USER -n -v
   ```

3. From your Mac, `curl -m 5 http://<VM IP>:8080` now times out.
4. `docker stop fwtest`.

Cloudflare rarely changes its ranges; `systemctl restart transitopia-firewall` fetches them again.
After changing the files in `infra/firewall/`, install them again as above and restart the service.

## 6. Archive bucket (R2)

In Cloudflare R2, next to `transitopia-maps` and `transitopia-data`: a **private** bucket
`transitopia-archive` (no public access, no custom domain). It holds backups, the developer
snapshot, copies of closed recordings and every GTFS feed. Keeping backups with a different
provider from the VM means they survive anything that happens to the VM's account or data centre.

## 7. R2 tokens

R2 → Manage API tokens → Create API token:

- **For the server:** permission "Object Read & Write", applied to the buckets `transitopia-data`
  and `transitopia-archive` only. It publishes the transit data and writes the archive.
- **For developers' `npm run snapshot:pull`:** "Object Read only", `transitopia-archive` only.

Note each token's access key ID and secret access key, and the S3 endpoint
(`https://<account id>.r2.cloudflarestorage.com`). Check the server's token on your Mac, giving
rclone the same `r2` remote the server uses, through environment variables:

```sh
# Mac
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
  RCLONE_CONFIG_R2_ENDPOINT=https://<account id>.r2.cloudflarestorage.com \
  RCLONE_CONFIG_R2_ACCESS_KEY_ID=<key id> RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=<secret>
rclone copy README.md r2:transitopia-archive/test --s3-no-check-bucket
rclone ls r2:transitopia-archive
rclone purge r2:transitopia-archive/test
```

## 8. GitHub OAuth app

github.com → the `transitopia` organisation → Settings → Developer settings → OAuth Apps → New:

- Homepage URL: `https://www.transitopia.org`
- Authorization callback URL: `https://api.transitopia.org/auth/github/callback`

Note the client ID and generate a client secret.

## 9. Cloudflare

In the `transitopia.org` zone:

- **DNS:** `api` → the VM's IPv4 address, **proxied** (orange cloud). SSH and deploys use the IP
  directly; the proxy only carries HTTP.
- **SSL/TLS:** encryption mode **Full (strict)**. SSL/TLS → Origin Server → Create certificate,
  for `api.transitopia.org`, 15 years. Keep the certificate and private key for step 10 (the key is
  shown only once).
- **Caching → Cache Rules:** when hostname equals `api.transitopia.org` and URI path starts with
  `/rt/`: eligible for cache; edge TTL "Use cache-control header if present, bypass cache if not";
  **browser TTL "Respect origin TTL"**. (`/rt/live` sends 10 s, coverage and service changes 30 s,
  closed history hours a day, dispatch versions a year; Cloudflare doesn't cache JSON without a
  rule.) Without the browser TTL setting, Cloudflare tells browsers to keep every response for its
  default 4 hours, so the site keeps showing hours-old coverage, dispatch versions and AIS fixes.
  Check with `curl -sI https://api.transitopia.org/rt/coverage`: it must say `max-age=30`, not
  `14400`. Nothing else on `api.` is cached (`/healthz`, `/admin`, `/auth`).
- Optional: a rate-limiting rule for `api.transitopia.org`.

## 10. Configuration

The repo is in `/opt/transitopia` since step 5.

```sh
# VM (deploy)
cd /opt/transitopia
cp infra/.env.example infra/.env
chmod 600 infra/.env
install -d -m 700 infra/certs
nano infra/certs/origin.pem                   # the origin certificate from step 9
nano infra/certs/origin.key                   # its private key
chmod 600 infra/certs/*
```

Fill in `infra/.env`:

- A long random `POSTGRES_PASSWORD` (`openssl rand -hex 32`), `TRANSLINK_API_KEY`,
  `AISSTREAM_API_KEY`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (step 8), and
  `ADMIN_GITHUB_LOGINS`.
- The `RCLONE_CONFIG_R2_*` lines: the R2 endpoint and the server's token (step 7). The remote's
  name (`r2`) must match `DATA_PUBLISH_REMOTE` and `ARCHIVE_REMOTE`.

`infra/.env` and `infra/certs/` are gitignored.

## 11. First start

**Stop every other process polling with the same TransLink key first** (e.g. a local
`npm run server` with `.secrets`): the 1,000 requests a day are per key. Since Phase 2 a local
server doesn't poll unless `RT_POLL=1`.

1. Copy the local history, and the GTFS feeds it was recorded against, to the VM:

   ```sh
   # Mac, in the repo
   cd var && rsync -aR rt-history ais-history dispatch-history raw/gtfs deploy@<VM IP>:history/
   ```

2. Build the images and start the database:

   ```sh
   # VM (deploy)
   cd /opt/transitopia
   docker compose -f infra/compose.yml build
   docker compose -f infra/compose.yml up -d db
   ```

3. Import the history into the server's volume and the database (idempotent; about a minute for a
   few days):

   ```sh
   # VM (deploy)
   docker compose -f infra/compose.yml run --rm -v ~/history:/import:ro server \
     sh -c 'cp -r /import/. var/ && npm run db:import-history'
   ```

4. Start everything:

   ```sh
   # VM (deploy)
   docker compose -f infra/compose.yml up -d
   docker compose -f infra/compose.yml logs -f server
   ```

   On first start the server applies the migrations, imports the committed corrections, starts
   polling, and builds and publishes the transit data (a couple of minutes; it replaces what's on
   `data.transitopia.org` with the same build from this commit).

5. Check:

   ```sh
   # Mac
   curl https://api.transitopia.org/healthz          # {"ok":true,…}
   curl https://api.transitopia.org/rt/status        # leader: true, budget.used24h counting up
   curl -sI https://api.transitopia.org/rt/live      # cf-cache-status: HIT within 10 s of a MISS
   curl -m 5 -k https://<VM IP>/healthz              # times out: only Cloudflare gets through
   ```

   Sign in at https://www.transitopia.org/admin once the site is deployed (step 7 below), or from a
   local `npm run dev` with `VITE_TRANSIT_API=https://api.transitopia.org/` (localhost:5173 is in
   `ALLOWED_ORIGINS`).

6. Run a backup now and look at the bucket:

   ```sh
   # VM (deploy)
   docker compose -f infra/compose.yml run --rm backup /usr/local/bin/backup.sh --now
   ```

   ```sh
   # Mac
   rclone ls r2:transitopia-archive/backups
   ```

7. Deploy the site: merge `main` into `prod` and push. `apps/web/.env.production` sets
   `VITE_TRANSIT_API=https://api.transitopia.org/`, so buses go live on transitopia.org.

## 12. Automatic deploys

`deploy_server.yml` builds the image on every push to `prod` that touches the server's code and
restarts it on the VM once these repository secrets exist (GitHub → the repo → Settings → Secrets
and variables → Actions):

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the VM's IP address |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | the contents of `~/.ssh/transitopia_deploy` (step 3, the private key) |
| `DEPLOY_KNOWN_HOSTS` | the output of `ssh-keyscan -t ed25519 <VM IP>`; check its fingerprint matches step 4 |

The image goes to `ghcr.io/transitopia/transitopia-server`, which GitHub creates private. Either
make the package public (it contains no secrets), or let the VM read it:

```sh
# VM (deploy), with a GitHub token that has read:packages
docker login ghcr.io -u <your GitHub login>
```

## 13. Uptime monitor

Configure https://dashboard.uptimerobot.com/monitors to monitor `https://api.transitopia.org/healthz`
and `https://www.transitopia.org`.
