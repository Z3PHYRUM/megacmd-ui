'use strict';

const express = require('express');
const cors = require('cors');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { version: APP_VERSION } = require('./package.json');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const app = express();
const PORT               = process.env.PORT || 8085;
const MEGACMD_CONTAINER  = process.env.MEGACMD_CONTAINER || 'megacmd';
const MOCK               = process.env.MOCK === '1';
const TRANSFER_LIMIT     = 1000;  // display cap for the main transfer table (UI-facing)
const TRANSFER_SAFETY_LIMIT = 5000; // used anywhere cleanup/discovery logic must see everything —
                                     // a lower cap here would mean folder-picker discovery and
                                     // straggler cancellation silently can't see or touch transfers
                                     // past the cutoff, which was the actual cause of large folders
                                     // still resuming everything beyond the display limit
const RETRY_INTERVAL_MS  = (parseInt(process.env.RETRY_INTERVAL_MIN) || 15) * 60 * 1000;
const DATA_DIR           = process.env.DATA_DIR || __dirname;
const QUEUE_FILE         = path.join(DATA_DIR, 'queue.json');
const LOG_FILE           = path.join(DATA_DIR, 'activity.log');
const SETTINGS_FILE      = path.join(DATA_DIR, 'settings.json');
const BOOKMARKS_FILE     = path.join(DATA_DIR, 'bookmarks.json');
const YTDLP_BIN          = process.env.YTDLP_BIN || 'yt-dlp';
const YTDLP_OUTPUT_DIR   = process.env.YTDLP_OUTPUT_DIR || '/downloads/';
const FS_BROWSE_ROOT     = process.env.FS_BROWSE_ROOT || '/downloads';
const NTFY_URL_DEFAULT   = process.env.NTFY_URL || 'http://ntfy:2586/ultraframe';

if (MOCK) console.log('[MOCK] Running in mock mode — no Docker commands will be executed');

app.use(cors());
// Default 100kb body limit is too small for /api/browse/confirm on a huge
// folder -- thousands of full relative file paths easily exceeds it, which
// previously surfaced as an opaque "Unexpected token '<'" JSON parse error
// (Express's default error page for a rejected oversized body is HTML).
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'images')));

// ── Activity log ─────────────────────────────────────────────────────────────
function logActivity(event, link, detail) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const detail_str = detail ? ` (${detail})` : '';
  const line = `[${ts}] ${event.padEnd(12)} ${link}${detail_str}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  console.log(`[LOG] ${line.trim()}`);
}

// ── Settings ─────────────────────────────────────────────────────────────────
const DEFAULT_NOTIFICATIONS = {
  mega_queued: true,
  mega_completed: true,
  mega_failed: true,
  archive_queued: true,
  archive_completed: true,
  all_finished: true,
};

let settings = { ntfyUrl: '', notifications: { ...DEFAULT_NOTIFICATIONS } };

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      settings = {
        ntfyUrl: typeof loaded.ntfyUrl === 'string' ? loaded.ntfyUrl : '',
        notifications: { ...DEFAULT_NOTIFICATIONS, ...(loaded.notifications || {}) },
      };
    }
  } catch {}
}

function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch {}
}

loadSettings();

// ── ntfy notifications ────────────────────────────────────────────────────────
// Fire-and-forget — a failed ntfy call must never affect download functionality.
function notify(type, title, body, opts = {}) {
  if (settings.notifications[type] === false) return;
  const url = settings.ntfyUrl.trim() || NTFY_URL_DEFAULT;
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Title': title };
  if (opts.priority) headers['Priority'] = opts.priority;
  fetch(url, { method: 'POST', headers, body })
    .catch(err => console.error(`[NTFY] ${err.message}`));
}

// ── Mock state ───────────────────────────────────────────────────────────────
let mockTransfers = [
  { tag: '1001', type: '⇓', filename: 'BigMovie.2024.2160p.BluRay.mkv', transferred: '5.20 GB',   total: '10.00 GB',  speed: '4.50 MB/s', progress: '52 %',  state: 'active' },
  { tag: '1002', type: '⇓', filename: 'AnotherShow.S01E01.zip',         transferred: '120.00 MB', total: '500.00 MB', speed: '0 B/s',     progress: '24 %',  state: 'paused' },
  { tag: '1003', type: '⇓', filename: 'SmallDocument.pdf',              transferred: '0 B',       total: '2.50 MB',   speed: '0 B/s',     progress: '0 %',   state: 'queued' },
  { tag: '1004', type: '⇓', filename: 'CorruptArchive.rar',             transferred: '50.00 MB',  total: '50.00 MB',  speed: '0 B/s',     progress: '100 %', state: 'error'  },
  { tag: '1005', type: '⇑', filename: 'Backup.tar.gz',                  transferred: '200.00 MB', total: '1.00 GB',   speed: '2.10 MB/s', progress: '20 %',  state: 'active' },
];

const MOCK_HEADER = 'TAG|TYPE|FILENAME|TRANSFERRED|TOTAL|SPEED|PROGRESS|STATE';

function mockTransfersOutput() {
  const rows = mockTransfers.map(t =>
    [t.tag, t.type, t.filename, t.transferred, t.total, t.speed, t.progress, t.state].join('|')
  );
  return [MOCK_HEADER, ...rows].join('\n');
}

function applyMockAction(flag, tagArg) {
  const all = tagArg === '-a';
  if (flag === '-c') {
    mockTransfers = all ? [] : mockTransfers.filter(t => t.tag !== tagArg);
  } else if (flag === '-p') {
    mockTransfers
      .filter(t => all || t.tag === tagArg)
      .forEach(t => { if (t.state !== 'error') t.state = 'paused'; });
  } else if (flag === '-r') {
    mockTransfers
      .filter(t => all || t.tag === tagArg)
      .forEach(t => { if (t.state === 'paused') t.state = 'active'; });
  }
}

// ── Docker / mock exec ────────────────────────────────────────────────────────
// mega-transfers gets a longer timeout than the default: listing thousands of
// transfers (as the folder-picker cleanup logic does) can genuinely take
// longer than 10s against a real, large queue -- and a silent timeout there
// means postConfirmWatches' cleanup sweep fails every single cycle forever,
// leaving unwanted transfers paused indefinitely instead of cancelled.
const EXEC_TIMEOUT = { default: 10000, 'mega-get': 0, 'mega-transfers': 45000 };  // 0 = no timeout

function dockerExec(megaCommand, args = []) {
  if (MOCK) {
    console.log(`[MOCK] ${megaCommand} ${args.join(' ')}`);
    if (megaCommand === 'mega-whoami') return Promise.resolve('user@example.com');
    if (megaCommand === 'mega-get') {
      const link = args[0] || '';
      mockTransfers.push({
        tag: String(Date.now()).slice(-4),
        type: '⇓',
        filename: decodeURIComponent(link.split('/').pop() || 'queued-download'),
        transferred: '0 B', total: 'Unknown', speed: '0 B/s', progress: '0 %', state: 'queued',
      });
      return Promise.resolve('Download enqueued');
    }
    if (megaCommand === 'mega-transfers') {
      if (['-p', '-r', '-c'].includes(args[0])) {
        applyMockAction(args[0], args[1]);
        return Promise.resolve('');
      }
      return Promise.resolve(mockTransfersOutput());
    }
    // Simulates /api/browse's backgrounded "mega-get ... &" folder-discovery trick
    // (args: -c, script, sh, link, destination) so the folder picker is testable
    // without a real MEGAcmd container.
    if (megaCommand === '/bin/sh' && (args[1] || '').startsWith('mega-get')) {
      const link = args[3] || '';
      const destination = args[4] || '/downloads/';
      const prefix = destination.endsWith('/') ? destination : destination + '/';
      // "bigfolder" in the link simulates a folder with more files than
      // TRANSFER_LIMIT, for testing that discovery/cleanup logic doesn't
      // silently stop working past the display cap.
      const fileCount = /bigfolder/i.test(link) ? 4682 : /\/folder\//i.test(link) ? 4 : 1;
      for (let i = 0; i < fileCount; i++) {
        mockTransfers.push({
          tag: String(Date.now() + i).slice(-6),
          type: '⇓',
          filename: `${prefix}mock-folder/file-${i + 1}.bin`,
          transferred: '0 B', total: `${(i + 1) * 10} MB`, speed: '0 B/s', progress: '0 %', state: 'queued',
        });
      }
      return Promise.resolve('');
    }
    return Promise.resolve('');
  }

  return new Promise((resolve, reject) => {
    const container = docker.getContainer(MEGACMD_CONTAINER);
    console.log(`[CMD] exec ${MEGACMD_CONTAINER} ${megaCommand} ${args.join(' ')}`);

    container.exec({ Cmd: [megaCommand, ...args], AttachStdout: true, AttachStderr: true },
      (err, exec) => {
        if (err) return reject(err);
        exec.start({}, (err, stream) => {
          if (err) return reject(err);

          let stdout = '', stderr = '';
          const timeoutMs = EXEC_TIMEOUT[megaCommand] ?? EXEC_TIMEOUT.default;
          const timer = timeoutMs
            ? setTimeout(() => { stream.destroy(); reject(new Error(`Command timed out: ${megaCommand}`)); }, timeoutMs)
            : null;

          docker.modem.demuxStream(stream,
            { write: chunk => { stdout += chunk.toString(); } },
            { write: chunk => { stderr += chunk.toString(); } }
          );

          stream.on('end', () => {
            if (timer) clearTimeout(timer);
            if (stdout) console.log(`[OUT] ${stdout.trim()}`);
            if (stderr) console.log(`[ERR] ${stderr.trim()}`);
            exec.inspect((err, info) => {
              if (!err && info.ExitCode !== 0) {
                const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
                reject(new Error(combined || `${megaCommand} exited with code ${info.ExitCode}`));
              } else {
                resolve(stdout);
              }
            });
          });

          stream.on('error', err => { if (timer) clearTimeout(timer); reject(err); });
        });
      }
    );
  });
}

// ── aria2 JSON-RPC ────────────────────────────────────────────────────────────
const ARIA2_RPC_URL    = process.env.ARIA2_RPC_URL    || 'http://aria2:6800/jsonrpc';
const ARIA2_RPC_SECRET = process.env.ARIA2_RPC_SECRET || '';
const ARIA2_LIMIT      = 200;

let aria2RpcId = 0;

async function aria2Call(method, params = []) {
  const body = {
    jsonrpc: '2.0',
    id: String(++aria2RpcId),
    method: `aria2.${method}`,
    params: [`token:${ARIA2_RPC_SECRET}`, ...params],
  };
  const res = await fetch(ARIA2_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`aria2 RPC HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'aria2 RPC error');
  return data.result;
}

async function aria2AddUri(url, displayName, dir) {
  return aria2Call('addUri', [[url], { dir: dir || '/downloads/', out: displayName }]);
}

const TORRENT_METADATA_TIMEOUT_MS = 30000;
const TORRENT_METADATA_POLL_MS    = 700;
const BROWSE_DISCOVERY_TIMEOUT_MS = 30000;

// Tracks the tag snapshot taken right before a folder browse started, so
// /api/browse/confirm can identify and cancel "straggler" transfers that
// MEGAcmd kept discovering after the picker's discovery window gave up —
// without this, a folder too large to fully enumerate in time could leave
// leftover transfers the user never saw and never explicitly chose.
const browseSessions = new Map(); // browseId -> { existingTags: Set, destination: string, createdAt: number }
const BROWSE_SESSION_TTL_MS = 60 * 60 * 1000;

function cleanupBrowseSessions() {
  const cutoff = Date.now() - BROWSE_SESSION_TTL_MS;
  for (const [id, session] of browseSessions) {
    if (session.createdAt < cutoff) browseSessions.delete(id);
  }
}

// mega-get's background discovery for a huge folder can keep adding transfers
// to MEGAcmd's queue for minutes after /api/browse/confirm has already
// returned -- well past both the discovery window and the one-time straggler
// sweep at confirm time. A previous version of this handled that by pausing
// everything globally during discovery and clearing the global pause on
// confirm; that turned out to be the actual bug (confirmed live: selecting 1
// file out of a huge folder resulted in ~999 others being resumed too),
// because "clear the global pause" resumes *everything* currently paused —
// including stragglers that arrived after the one-time sweep ran. So instead:
// never touch pause/resume in bulk. Individually pause each transfer as it's
// discovered, individually resume only what's kept, and keep sweeping for new
// arrivals under the same destination for a while after confirm, cancelling
// anything that isn't a kept tag.
const postConfirmWatches = []; // { destination: string, keepTags: Set, expiresAt: number }
const POST_CONFIRM_WATCH_MS = 5 * 60 * 1000;
const POST_CONFIRM_SWEEP_MS = 5000;

// Merges into an existing watch for the same destination rather than stacking
// a duplicate -- two independent watches for the same destination would each
// cancel anything outside *their own* keepTags, so a second confirm on the
// same folder within the watch window could have the first watch cancel the
// second one's just-kept file (and vice versa).
function registerPostConfirmWatch(destination, keepTags) {
  const existing = postConfirmWatches.find(w => w.destination === destination);
  if (existing) {
    keepTags.forEach(t => existing.keepTags.add(t));
    existing.expiresAt = Date.now() + POST_CONFIRM_WATCH_MS;
  } else {
    postConfirmWatches.push({ destination, keepTags: new Set(keepTags), expiresAt: Date.now() + POST_CONFIRM_WATCH_MS });
  }
}

// A single sweep can involve thousands of individual cancel calls for a huge
// folder and take a while -- this guard skips overlapping ticks rather than
// letting two sweeps race on the same tags, and the interval effectively
// becomes "sweep again as soon as the last one finishes" for a big backlog.
let sweepInProgress = false;

async function sweepPostConfirmWatches() {
  if (sweepInProgress) return;
  const now = Date.now();
  for (let i = postConfirmWatches.length - 1; i >= 0; i--) {
    if (postConfirmWatches[i].expiresAt < now) postConfirmWatches.splice(i, 1);
  }
  if (!postConfirmWatches.length) return;

  sweepInProgress = true;
  try {
    const raw = await dockerExec('mega-transfers', [`--limit=${TRANSFER_SAFETY_LIMIT}`, '--col-separator=|']);
    const transfers = parseTransfers(raw);
    for (const watch of postConfirmWatches) {
      const prefix = watch.destination.endsWith('/') ? watch.destination : watch.destination + '/';
      const stragglerTags = transfers
        .filter(t => t.tag && t.filename?.startsWith(prefix) && !watch.keepTags.has(t.tag))
        .map(t => t.tag);
      // No verify-and-retry here -- each sweep cycle re-discovers whatever's
      // still present and retries it, so the periodic nature of this loop is
      // itself the retry mechanism, without an extra query per sweep.
      if (stragglerTags.length) {
        console.log(`[BROWSE] sweeping ${stragglerTags.length} straggler(s) under ${watch.destination}`);
        await runInBatches(stragglerTags, tag => dockerExec('mega-transfers', ['-c', String(tag)]).catch(() => {}));
      }
    }
  } catch (err) {
    console.error(`[BROWSE] postConfirmWatches sweep failed: ${err.message}`);
  } finally {
    sweepInProgress = false;
  }
}
setInterval(sweepPostConfirmWatches, POST_CONFIRM_SWEEP_MS);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Runs fn over items in fixed-size concurrent batches instead of one-at-a-time,
// so confirming/cancelling a folder with hundreds of files doesn't take one
// docker exec round-trip per file, serially.
async function runInBatches(items, fn, batchSize = 25) {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(fn));
  }
}

// Adds a magnet link and waits for aria2 to resolve its BitTorrent metadata
// (file list), pausing the download once resolved so the caller can present
// a file picker before any data transfer begins.
async function aria2AddMagnetForBrowse(magnetLink, dir) {
  const gid = await aria2Call('addUri', [[magnetLink], { dir: dir || '/downloads/' }]);
  const deadline = Date.now() + TORRENT_METADATA_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const status = await aria2Call('tellStatus', [gid, ['bittorrent', 'files', 'totalLength']]);
      if (status.bittorrent?.info?.name && Number(status.totalLength) > 0) {
        await aria2Call('pause', [gid]).catch(() => {});
        const files = status.files
          .map((f, i) => ({ index: i + 1, name: basename(f.path) || f.path, size: Number(f.length) || 0 }))
          .filter(f => f.name && !/^_+padding_file/i.test(f.name));
        return { gid, name: status.bittorrent.info.name, files };
      }
      await sleep(TORRENT_METADATA_POLL_MS);
    }
  } catch (err) {
    await aria2RemoveAny(gid).catch(() => {});
    throw err;
  }
  await aria2RemoveAny(gid).catch(() => {});
  throw new Error('Timed out waiting for torrent metadata (no peers found)');
}

function basename(p) {
  if (!p) return '';
  return p.split('/').filter(Boolean).pop() || '';
}

function resolveDest(dest) {
  return (typeof dest === 'string' && dest.trim()) ? dest.trim() : '/downloads/';
}

function normalizeAria2Status(s) {
  switch (s) {
    case 'active':   return 'downloading';
    case 'waiting':  return 'queued';
    case 'paused':   return 'paused';
    case 'error':    return 'error';
    case 'complete': return 'complete';
    default:         return 'unknown';
  }
}

function normalizeAria2Item(r) {
  const total = Number(r.totalLength || 0);
  const done  = Number(r.completedLength || 0);
  return {
    gid:          r.gid,
    filename:     basename(r.files?.[0]?.path) || 'Unknown',
    status:       normalizeAria2Status(r.status),
    progress:     total > 0 ? (done / total) * 100 : 0,
    speed:        Number(r.downloadSpeed || 0),
    transferred:  done,
    total,
    errorMessage: r.errorMessage || '',
  };
}

async function aria2TellAll() {
  const [active, waiting, stopped] = await Promise.all([
    aria2Call('tellActive', []),
    aria2Call('tellWaiting', [0, ARIA2_LIMIT]),
    aria2Call('tellStopped', [0, ARIA2_LIMIT]),
  ]);
  return [...active, ...waiting, ...stopped].map(normalizeAria2Item);
}

async function aria2RemoveAny(gid) {
  try { await aria2Call('forceRemove', [gid]); }
  catch { await aria2Call('removeDownloadResult', [gid]).catch(() => {}); }
}

// ── archive.org ───────────────────────────────────────────────────────────────
function extractArchiveIdentifier(input) {
  const trimmed = (input || '').trim();
  const match = trimmed.match(/archive\.org\/(?:download|details|metadata)\/([^/?#]+)/i);
  if (match) return match[1];
  if (/^[A-Za-z0-9._-]+$/.test(trimmed)) return trimmed;
  return null;
}

async function fetchArchiveMetadata(identifier) {
  const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
  if (!res.ok) throw new Error(`archive.org metadata HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.files) || !data.files.length)
    throw new Error('No files found for this archive.org item');
  return data;
}

// aria2 downloads run async with no completion callback, so poll queued gids
// to fire the "download complete" notification once each finishes.
const archiveDownloads = new Map(); // gid -> filename
const ARCHIVE_POLL_MS = 10000;

async function pollArchiveDownloads() {
  for (const [gid, filename] of archiveDownloads) {
    try {
      const status = await aria2Call('tellStatus', [gid, ['status']]);
      if (status.status === 'complete') {
        notify('archive_completed', 'aria2c', `Download complete: ${filename}`);
        archiveDownloads.delete(gid);
      } else if (status.status === 'error' || status.status === 'removed') {
        archiveDownloads.delete(gid);
      }
    } catch {
      archiveDownloads.delete(gid);
    }
  }
}
setInterval(pollArchiveDownloads, ARCHIVE_POLL_MS);

// ── YouTube (yt-dlp) ──────────────────────────────────────────────────────────
const YOUTUBE_URL_RE = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i;
const YTDLP_FORMAT = 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b';

let ytJobId = 0;
const ytJobs = [];

function serializeYtJob(job) {
  const { id, url, filename, status, progress, error, isPlaylist, items } = job;
  return { id, url, filename, status, progress, error, isPlaylist, items };
}

function spawnYoutubeDownload(url, dest, items) {
  const isPlaylist = /[?&]list=/i.test(url);
  const job = {
    id: String(++ytJobId),
    url,
    filename: isPlaylist ? 'Fetching playlist info…' : 'Fetching info…',
    status: 'starting',
    progress: 0,
    error: '',
    proc: null,
    stderrTail: '',
    isPlaylist,
    playlistTitle: '',
    itemIndex: 0,
    itemCount: 0,
    // Read-only per-video status within a playlist job; a single yt-dlp
    // process handles the whole playlist, so these reflect progress only —
    // cancelling still stops the entire job, not one video.
    items: (isPlaylist && Array.isArray(items) && items.length)
      ? items.map(it => ({ index: it.index, title: it.title || `Video ${it.index}`, status: 'queued', progress: 0 }))
          .sort((a, b) => a.index - b.index)
      : [],
  };
  ytJobs.push(job);

  const outputDir = resolveDest(dest);
  const outputTemplate = isPlaylist
    ? path.join(outputDir, '%(playlist_title)s/%(playlist_index)s - %(title)s.%(ext)s')
    : path.join(outputDir, '%(title)s.%(ext)s');

  const proc = spawn(YTDLP_BIN, [
    '-f', YTDLP_FORMAT,
    '--merge-output-format', 'mp4',
    '--newline',
    ...(isPlaylist ? [] : ['--no-playlist']),
    ...(job.items.length ? ['--playlist-items', job.items.map(it => it.index).join(',')] : []),
    '-o', outputTemplate,
    url,
  ]);
  job.proc = proc;
  job.status = 'downloading';

  let stdoutBuf = '';
  proc.stdout.on('data', chunk => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      const playlistTitle = line.match(/^\[download\] Downloading playlist:\s+(.+)$/);
      if (playlistTitle) job.playlistTitle = playlistTitle[1];

      // N/M here are positions within the --playlist-items subset (in the
      // same ascending order job.items was sorted/passed in), not absolute
      // playlist indices, so job.items[N-1] is the item currently active.
      const item = line.match(/^\[download\] Downloading item (\d+) of (\d+)/);
      if (item) {
        job.itemIndex = Number(item[1]);
        job.itemCount = Number(item[2]);
        job.items.forEach((it, idx) => {
          const pos = idx + 1;
          if (pos < job.itemIndex) it.status = it.status === 'error' ? 'error' : 'complete';
          else if (pos === job.itemIndex) it.status = 'downloading';
        });
      }

      const dest = line.match(/^\[download\] Destination:\s+(.+)$/) || line.match(/^\[Merger\] Merging formats into "(.+)"$/);
      if (dest) job.currentFile = basename(dest[1]);

      const pct = line.match(/^\[download\]\s+([\d.]+)%/);
      if (pct) {
        const itemPct = parseFloat(pct[1]);
        job.progress = (job.isPlaylist && job.itemCount > 0)
          ? ((job.itemIndex - 1) / job.itemCount * 100) + (itemPct / job.itemCount)
          : itemPct;
        const cur = job.items[job.itemIndex - 1];
        if (cur) cur.progress = itemPct;
      }
    }
    if (job.isPlaylist) {
      job.filename = job.playlistTitle
        ? `${job.playlistTitle}${job.itemCount ? ` (${job.itemIndex}/${job.itemCount})` : ''}`
        : 'Fetching playlist info…';
    } else if (job.currentFile) {
      job.filename = job.currentFile;
    }
  });
  proc.stderr.on('data', chunk => {
    job.stderrTail = (job.stderrTail + chunk.toString()).slice(-2000);
  });
  proc.on('close', code => {
    job.proc = null;
    if (code === 0) {
      job.status = 'complete';
      job.progress = 100;
      job.items.forEach(it => { it.status = 'complete'; it.progress = 100; });
      logActivity('YOUTUBE_DOWNLOADED', url, job.filename);
    } else if (job.status === 'cancelled') {
      job.items.forEach(it => { if (it.status !== 'complete') it.status = 'cancelled'; });
    } else {
      job.status = 'error';
      job.error = (job.stderrTail.trim().split('\n').pop() || `yt-dlp exited with code ${code}`).replace(/^ERROR:\s*/, '');
      const cur = job.items[job.itemIndex - 1];
      if (cur && cur.status !== 'complete') cur.status = 'error';
      logActivity('YOUTUBE_FAILED', url, job.error);
    }
  });
  proc.on('error', err => {
    job.proc = null;
    job.status = 'error';
    job.error = err.message;
    logActivity('YOUTUBE_FAILED', url, err.message);
  });

  return job;
}

// ── Transfer parsing ──────────────────────────────────────────────────────────
const COL_MAP = [
  [['tag'],                      'tag'],
  [['type'],                     'type'],
  [['filename', 'name', 'path', 'destiny'], 'filename'],
  [['transferred'],              'transferred'],
  [['total'],                    'total'],
  [['speed'],                    'speed'],
  [['progress'],                 'progress'],
  [['state', 'status'],          'state'],
];

function mapHeaders(headers) {
  return headers.map(h => {
    const lower = h.toLowerCase().trim();
    for (const [aliases, field] of COL_MAP) {
      if (aliases.some(a => lower.startsWith(a))) return field;
    }
    return null;
  });
}

function parsePipeTransfers(raw) {
  // Skip status/warning lines (e.g. "DOWNLOADS AND UPLOADS ARE PAUSED") — keep only pipe rows
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l && l.includes('|'));
  if (lines.length < 2) return [];

  const fieldMap = mapHeaders(lines[0].split('|'));
  const get = (parts, name) => {
    const i = fieldMap.indexOf(name);
    return i >= 0 ? (parts[i] || '').trim() : '';
  };

  const transfers = [];
  for (let i = 1; i < lines.length; i++) {
    const parts     = lines[i].split('|');
    const typeVal     = get(parts, 'type');
    const direction   = typeToDirection(typeVal);
    const stateRaw    = get(parts, 'state');
    const progressRaw = get(parts, 'progress');
    const pMatch      = progressRaw.match(/(\d+(?:\.\d+)?)\s*%/);
    // MEGAcmd 2.5+ embeds total size in PROGRESS: "0.00% of 4.70 GB"
    const totalMatch  = progressRaw.match(/of\s+([\d.]+\s*[KMGT]?B)/i);

    transfers.push({
      tag:         get(parts, 'tag'),
      direction,
      filename:    get(parts, 'filename'),
      progress:    pMatch ? parseFloat(pMatch[1]) : 0,
      speed:       get(parts, 'speed'),
      transferred: get(parts, 'transferred'),
      total:       totalMatch ? totalMatch[1].trim() : get(parts, 'total'),
      status:      normalizeStatus(stateRaw, direction),
    });
  }
  return transfers.filter(t => t.tag || t.filename);
}

function parseLegacyTransfers(raw) {
  const lines = raw.split('\n');
  const transfers = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^(DIR|TAG|TYPE|\s*-+)/i.test(trimmed)) continue;

    const parts = trimmed.split(/\s{2,}/);
    if (parts.length < 3) continue;

    const first = parts[0].trim(), second = (parts[1] || '').trim();
    let tag, direction, filename, statsStr;

    if (/^[DU⇓⇑⇵⏫]/.test(first)) {
      direction = typeToDirection(first);
      tag = second; filename = (parts[2] || '').trim(); statsStr = parts.slice(3).join('  ');
    } else if (/^(download|upload)/i.test(second)) {
      tag = first; direction = /^d/i.test(second) ? 'Downloading' : 'Uploading';
      filename = (parts[2] || '').trim(); statsStr = parts.slice(3).join('  ');
    } else if (/^\d+$/.test(first)) {
      tag = first; direction = 'Downloading'; filename = second; statsStr = parts.slice(2).join('  ');
    } else continue;

    const pMatch  = statsStr.match(/(\d+(?:\.\d+)?)\s*%/);
    const spMatch = statsStr.match(/\d+(?:\.\d+)?\s*[KMGT]?B\/s/i);
    const stMatch = statsStr.match(/\b(active|paus(?:ed)?|queued?|error|fail(?:ed)?|complet(?:e|ed)?|finish(?:ed)?)\b/i);
    const slash   = statsStr.match(/(\d+(?:\.\d+)?\s*[KMGT]?B)\s*\/\s*(\d+(?:\.\d+)?\s*[KMGT]?B)/i);
    const sizes   = [...statsStr.matchAll(/\d+(?:\.\d+)?\s*[KMGT]?B(?!\s*\/s)/gi)];

    transfers.push({
      tag: tag || '', direction, filename: filename || '',
      progress:    pMatch  ? parseFloat(pMatch[1]) : 0,
      speed:       spMatch ? spMatch[0].trim() : '0 B/s',
      transferred: slash ? slash[1].trim() : (sizes[0] ? sizes[0][0].trim() : ''),
      total:       slash ? slash[2].trim() : (sizes[1] ? sizes[1][0].trim() : ''),
      status:      normalizeStatus(stMatch ? stMatch[1] : '', direction),
    });
  }
  return transfers;
}

function parseTransfers(raw) {
  // Use first pipe-containing line to detect format — MEGAcmd may print status
  // messages (e.g. "DOWNLOADS AND UPLOADS ARE PAUSED") before the actual data.
  const firstPipeLine = raw.split('\n').find(l => l.trim().includes('|')) || '';
  return firstPipeLine ? parsePipeTransfers(raw) : parseLegacyTransfers(raw);
}

function typeToDirection(type) {
  if (/[⇓⇵]/.test(type) || /^[dD]/.test(type)) return 'Downloading';
  if (/[⇑⏫]/.test(type) || /^[uU]/.test(type)) return 'Uploading';
  return 'Downloading';
}

function normalizeStatus(state, direction) {
  const s = state.toLowerCase().trim();
  if (!s) return 'unknown';
  if (s === 'active') return direction === 'Uploading' ? 'uploading' : 'downloading';
  if (s.includes('paus'))                          return 'paused';
  if (s.includes('queue'))                         return 'queued';
  if (s.includes('error') || s.includes('fail'))  return 'error';
  if (s.includes('complet') || s.includes('finish')) return 'complete';
  if (s.includes('download'))                      return 'downloading';
  if (s.includes('upload'))                        return 'uploading';
  return s;
}

function cleanMegaError(raw) {
  if (!raw) return 'Unknown error';

  if (/error code:\s*Incomplete/i.test(raw) && /100\.00\s*%/.test(raw))
    return 'Download complete (MEGAcmd reported incomplete — verify files)';

  if (/bandwidth quota/i.test(raw)) {
    const match = raw.match(/try again in (\d+) hour/i);
    const hours = match ? parseInt(match[1]) : null;
    return hours
      ? `Bandwidth quota exceeded — resets in ~${hours} hour${hours !== 1 ? 's' : ''}`
      : 'Bandwidth quota exceeded';
  }

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const useful = [];
  for (const line of lines) {
    const logMatch = line.match(/\[\S+ cmd \w+\s+(.+?)\]?\s*$/);
    if (logMatch) {
      useful.push(logMatch[1].replace(/\]$/, '').trim());
    } else if (!/^(See|Use) /i.test(line) && !/^Transfer not started/i.test(line) && !/^TRANSFERRING /i.test(line)) {
      useful.push(line);
    }
  }
  return useful.join(' — ').trim() || raw.trim();
}

// ── Retry queue ───────────────────────────────────────────────────────────────
let retryQueue  = [];
let nextRetryAt = null;
let retryTimer  = null;

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      retryQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
      retryQueue.forEach(q => { if (q.status === 'retrying') q.status = 'pending'; });
      console.log(`[QUEUE] Loaded ${retryQueue.length} item(s)`);
    }
  } catch { retryQueue = []; }
}

function saveQueue() {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(retryQueue, null, 2)); } catch {}
}

function queueId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function addToQueue(links, dest, opts = {}) {
  const items = links.map(link => ({
    id: queueId(), link, dest,
    addedAt: new Date().toISOString(),
    lastAttempt: null, lastError: null, status: 'pending',
  }));
  retryQueue.push(...items);
  saveQueue();
  items.forEach(i => {
    logActivity('QUEUED', i.link, i.dest);
    if (!opts.silent) notify('mega_queued', 'MEGAcmd', `Queued: ${i.link}`);
  });
  if (!retryTimer) scheduleRetry();
  return items;
}

function scheduleRetry(delay = RETRY_INTERVAL_MS) {
  if (retryTimer) clearTimeout(retryTimer);
  nextRetryAt = Date.now() + delay;
  retryTimer = setTimeout(processRetryQueue, delay);
  console.log(`[QUEUE] Next retry in ${Math.round(delay / 60000)}m`);
}

async function processRetryQueue() {
  retryTimer = null;
  nextRetryAt = null;

  const pending = retryQueue.filter(q => q.status === 'pending');
  if (!pending.length) return;

  for (const item of pending) {
    item.status = 'retrying';
    item.lastAttempt = new Date().toISOString();
    saveQueue();

    try {
      await dockerExec('mega-get', ['--ignore-quota-warn', item.link, item.dest]);
      logActivity('DOWNLOADED', item.link, item.dest);
      notify('mega_completed', 'MEGAcmd', `Download complete: ${item.link}`);
      retryQueue = retryQueue.filter(q => q.id !== item.id);
      saveQueue();
    } catch (err) {
      const msg = cleanMegaError(err.message);
      item.status = 'pending';
      item.lastError = msg;
      saveQueue();
      logActivity('FAILED', item.link, msg);
      // Quota blocks everything — stop and wait for next cycle
      if (/bandwidth quota/i.test(err.message)) {
        scheduleRetry();
        return;
      }
      notify('mega_failed', 'MEGAcmd', `Download failed: ${item.link}`, { priority: 'high' });
    }
  }

  if (retryQueue.some(q => q.status === 'pending')) scheduleRetry();
}

loadQueue();
if (retryQueue.some(q => q.status === 'pending')) scheduleRetry();

// ── All-queues-finished notification ─────────────────────────────────────────
// Polls live state across every download subsystem so it also catches
// completions our own routes don't directly await (e.g. resumed folder
// downloads from /api/browse/confirm), firing once on the busy → idle edge.
let queuesWereBusy = false;
const ALL_FINISHED_POLL_MS = 15000;

async function checkAllQueuesFinished() {
  let busy = retryQueue.length > 0
    || ytJobs.some(j => !['complete', 'error', 'cancelled'].includes(j.status));

  if (!busy) {
    try {
      const raw = await dockerExec('mega-transfers', [`--limit=${TRANSFER_SAFETY_LIMIT}`, '--col-separator=|']);
      if (parseTransfers(raw).some(t => !['complete', 'error'].includes(t.status))) busy = true;
    } catch {}
  }

  if (!busy) {
    try {
      if ((await aria2TellAll()).some(t => !['complete', 'error'].includes(t.status))) busy = true;
    } catch {}
  }

  if (queuesWereBusy && !busy) notify('all_finished', 'MEGAcmd', 'All queues finished — nothing left downloading');
  queuesWereBusy = busy;
}
setInterval(checkAllQueuesFinished, ALL_FINISHED_POLL_MS);

// ── Bookmarks ────────────────────────────────────────────────────────────────
let bookmarks = [];

function loadBookmarks() {
  try {
    if (fs.existsSync(BOOKMARKS_FILE)) bookmarks = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf8'));
  } catch { bookmarks = []; }
}

function saveBookmarks() {
  try { fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(bookmarks, null, 2)); } catch {}
}

loadBookmarks();

// ── API routes ────────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const whoami = await dockerExec('mega-whoami');
    const text = whoami.trim();
    res.json({ loggedIn: text.length > 0 && !/not logged/i.test(text), whoami: text, version: APP_VERSION });
  } catch (err) {
    res.json({ loggedIn: false, whoami: err.message, version: APP_VERSION });
  }
});

app.post('/api/download', async (req, res) => {
  const { links, dest } = req.body;
  if (!Array.isArray(links) || links.length === 0)
    return res.status(400).json({ error: 'No links provided' });

  const destination = resolveDest(dest);
  const results = [];

  for (const rawLink of links) {
    const link = typeof rawLink === 'string' ? rawLink.trim() : '';
    if (!link) continue;
    notify('mega_queued', 'MEGAcmd', `Queued: ${link}`);
    try {
      await dockerExec('mega-get', ['--ignore-quota-warn', link, destination]);
      logActivity('DOWNLOADED', link, destination);
      notify('mega_completed', 'MEGAcmd', `Download complete: ${link}`);
      results.push({ link, success: true });
    } catch (err) {
      const error = cleanMegaError(err.message);
      const quotaExceeded = /bandwidth quota/i.test(err.message);
      if (!quotaExceeded) notify('mega_failed', 'MEGAcmd', `Download failed: ${link}`, { priority: 'high' });
      results.push({ link, success: false, error, quotaExceeded });
    }
  }

  // Auto-add quota-blocked links to the retry queue
  const quotaLinks = results.filter(r => r.quotaExceeded).map(r => r.link);
  if (quotaLinks.length) addToQueue(quotaLinks, destination, { silent: true });

  res.json({ results });
});

app.get('/api/transfers', async (req, res) => {
  try {
    const raw = await dockerExec('mega-transfers', [`--limit=${TRANSFER_LIMIT}`, '--col-separator=|']);
    const transfers = parseTransfers(raw);
    res.json({ transfers, truncated: transfers.length >= TRANSFER_LIMIT });
  } catch (err) {
    res.status(500).json({ error: err.message, transfers: [], truncated: false });
  }
});

app.post('/api/transfers/pause', async (req, res) => {
  const { tag } = req.body;
  try {
    await dockerExec('mega-transfers', tag === 'all' ? ['-p', '-a'] : ['-p', String(tag)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/transfers/resume', async (req, res) => {
  const { tag } = req.body;
  try {
    await dockerExec('mega-transfers', tag === 'all' ? ['-r', '-a'] : ['-r', String(tag)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/transfers/cancel', async (req, res) => {
  const { tag } = req.body;
  try {
    await dockerExec('mega-transfers', tag === 'all' ? ['-c', '-a'] : ['-c', String(tag)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Queue routes ──────────────────────────────────────────────────────────────
app.get('/api/queue', (req, res) => {
  res.json({ items: retryQueue, nextRetry: nextRetryAt });
});

app.post('/api/queue/add', (req, res) => {
  const { links, dest } = req.body;
  if (!Array.isArray(links) || !links.length)
    return res.status(400).json({ error: 'No links provided' });
  const destination = resolveDest(dest);
  const clean = links.map(l => (typeof l === 'string' ? l.trim() : '')).filter(Boolean);
  if (!clean.length) return res.status(400).json({ error: 'No valid links' });
  res.json({ items: addToQueue(clean, destination) });
});

app.delete('/api/queue/:id', (req, res) => {
  const item = retryQueue.find(q => q.id === req.params.id);
  if (item) logActivity('REMOVED', item.link);
  const before = retryQueue.length;
  retryQueue = retryQueue.filter(q => q.id !== req.params.id);
  saveQueue();
  if (!retryQueue.some(q => q.status === 'pending') && retryTimer) {
    clearTimeout(retryTimer); retryTimer = null; nextRetryAt = null;
  }
  res.json({ success: retryQueue.length < before });
});

app.post('/api/queue/:id/move', (req, res) => {
  const { direction } = req.body;
  const idx = retryQueue.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const swap = direction === 'up' ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= retryQueue.length) return res.json({ success: false });
  [retryQueue[idx], retryQueue[swap]] = [retryQueue[swap], retryQueue[idx]];
  saveQueue();
  res.json({ success: true });
});

app.post('/api/queue/retry-now', (req, res) => {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  nextRetryAt = null;
  processRetryQueue();
  res.json({ success: true });
});

app.post('/api/queue/clear', (req, res) => {
  retryQueue.filter(q => q.status !== 'retrying').forEach(q => logActivity('REMOVED', q.link));
  retryQueue = retryQueue.filter(q => q.status === 'retrying');
  saveQueue();
  if (!retryQueue.some(q => q.status === 'pending') && retryTimer) {
    clearTimeout(retryTimer); retryTimer = null; nextRetryAt = null;
  }
  res.json({ success: true });
});

// ── Browse routes ─────────────────────────────────────────────────────────────
app.post('/api/browse', async (req, res) => {
  cleanupBrowseSessions();
  const { link, dest } = req.body;
  if (!link) return res.status(400).json({ error: 'No link provided' });
  const destination = resolveDest(dest);

  // Snapshot existing tags so we can identify what mega-get adds
  let existingTags = new Set();
  try {
    const raw = await dockerExec('mega-transfers', [`--limit=${TRANSFER_SAFETY_LIMIT}`, '--col-separator=|']);
    parseTransfers(raw).forEach(t => { if (t.tag) existingTags.add(t.tag); });
  } catch (err) {
    console.error(`[BROWSE] existingTags snapshot failed, discovery may misclassify pre-existing transfers as new: ${err.message}`);
  }

  // Deliberately NOT using a global pause (-p -a) here: it was tried and caused
  // a worse bug than it solved — see the comment on postConfirmWatches below.
  // We rely solely on the eager per-tag pause in the discovery loop.

  // Background mega-get so it returns immediately after telling the daemon to queue the folder.
  // $1/$2 positional params avoid shell injection.
  try {
    await dockerExec('/bin/sh', ['-c', 'mega-get --ignore-quota-warn "$1" "$2" > /dev/null 2>&1 &', 'sh', link, destination]);
  } catch (err) {
    return res.status(500).json({ error: cleanMegaError(err.message) });
  }

  // Poll until the transfer count stabilises (no new entries for two consecutive polls) or the
  // deadline elapses, pausing each newly-discovered transfer immediately as a safety net.
  let newTransfers = [], prevCount = -1;
  const pausedTags = new Set();
  const deadline = Date.now() + BROWSE_DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 700));
    try {
      const raw = await dockerExec('mega-transfers', [`--limit=${TRANSFER_SAFETY_LIMIT}`, '--col-separator=|']);
      const fresh = parseTransfers(raw).filter(t => t.tag && !existingTags.has(t.tag));
      const newlyFound = fresh.filter(t => !pausedTags.has(t.tag));
      newlyFound.forEach(t => pausedTags.add(t.tag));
      if (newlyFound.length) {
        // Fire-and-forget so a big batch doesn't delay the next poll tick, but
        // bounded concurrency (not one unbounded burst per tick) so a folder
        // discovering hundreds of files at once doesn't overwhelm docker exec
        // and silently drop some pause commands.
        runInBatches(newlyFound.map(t => t.tag), tag => dockerExec('mega-transfers', ['-p', tag]).catch(() => {})).catch(() => {});
      }
      if (fresh.length > 0 && fresh.length === prevCount) { newTransfers = fresh; break; }
      prevCount = fresh.length;
      newTransfers = fresh;
    } catch (err) {
      console.error(`[BROWSE] discovery poll failed: ${err.message}`);
    }
  }

  if (!newTransfers.length)
    return res.status(500).json({ error: 'No files found — quota exceeded, link invalid, or folder is empty' });

  const browseId = queueId();
  browseSessions.set(browseId, { existingTags, destination, createdAt: Date.now() });

  logActivity('BROWSE', link, `${newTransfers.length} file(s) found`);
  res.json({ files: newTransfers, dest: destination, browseId });
});

app.post('/api/browse/confirm', async (req, res) => {
  const { keep = [], cancel = [], bookmarkId, keptFiles = [], browseId } = req.body;
  const keepSet = new Set(keep.map(String));

  // Resume just the kept tags -- typically a short list, so this is fast.
  // Deliberately never a blanket "-r -a" (see postConfirmWatches comment:
  // that was the actual cause of the original over-download bug).
  runInBatches(keep, tag => dockerExec('mega-transfers', ['-r', String(tag)]).catch(() => {})).catch(() => {});
  if (keep.length) logActivity('DOWNLOADED', `${keep.length} file(s) selected from folder`, `${cancel.length} skipped`);

  // Cancelling can mean thousands of individual docker exec calls for a huge
  // folder -- don't make the browser wait on that (this used to leave
  // "Download Selected" stuck for a long time). A registered watch's own
  // periodic sweep (every 5s, for the next 5 minutes) cancels everything
  // under this destination that isn't a kept tag -- which covers both the
  // explicit cancel list AND any straggler mega-get is still discovering in
  // the background -- with each sweep cycle naturally retrying anything the
  // previous one didn't get to, so no separate verify-and-retry pass is
  // needed here.
  const session = browseId && browseSessions.get(browseId);
  if (session) {
    registerPostConfirmWatch(session.destination, keepSet);
    browseSessions.delete(browseId);
  } else if (cancel.length) {
    // No valid session (e.g. expired) -- fall back to cancelling just the
    // explicit list, still in the background.
    runInBatches(cancel.map(String), tag => dockerExec('mega-transfers', ['-c', String(tag)]).catch(() => {})).catch(() => {});
  }

  if (bookmarkId && keptFiles.length) {
    const bookmark = bookmarks.find(b => b.id === bookmarkId);
    if (bookmark) {
      bookmark.downloaded = [...new Set([...bookmark.downloaded, ...keptFiles])];
      saveBookmarks();
    }
  }

  res.json({ success: true });
});

// ── Bookmark routes ───────────────────────────────────────────────────────────
app.get('/api/bookmarks', (req, res) => {
  res.json({ bookmarks });
});

app.post('/api/bookmarks', (req, res) => {
  const { link, dest } = req.body;
  if (typeof link !== 'string' || !link.trim())
    return res.status(400).json({ error: 'No link provided' });
  const existing = bookmarks.find(b => b.link === link.trim());
  if (existing) return res.json({ bookmark: existing });
  const bookmark = {
    id: queueId(),
    link: link.trim(),
    dest: resolveDest(dest),
    addedAt: new Date().toISOString(),
    downloaded: [],
  };
  bookmarks.push(bookmark);
  saveBookmarks();
  res.json({ bookmark });
});

app.delete('/api/bookmarks/:id', (req, res) => {
  const before = bookmarks.length;
  bookmarks = bookmarks.filter(b => b.id !== req.params.id);
  saveBookmarks();
  res.json({ success: bookmarks.length < before });
});

// ── Archive.org routes ────────────────────────────────────────────────────────
app.post('/api/archive/browse', async (req, res) => {
  const { url } = req.body;
  const identifier = extractArchiveIdentifier(url);
  if (!identifier) return res.status(400).json({ error: 'Could not extract an archive.org identifier from that URL' });

  try {
    const data = await fetchArchiveMetadata(identifier);
    const NOISE = /(_meta\.xml|_files\.xml|_reviews\.xml|_archive\.torrent)$|^__ia_thumb/i;
    const files = data.files
      .filter(f => f.name && !NOISE.test(f.name))
      .map(f => ({ name: f.name, size: f.size || '0' }));
    res.json({ identifier, files });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/archive/confirm', async (req, res) => {
  const { identifier, files, dest } = req.body;
  if (!identifier || !Array.isArray(files) || !files.length)
    return res.status(400).json({ error: 'No files selected' });

  const destination = resolveDest(dest);
  const results = [];
  for (const name of files) {
    const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${
      name.split('/').map(encodeURIComponent).join('/')}`;
    try {
      const gid = await aria2AddUri(url, name, destination);
      logActivity('ARCHIVE_QUEUED', name, identifier);
      notify('archive_queued', 'aria2c', `Queued: ${name}`);
      archiveDownloads.set(gid, name);
      results.push({ name, success: true, gid });
    } catch (err) {
      logActivity('ARCHIVE_FAILED', name, err.message);
      results.push({ name, success: false, error: err.message });
    }
  }
  res.json({ results });
});

app.post('/api/aria2/add', async (req, res) => {
  const { links, dest } = req.body;
  if (!Array.isArray(links) || links.length === 0)
    return res.status(400).json({ error: 'No links provided' });

  const destination = resolveDest(dest);
  const results = [];
  for (const rawLink of links) {
    const link = typeof rawLink === 'string' ? rawLink.trim() : '';
    if (!link) continue;
    try {
      const gid = await aria2AddUri(link, undefined, destination);
      logActivity('DIRECT_QUEUED', link);
      results.push({ link, success: true, gid });
    } catch (err) {
      logActivity('DIRECT_FAILED', link, err.message);
      results.push({ link, success: false, error: err.message });
    }
  }
  res.json({ results });
});

// ── Torrent routes ────────────────────────────────────────────────────────────
app.post('/api/torrent/browse', async (req, res) => {
  const { link, dest } = req.body;
  if (typeof link !== 'string' || !/^magnet:/i.test(link.trim()))
    return res.status(400).json({ error: 'Not a magnet link' });

  try {
    const { gid, name, files } = await aria2AddMagnetForBrowse(link.trim(), resolveDest(dest));
    res.json({ gid, name, files });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/torrent/confirm', async (req, res) => {
  const { gid, files } = req.body;
  if (!gid || !Array.isArray(files) || !files.length)
    return res.status(400).json({ error: 'No files selected' });

  try {
    await aria2Call('changeOption', [gid, { 'select-file': files.join(',') }]);
    await aria2Call('unpause', [gid]);
    logActivity('TORRENT_QUEUED', gid);
    res.json({ success: true });
  } catch (err) {
    logActivity('TORRENT_FAILED', gid, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/torrent/cancel', async (req, res) => {
  const { gid } = req.body;
  if (!gid) return res.status(400).json({ error: 'No gid provided' });
  await aria2RemoveAny(gid).catch(() => {});
  res.json({ success: true });
});

// ── aria2 routes ──────────────────────────────────────────────────────────────
app.get('/api/aria2/transfers', async (req, res) => {
  try {
    const transfers = await aria2TellAll();
    res.json({ transfers });
  } catch (err) {
    res.status(500).json({ error: err.message, transfers: [] });
  }
});

app.post('/api/aria2/pause', async (req, res) => {
  const { gid } = req.body;
  try {
    await (gid === 'all' ? aria2Call('pauseAll') : aria2Call('pause', [gid]));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/aria2/resume', async (req, res) => {
  const { gid } = req.body;
  try {
    await (gid === 'all' ? aria2Call('unpauseAll') : aria2Call('unpause', [gid]));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/aria2/cancel', async (req, res) => {
  const { gid } = req.body;
  try {
    if (gid === 'all') {
      const all = await aria2TellAll();
      for (const t of all) await aria2RemoveAny(t.gid);
    } else {
      await aria2RemoveAny(gid);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── YouTube routes ────────────────────────────────────────────────────────────
app.post('/api/youtube/browse-playlist', (req, res) => {
  const { url } = req.body;
  if (typeof url !== 'string' || !YOUTUBE_URL_RE.test(url.trim()))
    return res.status(400).json({ error: 'Not a youtube.com or youtu.be URL' });

  execFile(YTDLP_BIN, ['--flat-playlist', '-J', url.trim()],
    { maxBuffer: 20 * 1024 * 1024, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message).trim().split('\n').pop().replace(/^ERROR:\s*/, '');
        return res.status(502).json({ error: msg || 'Failed to fetch playlist info' });
      }
      let data;
      try { data = JSON.parse(stdout); } catch { return res.status(502).json({ error: 'Could not parse playlist metadata' }); }
      const entries = (data.entries || []).map((e, i) => ({ index: i + 1, title: e.title || `Video ${i + 1}` }));
      if (!entries.length) return res.status(502).json({ error: 'No videos found in this playlist' });
      res.json({ title: data.title || 'Playlist', entries });
    });
});

app.post('/api/youtube/add', (req, res) => {
  const { url, dest, items } = req.body;
  if (typeof url !== 'string' || !YOUTUBE_URL_RE.test(url.trim()))
    return res.status(400).json({ error: 'Not a youtube.com or youtu.be URL' });

  const job = spawnYoutubeDownload(url.trim(), dest, items);
  logActivity('YOUTUBE_QUEUED', url.trim());
  res.json({ job: serializeYtJob(job) });
});

app.get('/api/youtube/jobs', (req, res) => {
  res.json({ jobs: ytJobs.map(serializeYtJob) });
});

app.post('/api/youtube/cancel', (req, res) => {
  const { id } = req.body;
  const job = ytJobs.find(j => j.id === id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.proc) {
    job.status = 'cancelled';
    job.proc.kill('SIGTERM');
  }
  res.json({ success: true });
});

app.post('/api/youtube/dismiss', (req, res) => {
  const { id } = req.body;
  const idx = ytJobs.findIndex(j => j.id === id);
  if (idx !== -1) ytJobs.splice(idx, 1);
  res.json({ success: true });
});

// ── Filesystem browse routes (Destination folder picker) ──────────────────────
app.get('/api/fs/browse', (req, res) => {
  const rawRel = typeof req.query.path === 'string' ? req.query.path : '';
  // Normalizing against a virtual root of '/' collapses any '..' attempts to
  // at most the root, so joining with FS_BROWSE_ROOT can never escape it.
  const safeRel = path.normalize('/' + rawRel).replace(/^\/+|\/+$/g, '');
  const target = safeRel ? path.join(FS_BROWSE_ROOT, safeRel) : FS_BROWSE_ROOT;

  let dirs;
  try {
    dirs = fs.readdirSync(target, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    return res.status(500).json({ error: `Could not read directory: ${err.message}` });
  }
  res.json({ path: target.endsWith('/') ? target : target + '/', rel: safeRel, dirs });
});

// ── Log routes ────────────────────────────────────────────────────────────────
app.get('/api/log', (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json({ lines: [] });
    const lines = fs.readFileSync(LOG_FILE, 'utf8')
      .split('\n').filter(Boolean).slice(-200);
    res.json({ lines });
  } catch (err) {
    res.status(500).json({ error: err.message, lines: [] });
  }
});

app.delete('/api/log', (req, res) => {
  try { fs.writeFileSync(LOG_FILE, ''); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Settings routes ───────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json({ ntfyUrl: settings.ntfyUrl, ntfyUrlDefault: NTFY_URL_DEFAULT, notifications: settings.notifications });
});

app.post('/api/settings', (req, res) => {
  const { ntfyUrl, notifications } = req.body;
  if (typeof ntfyUrl === 'string') settings.ntfyUrl = ntfyUrl.trim();
  if (notifications && typeof notifications === 'object') {
    for (const key of Object.keys(DEFAULT_NOTIFICATIONS)) {
      if (key in notifications) settings.notifications[key] = !!notifications[key];
    }
  }
  saveSettings();
  res.json({ ntfyUrl: settings.ntfyUrl, ntfyUrlDefault: NTFY_URL_DEFAULT, notifications: settings.notifications });
});

// Ensure API errors always come back as JSON, not Express's default HTML
// error page — a body-parser error (e.g. exceeding the size limit) would
// otherwise surface client-side as an opaque "Unexpected token '<'" JSON
// parse failure instead of a readable message.
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`MEGAcmd UI running on port ${PORT}`);
  console.log(`MEGACMD_CONTAINER: ${MEGACMD_CONTAINER}`);
});
