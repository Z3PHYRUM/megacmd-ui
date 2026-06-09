# MEGAcmd Web UI — Build Prompt

## Overview
Build a minimal self-hosted web UI for managing MEGAcmd downloads. It runs as a Docker container alongside an existing `megacmd` container on an Ubuntu 26.04 server. The UI communicates with MEGAcmd by running `docker exec megacmd mega-*` commands via the Docker socket. It is accessed exclusively over Tailscale (private network) so no authentication is required.

---

## Tech Stack
- **Backend:** Node.js with Express
- **Frontend:** Single HTML file with vanilla JS (no framework, no build step)
- **Transport:** REST API (JSON)
- **Docker:** Single container, exposes one HTTP port (suggest 8085)
- **Docker socket:** Mounted at `/var/run/docker.sock` so the container can run `docker exec` commands against the `megacmd` container

---

## Features

### 1. Download Queue (top section)
- A large text area where the user pastes one or more Mega links (one per line)
- A destination field (text input) — defaults to `/downloads/`
- A "Download" button that queues all pasted links
- Each link is submitted individually via `docker exec megacmd mega-get "LINK" DESTINATION`
- Show a simple success/error toast for each queued link

### 2. Transfer Manager (bottom section)
- A table showing all active and queued transfers
- Columns: filename, status (downloading/queued/paused/error), progress %, speed, size
- Populated by polling `docker exec megacmd mega-transfers --limit=100` every 5 seconds
- Parse the mega-transfers output into structured data for display
- Per-row action buttons: Pause, Resume, Cancel
- A toolbar with: Pause All, Resume All, Cancel All buttons
- Auto-refreshes every 5 seconds without full page reload

### 3. Status Bar (top of page)
- Shows MEGAcmd login status (output of `docker exec megacmd mega-whoami`)
- Shows current Mega transfer limit status if detectable
- Simple green/red indicator

---

## Docker Setup

### Dockerfile
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
EXPOSE 8085
CMD ["node", "server.js"]
```

### docker-compose snippet
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

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/status` | Returns whoami output and login status |
| POST | `/api/download` | Body: `{ links: ["url1", "url2"], dest: "/downloads/" }` — queues downloads |
| GET | `/api/transfers` | Returns parsed transfer list |
| POST | `/api/transfers/pause` | Body: `{ tag: "all" or TAG }` — pauses transfer(s) |
| POST | `/api/transfers/resume` | Body: `{ tag: "all" or TAG }` — resumes transfer(s) |
| POST | `/api/transfers/cancel` | Body: `{ tag: "all" or TAG }` — cancels transfer(s) |

---

## Backend Implementation Notes

- Use Node.js `child_process.exec` to run Docker commands
- Commands are run as: `docker exec megacmd mega-COMMAND args`
- The container name `megacmd` should come from the `MEGACMD_CONTAINER` env var
- Parse `mega-transfers` output — it is fixed-width text output, parse by columns
- All Docker exec calls should have a reasonable timeout (10 seconds)
- Errors from mega commands should be returned as JSON error responses
- Console log all commands and responses for debugging

## Parsing mega-transfers output
The output of `mega-transfers` looks like:
```
XXXXXXXXX  Downloading  filename.mkv  50%  5MB/s  2.5GB/10GB
```
Parse each line into: `{ tag, direction, filename, progress, speed, transferred, total, status }`
Handle edge cases: paused, queued, error states.

---

## Frontend Implementation Notes

- Single `index.html` served by Express
- Pure HTML/CSS/JS — no frameworks, no npm frontend packages
- Dark theme to match the homelab aesthetic
- Mobile friendly (accessible via Tailscale on phone)
- Poll `/api/transfers` every 5 seconds with `setInterval` and update the table in place
- Show a loading spinner on the Download button while queuing
- Textarea should be large and easy to paste into on mobile
- Keep it minimal — this is a utility, not a showcase

---

## File Structure
```
megacmd-ui/
├── Dockerfile
├── package.json        (express, cors only — no other deps)
├── server.js           (Express backend + all API routes)
└── public/
    └── index.html      (complete frontend — HTML + CSS + JS in one file)
```

---

## Constraints
- No authentication (Tailscale-only access)
- No database
- No frontend build step
- Minimal dependencies — express and cors only
- Must work on Node 20 Alpine
- The `/downloads/` path inside the megacmd container maps to `/mnt/media1/downloads` on the host — this is already configured, the UI just needs to pass it as the destination
- Do not expose the Docker socket to the frontend — all Docker interactions go through the Express backend only
