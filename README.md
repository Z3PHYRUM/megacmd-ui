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

- **MEGA downloads** — paste one or more Mega links and queue them all at once; its own transfer table (progress/speed/size) is built into the same panel
- **Base64 link decoding** — pasted links that turn out to be base64-encoded are transparently decoded; a decoded MEGA link is queued automatically, anything else is surfaced in a "Needs Attention" panel instead of silently failing
- **Folder file picker** — for `mega.nz/folder/` links, browse contents and select individual files before downloading; each file is individually paused the moment it's discovered so nothing transfers before you click "Download Selected," and only the files you actually picked are ever resumed — anything MEGAcmd discovers or queues for that folder afterward (including well after the picker closes, for very large folders) is cancelled instead of silently downloaded; files are listed alphabetically with a filter box to narrow a large folder down by name
- **Folder bookmarks** — star a folder from the file picker (yellow when bookmarked) to save it for revisiting later; a "★" button in the MEGA Downloads header lists bookmarked folders and re-opens the picker for one. Files already downloaded from a bookmarked folder are flagged "Downloaded" and start unchecked next time, so you can pull a huge folder down a few files at a time without re-picking the same ones
- **Bandwidth quota handling** — quota-exceeded downloads are automatically added to a retry queue and retried every 15 minutes
- **HTTP and Torrent Downloads section** — archive.org, direct HTTP(S), and magnet/torrent downloads all live in one panel since they share the same aria2 queue: an `archive.org` URL box (opens a file picker) and a paste box for direct URLs or magnet links (either box can be used independently), one shared transfer table below both
- **Archive.org downloads** — paste an `archive.org` item URL (either in that section or directly into the MEGA download queue), pick which files you want from a file picker, and queue them as downloads via aria2c
- **Torrent file picker** — magnet links pasted into the HTTP and Torrent Downloads paste box open a file picker once aria2 resolves the torrent's metadata, so you can select just the files you want before any data downloads (only magnet links are supported — no `.torrent` file upload)
- **YouTube downloads** — paste a `youtube.com`/`youtu.be` URL to download the video as the highest-quality mp4 available, via `yt-dlp`
- **YouTube playlist picker** — paste a playlist URL (one with a `list=` parameter) to open a picker listing every video in the playlist, so you can uncheck the ones you don't want before downloading. Kept videos are saved into a folder named after the playlist title, numbered in playlist order
- **Playlist progress expand** — a downloading/finished playlist job can be expanded to see each video's individual status and progress (read-only — Cancel still stops the whole playlist job, since it's one `yt-dlp` process)
- **Single shared destination** — one "Destination" field, in the Settings modal's General tab, sets the save path for every downloader (MEGA, archive.org, direct, torrents, and YouTube), with a "Browse…" button to navigate server-side folders instead of typing a path; remembered across reloads (browser `localStorage`)
- **Settings modal** — the gear icon in the top-right corner opens a modal with a General tab (destination) and a Notifications tab (per-event on/off toggles and an ntfy endpoint override, saved server-side in `settings.json`)
- **Collapsible sections** — each downloader panel can be collapsed via the arrow in its header to reduce clutter
- **Color-coded activity log** — MEGA, Archive.org, Direct, Torrent, and YouTube events each get their own accent color in the log (MEGA and YouTube's section headings match too); a bolder/saturated version of the same color marks a completed download, failures are always red
- **Stats bars** — each transfer table (MEGA, HTTP/Torrent, YouTube) shows a live summary (count by status, total size where known), with per-row and bulk pause/resume/cancel controls, auto-refreshing every 5 seconds
- **Scrollable transfer table** — the MEGA transfer table caps its height and scrolls internally (with a pinned header) instead of stretching the page, so a long list stays contained
- **Per-transfer controls** — pause, resume, or cancel individual transfers (MEGA and aria2); cancel or dismiss individual YouTube jobs
- **Bulk controls** — pause all, resume all, cancel all (MEGA and aria2 tables)
- **Activity log** — history of downloads, failures, and queue events (last 200 entries)
- **ntfy push notifications** — queued/completed/failed MEGA downloads, queued/completed archive.org downloads, and an "all queues finished" notification (fires once when every MEGA transfer, aria2 download, retry-queue item, and YouTube job has finished, polled every 15s so it fires even with the UI closed) send a push notification via [ntfy](https://ntfy.sh); each event type can be toggled independently in Settings → Notifications, and the ntfy endpoint can be overridden there too (falls back to `NTFY_URL` otherwise); best-effort, a failed ntfy call never affects downloads
- **Status bar** — shows MEGAcmd login status and the running app version at a glance
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
      - NTFY_URL=http://ntfy:2586/ultraframe

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
| `DATA_DIR` | `/data` | Path inside the container for `queue.json`, `activity.log`, `settings.json`, and `bookmarks.json` |
| `ARIA2_RPC_URL` | `http://aria2:6800/jsonrpc` | URL of the aria2 JSON-RPC endpoint, used for archive.org, direct, and torrent downloads |
| `ARIA2_RPC_SECRET` | *(empty)* | Shared secret for aria2 RPC auth — must match the `aria2` container's `RPC_SECRET` |
| `YTDLP_BIN` | `yt-dlp` | Path/name of the `yt-dlp` binary to invoke for YouTube downloads |
| `YTDLP_OUTPUT_DIR` | `/downloads/` | Directory `yt-dlp` writes finished videos to inside the container |
| `FS_BROWSE_ROOT` | `/downloads` | Root directory the Destination "Browse…" folder picker is allowed to list; navigation can't escape above this path |
| `NTFY_URL` | `http://ntfy:2586/ultraframe` | Default full URL (including topic) of the [ntfy](https://ntfy.sh) endpoint to POST push notifications to; overridable per-instance in Settings → Notifications (stored in `settings.json`, takes precedence when set) |

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

### Folder picker is slow or incomplete for very large folders

The folder file picker currently still has to ask MEGAcmd to actually enqueue the folder's contents to discover what's inside (each file is individually paused the instant it's discovered, so nothing downloads before you confirm — but MEGAcmd still has to enumerate every file). For folders with hundreds of subfolders, discovery can take a while, and the picker gives up waiting after 30 seconds — if that happens, the file list may be incomplete. This is safe either way: only the files you explicitly select are ever resumed. "Download Selected" responds immediately regardless of how many files you deselected — cleaning up everything else you didn't pick (potentially thousands of individual cancel commands for a huge folder) happens in the background over the following few minutes rather than blocking the button, so the transfer count in the main table may keep dropping for a bit after the picker closes rather than updating instantly. Internal discovery/cleanup queries look across up to 5000 transfers (separate from the 1000-row display cap on the main table), so a folder in the low thousands of files should be fully seen and tracked. If you hit an incomplete list, re-browsing the same folder link again (or picking it up from Bookmarks) will show whatever wasn't caught the first time. A future version may switch to a pure listing command (`mega-ls`) that doesn't touch the transfer queue at all, which would remove this limitation; that's not implemented yet — see the note in [Compatibility](#compatibility) about testing this on your MEGAcmd version.

If the cleanup never seems to happen at all (unwanted transfers just sit `PAUSED` indefinitely instead of disappearing), check `docker logs megacmd-ui` for `[BROWSE] postConfirmWatches sweep failed` — listing a very large transfer queue (`mega-transfers --limit=...`) can take longer than a generic command timeout would allow, silently failing the cleanup sweep every cycle. `mega-transfers` gets a 45s timeout specifically for this reason; if it's still not enough for your queue size, that's the number to raise (`EXEC_TIMEOUT` in `server.js`).

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

### ntfy notifications aren't arriving

Notifications are best-effort — a failed or unreachable ntfy endpoint is logged to the console (`[NTFY] ...`) and never blocks a download. Confirm the endpoint (Settings → Notifications, or `NTFY_URL` if left blank there) points to a reachable topic URL (e.g. `curl -d "test" $NTFY_URL` from inside the `megacmd-ui` container) and that the `ntfy` service is on the same Docker network. Also check that the relevant notification type isn't toggled off in Settings → Notifications.

### Destination "Browse…" button shows an error or empty list

The folder picker lists directories under `FS_BROWSE_ROOT` (default `/downloads`) from inside the `megacmd-ui` container's own filesystem — it needs that path to exist and be mounted (see the `/mnt/media1/downloads:/downloads` volume in [Requirements](#requirements)). If it errors, confirm the mount is present the same way as the YouTube troubleshooting step above (`docker inspect megacmd-ui`).

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

**Known gap, being investigated:** the folder picker (see [Troubleshooting](#folder-picker-is-slow-or-incomplete-for-very-large-folders)) currently discovers a folder's contents by actually enqueueing it rather than a pure listing call, because it's unconfirmed whether `mega-ls` can list a public folder link's contents on this MEGAcmd version without importing it first. If you can confirm `docker exec megacmd mega-ls -R "<a real mega.nz/folder/... link>"` works, that would unblock switching to a listing-only approach with no discovery timeout at all.

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Single HTML file — vanilla JS, no framework, no build step
- **npm dependencies:** `express`, `cors`, `dockerode`
- **External tools (baked into the image):** `yt-dlp`, `ffmpeg` (YouTube downloads); talks to a separate `aria2` container via JSON-RPC (archive.org/direct/torrent downloads)

## License

[MIT](LICENSE)
