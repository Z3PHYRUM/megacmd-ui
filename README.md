# MEGAcmd UI

> **⚠️ Alpha software.** This project is under active development. Expect rough edges, breaking changes, and incomplete features. Use at your own risk.

A minimal self-hosted web UI for managing MEGAcmd downloads. Runs as a Docker container alongside an existing `megacmd` container and communicates with it via `docker exec` over the Docker socket.

Designed for homelab use — accessed over Tailscale, no authentication required.

![Alpha](https://img.shields.io/badge/status-alpha-red)
![Node 20](https://img.shields.io/badge/node-20--alpine-brightgreen)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![MEGAcmd 2.5.2.1](https://img.shields.io/badge/MEGAcmd-2.5.2.1-orange)

## Security

> **This tool has no authentication.** It is designed to run on a private network (e.g. Tailscale) only. **Do not expose port 8085 to the public internet** — anyone who can reach it can queue downloads, cancel transfers, and interact with your MEGAcmd instance.

> **The Docker socket mount grants significant host access.** Mounting `/var/run/docker.sock` allows the container to execute commands against any container on the host. This is the same tradeoff made by tools like Portainer. Only deploy this on a host you control and trust.

## Features

- **Download queue** — paste one or more Mega links, set a destination, queue them all at once
- **Base64 link decoding** — pasted links that turn out to be base64-encoded are transparently decoded; a decoded MEGA link is queued automatically, anything else is surfaced in a "Needs Attention" panel instead of silently failing
- **Folder file picker** — for `mega.nz/folder/` links, browse contents and select individual files before downloading
- **Bandwidth quota handling** — quota-exceeded downloads are automatically added to a retry queue and retried every 15 minutes
- **Transfer manager** — live table of active/queued/paused MEGA transfers with progress, speed, and size; auto-refreshes every 5 seconds
- **Archive.org downloads** — paste an `archive.org` item URL (either in the dedicated box or directly into the main download queue), pick which files you want from a file picker, and queue them as downloads via aria2c
- **Direct downloads** — paste arbitrary HTTP(S) URLs or magnet links and queue them via aria2c
- **Torrent file picker** — magnet links open a file picker once aria2 resolves the torrent's metadata, so you can select just the files you want before any data downloads
- **YouTube downloads** — paste a `youtube.com`/`youtu.be` URL to download the video as the highest-quality mp4 available, via `yt-dlp` (single video only for now, no playlist support yet)
- **aria2 downloads table** — second transfer table for archive.org, direct, and torrent downloads, with the same per-row and bulk pause/resume/cancel controls, auto-refreshing every 5 seconds
- **Per-transfer controls** — pause, resume, or cancel individual transfers (MEGA and aria2); cancel or dismiss individual YouTube jobs
- **Bulk controls** — pause all, resume all, cancel all (MEGA and aria2 tables)
- **Activity log** — history of downloads, failures, and queue events (last 200 entries)
- **Status bar** — shows MEGAcmd login status at a glance
- **Dark theme** — mobile-friendly, no frameworks, no build step

## Requirements

- Docker with an existing `megacmd` container running
- The `megacmd` container name must be reachable via `docker exec` from within the `megacmd-ui` container
- An `aria2` container with RPC enabled, reachable from `megacmd-ui` (required for archive.org, direct, and torrent downloads — see [docker-compose.yml](docker-compose.yml) for a ready-to-use `aria2` service definition using `p3terx/aria2-pro`)
- `megacmd-ui` and `aria2` should share the same host downloads directory (e.g. both mounting `/mnt/media1/downloads:/downloads`) so YouTube downloads (written directly by `yt-dlp` inside the `megacmd-ui` container) land in the same place as MEGA/aria2 downloads. `yt-dlp` and `ffmpeg` are already baked into the `megacmd-ui` image — no extra container needed.

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
      - /mnt/media1/downloads:/downloads
    environment:
      - MEGACMD_CONTAINER=megacmd
      - DOWNLOAD_DEST=/downloads/
      - PORT=8085
      - ARIA2_RPC_URL=http://aria2:6800/jsonrpc
      - ARIA2_RPC_SECRET=${ARIA2_RPC_SECRET}

  aria2:
    image: p3terx/aria2-pro
    container_name: aria2
    restart: unless-stopped
    ports:
      - "6800:6800"
    volumes:
      - /opt/docker/aria2:/config
      - /mnt/media1/downloads:/downloads
    environment:
      - PUID=1000
      - PGID=1000
      - RPC_SECRET=${ARIA2_RPC_SECRET}
      - RPC_PORT=6800
```

`ARIA2_RPC_SECRET` must be the same value on both services — set it once, e.g. in a `.env` file next to your compose file. See [docker-compose.yml](docker-compose.yml) in this repo for the full reference definition.

**After the first `docker compose up -d aria2`:** the image writes a default `aria2.conf` into the mounted `/opt/docker/aria2` volume. Edit that file on the host and add:

```
max-concurrent-downloads=1
```

then `docker compose restart aria2`. This makes archive.org downloads happen strictly one at a time — there's no environment variable for this setting on the `p3terx/aria2-pro` image, it has to go in the conf file.

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
| `PORT` | `8085` | Port the UI listens on |
| `RETRY_INTERVAL_MIN` | `15` | Minutes between retry queue attempts for quota-exceeded downloads |
| `DATA_DIR` | `/data` | Path inside the container for `queue.json` and `activity.log` |
| `ARIA2_RPC_URL` | `http://aria2:6800/jsonrpc` | URL of the aria2 JSON-RPC endpoint, used for archive.org, direct, and torrent downloads |
| `ARIA2_RPC_SECRET` | *(empty)* | Shared secret for aria2 RPC auth — must match the `aria2` container's `RPC_SECRET` |
| `YTDLP_BIN` | `yt-dlp` | Path/name of the `yt-dlp` binary to invoke for YouTube downloads |
| `YTDLP_OUTPUT_DIR` | `/downloads/` | Directory `yt-dlp` writes finished videos to inside the container |

## Troubleshooting

### Docker connectivity issues

The server communicates with MEGAcmd via the [dockerode](https://github.com/apocas/dockerode) npm package, which talks to the Docker socket directly using the Docker API — no `docker` binary required inside the container. If you see socket errors in the logs, confirm the volume mount is present:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

Then rebuild: `docker compose up -d --build megacmd-ui`

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

### aria2 / archive.org downloads aren't working

The aria2 table will show an error and archive.org downloads will fail to queue if the backend can't reach aria2's RPC endpoint. Check:

- `ARIA2_RPC_URL` on `megacmd-ui` and `RPC_SECRET`/`ARIA2_RPC_SECRET` on both services match.
- The `aria2` container is up: `docker logs aria2`.
- RPC is actually reachable, tested independently of the UI:

  ```bash
  curl -X POST http://<aria2-host>:6800/jsonrpc \
    -d '{"jsonrpc":"2.0","id":"t","method":"aria2.getVersion","params":["token:YOUR_SECRET"]}'
  ```

If downloads queue but several run at once instead of one at a time, `max-concurrent-downloads=1` likely isn't set in `aria2.conf` yet — see the note in [Deployment](#2-add-to-your-docker-compose-file).

### Torrent picker times out or never shows files

The torrent file picker has to wait for aria2 to resolve the magnet link's metadata (the file list) before it can show anything, which needs at least one reachable peer or working tracker/DHT. It gives up after 30 seconds. If this happens consistently, check `docker logs aria2` for DHT/tracker connectivity issues — a dead magnet (no seeds) will always time out.

### YouTube downloads fail immediately

Confirm `yt-dlp` and `ffmpeg` are present in the running container:

```bash
docker exec megacmd-ui yt-dlp --version
docker exec megacmd-ui ffmpeg -version
```

If either is missing, rebuild the image (`docker compose up -d --build megacmd-ui`) — they're installed in the `Dockerfile` and won't appear after a plain restart. YouTube frequently changes its site in ways that break older `yt-dlp` releases; if downloads that used to work start failing, rebuilding to pick up a newer `yt-dlp` from PyPI is usually the fix.

## Local Development

Run without Docker using mock data:

```bash
npm install
MOCK=1 node server.js
```

Open `http://localhost:8085`. In mock mode the server returns fake MEGA transfers covering all states (downloading, paused, queued, error, uploading) and actions like pause/resume/cancel update the in-memory state — so the MEGA side of the UI is fully interactive without a real MEGAcmd instance.

The archive.org, aria2, torrent, and YouTube features are **not mocked**: `/api/archive/browse` always calls the real (public, read-only) archive.org API even under `MOCK=1`, the aria2/torrent endpoints require a real, reachable aria2 container, and YouTube downloads spawn a real `yt-dlp` process — you'll need `yt-dlp` and `ffmpeg` on your `PATH` to test that locally outside Docker. There's no local-dev fallback for any of these yet.

## Compatibility

Tested with MEGAcmd **2.5.2.1**. The transfer parser uses `--col-separator=|` and reads column names from the header row, so it should adapt to other versions automatically. If you run a different version and hit parsing issues, open an issue with the output of `mega-transfers --limit=5 --col-separator=|`.

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Single HTML file — vanilla JS, no framework, no build step
- **npm dependencies:** `express`, `cors`, `dockerode`
- **External tools (baked into the image):** `yt-dlp`, `ffmpeg` (YouTube downloads); talks to a separate `aria2` container via JSON-RPC (archive.org/direct/torrent downloads)

## License

[MIT](LICENSE)
