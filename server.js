'use strict';

const express = require('express');
const cors = require('cors');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const app = express();
const PORT               = process.env.PORT || 8085;
const MEGACMD_CONTAINER  = process.env.MEGACMD_CONTAINER || 'megacmd';
const MOCK               = process.env.MOCK === '1';
const TRANSFER_LIMIT     = 200;
const RETRY_INTERVAL_MS  = (parseInt(process.env.RETRY_INTERVAL_MIN) || 15) * 60 * 1000;
const QUEUE_FILE         = path.join(__dirname, 'queue.json');
const LOG_FILE           = path.join(__dirname, 'activity.log');

if (MOCK) console.log('[MOCK] Running in mock mode — no Docker commands will be executed');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Activity log ─────────────────────────────────────────────────────────────
function logActivity(event, link, detail) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const detail_str = detail ? ` (${detail})` : '';
  const line = `[${ts}] ${event.padEnd(12)} ${link}${detail_str}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  console.log(`[LOG] ${line.trim()}`);
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
          const timer = setTimeout(() => {
            stream.destroy();
            reject(new Error(`Command timed out: ${megaCommand}`));
          }, 10000);

          docker.modem.demuxStream(stream,
            { write: chunk => { stdout += chunk.toString(); } },
            { write: chunk => { stderr += chunk.toString(); } }
          );

          stream.on('end', () => {
            clearTimeout(timer);
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

          stream.on('error', err => { clearTimeout(timer); reject(err); });
        });
      }
    );
  });
}

// ── Transfer parsing ──────────────────────────────────────────────────────────
const COL_MAP = [
  [['tag'],                      'tag'],
  [['type'],                     'type'],
  [['filename', 'name', 'path'], 'filename'],
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
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const fieldMap = mapHeaders(lines[0].split('|'));
  const get = (parts, name) => {
    const i = fieldMap.indexOf(name);
    return i >= 0 ? (parts[i] || '').trim() : '';
  };

  const transfers = [];
  for (let i = 1; i < lines.length; i++) {
    const parts     = lines[i].split('|');
    const typeVal   = get(parts, 'type');
    const direction = typeToDirection(typeVal);
    const stateRaw  = get(parts, 'state');
    const pMatch    = get(parts, 'progress').match(/(\d+(?:\.\d+)?)/);

    transfers.push({
      tag:         get(parts, 'tag'),
      direction,
      filename:    get(parts, 'filename'),
      progress:    pMatch ? parseFloat(pMatch[1]) : 0,
      speed:       get(parts, 'speed') || '0 B/s',
      transferred: get(parts, 'transferred'),
      total:       get(parts, 'total'),
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
  const firstLine = raw.split('\n').find(l => l.trim()) || '';
  return firstLine.includes('|') ? parsePipeTransfers(raw) : parseLegacyTransfers(raw);
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
    } else if (!/^(See|Use) /i.test(line) && !/^Transfer not started/i.test(line)) {
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

function addToQueue(links, dest) {
  const items = links.map(link => ({
    id: queueId(), link, dest,
    addedAt: new Date().toISOString(),
    lastAttempt: null, lastError: null, status: 'pending',
  }));
  retryQueue.push(...items);
  saveQueue();
  items.forEach(i => logActivity('QUEUED', i.link, i.dest));
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
      await dockerExec('mega-get', [item.link, item.dest]);
      logActivity('DOWNLOADED', item.link, item.dest);
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
    }
  }

  if (retryQueue.some(q => q.status === 'pending')) scheduleRetry();
}

loadQueue();
if (retryQueue.some(q => q.status === 'pending')) scheduleRetry();

// ── API routes ────────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const whoami = await dockerExec('mega-whoami');
    const text = whoami.trim();
    res.json({ loggedIn: text.length > 0 && !/not logged/i.test(text), whoami: text });
  } catch (err) {
    res.json({ loggedIn: false, whoami: err.message });
  }
});

app.post('/api/download', async (req, res) => {
  const { links, dest } = req.body;
  if (!Array.isArray(links) || links.length === 0)
    return res.status(400).json({ error: 'No links provided' });

  const destination = (typeof dest === 'string' && dest.trim()) ? dest.trim() : '/downloads/';
  const results = [];

  for (const rawLink of links) {
    const link = typeof rawLink === 'string' ? rawLink.trim() : '';
    if (!link) continue;
    try {
      await dockerExec('mega-get', [link, destination]);
      logActivity('DOWNLOADED', link, destination);
      results.push({ link, success: true });
    } catch (err) {
      const error = cleanMegaError(err.message);
      const quotaExceeded = /bandwidth quota/i.test(err.message);
      results.push({ link, success: false, error, quotaExceeded });
    }
  }

  // Auto-add quota-blocked links to the retry queue
  const quotaLinks = results.filter(r => r.quotaExceeded).map(r => r.link);
  if (quotaLinks.length) addToQueue(quotaLinks, destination);

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
  const destination = (typeof dest === 'string' && dest.trim()) ? dest.trim() : '/downloads/';
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

app.listen(PORT, () => {
  console.log(`MEGAcmd UI running on port ${PORT}`);
  console.log(`MEGACMD_CONTAINER: ${MEGACMD_CONTAINER}`);
});
