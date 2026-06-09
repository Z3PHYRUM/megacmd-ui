# MEGAcmd UI

A minimal self-hosted web UI for managing MEGAcmd downloads. Runs as a Docker container alongside an existing `megacmd` container and communicates with it via `docker exec` over the Docker socket.

Designed for homelab use — accessed over Tailscale, no authentication required.

![Node 20](https://img.shields.io/badge/node-20--alpine-brightgreen)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![MEGAcmd 2.5.2.1](https://img.shields.io/badge/MEGAcmd-2.5.2.1-orange)

## Security

> **This tool has no authentication.** It is designed to run on a private network (e.g. Tailscale) only. **Do not expose port 8085 to the public internet** — anyone who can reach it can queue downloads, cancel transfers, and interact with your MEGAcmd instance.

> **The Docker socket mount grants significant host access.** Mounting `/var/run/docker.sock` allows the container to execute commands against any container on the host. This is the same tradeoff made by tools like Portainer. Only deploy this on a host you control and trust.

## Features

- **Download queue** — paste one or more Mega links, set a destination, queue them all at once
- **Transfer manager** — live table of active/queued/paused transfers, auto-refreshes every 5 seconds
- **Per-transfer controls** — pause, resume, or cancel individual transfers
- **Bulk controls** — pause all, resume all, cancel all
- **Status bar** — shows MEGAcmd login status at a glance
- **Dark theme** — mobile-friendly, no frameworks, no build step

## Requirements

- Docker with an existing `megacmd` container running
- The `megacmd` container name must be reachable via `docker exec` from within the `megacmd-ui` container

## Deployment

### 1. Clone the repo onto the server

```bash
git clone https://github.com/Z3PHYRUM/megacmd-ui.git /opt/docker/megacmd-ui
```

### 2. Add to your docker-compose file

```yaml
  megacmd-ui:
    build: /opt/docker/megacmd-ui
    container_name: megacmd-ui
    restart: unless-stopped
    ports:
      - "8085:8085"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - MEGACMD_CONTAINER=megacmd
      - DOWNLOAD_DEST=/downloads/
      - PORT=8085
```

### 3. Build and start

```bash
docker compose up -d --build megacmd-ui
```

Then open `http://<server-ip>:8085`.

### Updating

```bash
cd /opt/docker/megacmd-ui && git pull
cd /opt/docker/stack && docker compose up -d --build megacmd-ui
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MEGACMD_CONTAINER` | `megacmd` | Name of the MEGAcmd Docker container |
| `DOWNLOAD_DEST` | `/downloads/` | Default destination path inside the MEGAcmd container |
| `PORT` | `8085` | Port the UI listens on |

## Troubleshooting

### "docker: not found" in container logs

The Dockerfile installs `docker-cli` via apk, so this shouldn't happen on a fresh build. If you pulled an older image, rebuild:

```bash
docker compose up -d --build megacmd-ui
```

> **Note:** Bind-mounting the host Docker binary (`/usr/bin/docker:/usr/bin/docker:ro`) does not work — the host binary is dynamically linked and Alpine lacks the required libraries. Installing `docker-cli` via apk is the correct fix.

### Transfer table is empty or not parsing correctly

Run this on the host to see the raw output your MEGAcmd version produces:

```bash
docker exec megacmd mega-transfers --limit=5 --col-separator=|
```

The parser reads the header row dynamically, so as long as the columns include TAG, TYPE, FILENAME, TRANSFERRED, TOTAL, SPEED, PROGRESS, and STATE (in any order), it will work. If column names differ between versions, the header line from the above command will show exactly what names are in use.

### MEGAcmd shows "not logged in"

Log in from the host:

```bash
docker exec -it megacmd mega-login your@email.com
```

## Local Development

Run without Docker using mock data:

```bash
npm install
MOCK=1 node server.js
```

Open `http://localhost:8085`. In mock mode the server returns fake transfers covering all states (downloading, paused, queued, error, uploading) and actions like pause/resume/cancel update the in-memory state — so the UI is fully interactive without a real MEGAcmd instance.

## Compatibility

Tested with MEGAcmd **2.5.2.1**. The transfer parser uses `--col-separator=|` and reads column names from the header row, so it should adapt to other versions automatically. If you run a different version and hit parsing issues, open an issue with the output of `mega-transfers --limit=5 --col-separator=|`.

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Single HTML file — vanilla JS, no framework, no build step
- **Dependencies:** `express`, `cors` only

## License

[MIT](LICENSE)
