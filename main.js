'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const { getAuthorizedClient } = require('./auth');
const { findActiveLiveChatId, pollChat } = require('./youtube');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const VALID_MODES = ['stacked', 'ticker'];

let config = loadConfig();
let win = null;
let auth = null;

let currentMode = VALID_MODES.includes(config.displayMode) ? config.displayMode : 'stacked';
let liveChatId = null;
let nextPageToken = undefined;
let pollTimer = null;
let broadcastWatchTimer = null;
let moveMode = false;
let seenMessageIds = new Set();

const BROADCAST_CHECK_INTERVAL_MS = 30 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const QUOTA_RETRY_BUFFER_MS = 2 * 60 * 1000; // pad past the reset in case of clock skew

function errorReason(err) {
  return String(err?.errors?.[0]?.reason || err?.message || 'unknown error');
}

function isQuotaError(reason) {
  const r = reason.toLowerCase();
  return r.includes('quotaexceeded') || r.includes('dailylimitexceeded');
}

// YouTube's API quota resets at midnight Pacific Time, not local time and not
// a rolling 24h window. Building this from Intl's LA wall-clock values (and
// treating that time-of-day as if it were UTC) sidesteps DST arithmetic --
// we never need to know today's PT/PDT offset, just the current PT hour.
function msUntilQuotaReset() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date());

  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const msSinceLaMidnight =
    (((get('hour') % 24) * 60 + get('minute')) * 60 + get('second')) * 1000;

  return 24 * 60 * 60 * 1000 - msSinceLaMidnight;
}

function quotaResetStatusMessage(waitMs) {
  const eta = new Date(Date.now() + waitMs);
  const local = eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Daily YouTube API quota used up for today. Will try again around ${local} (quota resets at midnight Pacific time).`;
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function sendStatus(text) {
  if (win && !win.isDestroyed()) win.webContents.send('status', text);
}

// Fills in a mode's saved layout, substituting screen-relative defaults for
// any value left as `null` in config.json (that's how "ticker" gets its
// full-width bottom bar without you having to compute pixel positions).
function resolveBounds(mode) {
  const layout = (config.layouts && config.layouts[mode]) || {};
  const { workArea } = screen.getPrimaryDisplay();

  const height = layout.height ?? (mode === 'ticker' ? 70 : 640);
  const width = layout.width ?? (mode === 'ticker' ? workArea.width : 420);
  const x = layout.x ?? (mode === 'ticker' ? workArea.x : workArea.x + 40);
  const y =
    layout.y ??
    (mode === 'ticker' ? workArea.y + workArea.height - height : workArea.y + 40);

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

// Settings the renderer needs for whatever mode is currently active.
function buildRendererConfig() {
  const layout = (config.layouts && config.layouts[currentMode]) || {};
  return {
    mode: currentMode,
    fontSize: layout.fontSize ?? (currentMode === 'ticker' ? 20 : 16),
    opacity: layout.opacity ?? (currentMode === 'ticker' ? 0.75 : 0.85),
    maxMessages: layout.maxMessages ?? 20,
    speed: layout.speed ?? 140,
    gap: layout.gap ?? 80,
    maxWidth: layout.maxWidth ?? 480,
    maxLines: layout.maxLines ?? 2,
  };
}

function createWindow() {
  const bounds = resolveBounds(currentMode);

  win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 'screen-saver' level keeps the overlay above most games running in
  // borderless/windowed mode. True exclusive fullscreen bypasses the desktop
  // compositor entirely, so no overlay (from any app) can render over it --
  // see README for how to avoid that in your game's display settings.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('closed', () => {
    win = null;
  });

  return win;
}

function setMoveMode(enabled) {
  if (!win || win.isDestroyed()) return;
  moveMode = enabled;
  win.setIgnoreMouseEvents(!enabled, { forward: true });
  win.setResizable(enabled);
  win.setMovable(enabled);
  win.webContents.send('move-mode', enabled);

  if (!enabled) {
    // Moving out of move mode: persist wherever the window ended up, scoped
    // to whichever display mode was active while you moved it.
    const bounds = win.getBounds();
    config.layouts[currentMode] = { ...config.layouts[currentMode], ...bounds };
    saveConfig();
  }
}

// Switches between the stacked chat box and the scrolling ticker bar, live,
// without restarting the app. Can be called from the hotkey or by editing
// "displayMode" in config.json and relaunching.
function setDisplayMode(mode) {
  if (!VALID_MODES.includes(mode) || mode === currentMode) return;
  if (!win || win.isDestroyed()) return;

  if (moveMode) setMoveMode(false);

  currentMode = mode;
  config.displayMode = mode;
  saveConfig();

  win.setBounds(resolveBounds(mode));
  win.webContents.send('display-mode', buildRendererConfig());
}

function registerHotkeys() {
  const hk = config.hotkeys || {};

  if (hk.toggleMoveMode) {
    globalShortcut.register(hk.toggleMoveMode, () => setMoveMode(!moveMode));
  }
  if (hk.toggleVisibility) {
    globalShortcut.register(hk.toggleVisibility, () => {
      if (!win || win.isDestroyed()) return;
      if (win.isVisible()) win.hide();
      else win.show();
    });
  }
  if (hk.toggleDisplayMode) {
    globalShortcut.register(hk.toggleDisplayMode, () => {
      setDisplayMode(currentMode === 'stacked' ? 'ticker' : 'stacked');
    });
  }
  if (hk.quit) {
    globalShortcut.register(hk.quit, () => app.quit());
  }
}

function clearPollTimer() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function pollLoop() {
  if (!liveChatId) return;

  try {
    const data = await pollChat(auth, liveChatId, nextPageToken);
    nextPageToken = data.nextPageToken;

    const fresh = (data.items || []).filter((item) => {
      if (seenMessageIds.has(item.id)) return false;
      seenMessageIds.add(item.id);
      return true;
    });

    if (fresh.length > 0 && win && !win.isDestroyed()) {
      win.webContents.send(
        'chat-messages',
        fresh.map(toRendererMessage)
      );
    }

    // Cap memory use for the dedupe set over a long stream.
    if (seenMessageIds.size > 5000) {
      seenMessageIds = new Set(Array.from(seenMessageIds).slice(-2000));
    }

    const interval = Math.max(data.pollingIntervalMillis || DEFAULT_POLL_INTERVAL_MS, 2000);
    pollTimer = setTimeout(pollLoop, interval);
  } catch (err) {
    const reason = errorReason(err);
    console.error('Chat poll failed:', reason);

    if (reason.toLowerCase().includes('livechatended') ||
        reason.toLowerCase().includes('livechatnotfound')) {
      // Stream ended (or chat was disabled) -- go back to watching for the
      // next broadcast instead of hammering a dead chat ID.
      liveChatId = null;
      nextPageToken = undefined;
      sendStatus('Stream ended. Waiting for your next live broadcast…');
      startBroadcastWatch();
      return;
    }

    if (isQuotaError(reason)) {
      // The day's 10,000-unit quota is gone -- retrying every few seconds
      // would just print the same error forever for no benefit. Wait for
      // the actual reset instead of burning CPU (and log spam) until then.
      const waitMs = msUntilQuotaReset() + QUOTA_RETRY_BUFFER_MS;
      sendStatus(quotaResetStatusMessage(waitMs));
      pollTimer = setTimeout(pollLoop, waitMs);
      return;
    }

    // Transient error (network blip, rate limit, etc.) -- back off and retry.
    pollTimer = setTimeout(pollLoop, 10000);
  }
}

function startBroadcastWatch() {
  if (broadcastWatchTimer) return;

  const check = async () => {
    try {
      const id = await findActiveLiveChatId(auth);
      if (id) {
        liveChatId = id;
        nextPageToken = undefined;
        seenMessageIds = new Set();
        clearInterval(broadcastWatchTimer);
        broadcastWatchTimer = null;
        sendStatus('Connected to live chat.');
        pollLoop();
        return;
      }
      sendStatus('Waiting for you to go live…');
    } catch (err) {
      const reason = errorReason(err);
      console.error('Broadcast check failed:', reason);

      if (isQuotaError(reason)) {
        clearInterval(broadcastWatchTimer);
        broadcastWatchTimer = null;
        const waitMs = msUntilQuotaReset() + QUOTA_RETRY_BUFFER_MS;
        sendStatus(quotaResetStatusMessage(waitMs));
        setTimeout(startBroadcastWatch, waitMs);
        return;
      }

      sendStatus('Could not reach YouTube. Retrying…');
    }
  };

  check();
  broadcastWatchTimer = setInterval(check, BROADCAST_CHECK_INTERVAL_MS);
}

function toRendererMessage(item) {
  const snippet = item.snippet || {};
  const author = item.authorDetails || {};

  let text = snippet.displayMessage || '';
  let kind = 'text';

  if (snippet.type === 'superChatEvent' && snippet.superChatDetails) {
    kind = 'superchat';
    text = `${snippet.superChatDetails.amountDisplayString} — ${snippet.superChatDetails.userComment || ''}`;
  } else if (snippet.type === 'superStickerEvent') {
    kind = 'superchat';
    text = `sent a Super Sticker (${snippet.superStickerDetails?.amountDisplayString || ''})`;
  } else if (snippet.type === 'newSponsorEvent') {
    kind = 'event';
    text = 'became a new member!';
  } else if (snippet.type === 'memberMilestoneChatEvent') {
    kind = 'event';
    text = snippet.memberMilestoneChatDetails?.userComment || 'is celebrating a membership milestone!';
  }

  return {
    id: item.id,
    author: author.displayName || 'Unknown',
    avatar: author.profileImageUrl || '',
    isOwner: !!author.isChatOwner,
    isModerator: !!author.isChatModerator,
    isMember: !!author.isChatSponsor,
    kind,
    text,
    publishedAt: snippet.publishedAt,
  };
}

async function start() {
  // Register before creating the window: the renderer asks for config as
  // soon as its script runs, and we don't want to race that request.
  ipcMain.handle('get-config', () => buildRendererConfig());

  createWindow();
  registerHotkeys();

  try {
    sendStatus('Signing in to YouTube…');
    auth = await getAuthorizedClient(app, config);
    sendStatus('Looking for your live broadcast…');
    startBroadcastWatch();
  } catch (err) {
    console.error(err);
    sendStatus('Setup error: ' + (err.message || err));
  }
}

app.whenReady().then(start);

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearPollTimer();
  if (broadcastWatchTimer) clearInterval(broadcastWatchTimer);
});
