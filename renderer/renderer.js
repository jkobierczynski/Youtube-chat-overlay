(async () => {
  const messagesEl = document.getElementById('messages');
  const statusEl = document.getElementById('status');
  const trackEl = document.getElementById('ticker-track');

  let settings = {
    mode: 'stacked',
    fontSize: 16,
    opacity: 0.85,
    maxMessages: 20,
    speed: 140,
    gap: 80,
    maxWidth: 480,
    maxLines: 2,
  };
  const activeChips = []; // { el, internalX, width } -- currently on-screen ticker pills
  let contentWidth = 0; // right edge of the last chip, in the track's own (ever-growing) coordinate space
  let currentShiftX = 0; // the track's current translateX, i.e. contentWidth's on-screen offset
  let cleanupTimer = null;

  function colorFor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 65%, 45%)`;
  }

  function buildAvatar(m) {
    const avatar = document.createElement('div');
    if (m.avatar) {
      avatar.className = 'avatar';
      avatar.style.backgroundImage = `url(${m.avatar})`;
    } else {
      avatar.className = 'avatar fallback';
      avatar.style.background = colorFor(m.author);
      avatar.textContent = (m.author[0] || '?').toUpperCase();
    }
    return avatar;
  }

  function buildAuthorSpan(m) {
    const authorSpan = document.createElement('span');
    authorSpan.className = 'author';
    if (m.isOwner) authorSpan.classList.add('owner');
    else if (m.isModerator) authorSpan.classList.add('moderator');
    else if (m.isMember) authorSpan.classList.add('member');
    authorSpan.textContent = m.author;

    if (m.isModerator) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '🔧';
      authorSpan.appendChild(badge);
    }
    return authorSpan;
  }

  // ---- Stacked mode: a growing column of message boxes ----

  function renderStackedMessage(m) {
    const row = document.createElement('div');
    row.className = 'msg ' + m.kind;
    row.appendChild(buildAvatar(m));

    const body = document.createElement('div');
    body.className = 'body';
    body.appendChild(buildAuthorSpan(m));
    body.appendChild(document.createTextNode(m.text));

    row.appendChild(body);
    return row;
  }

  function trimStacked() {
    while (messagesEl.children.length > (settings.maxMessages || 20)) {
      messagesEl.removeChild(messagesEl.firstChild);
    }
  }

  // ---- Ticker mode: a queue of pills that only shifts left when a new
  // message arrives and needs room -- nothing drifts on its own. ----

  function resetTicker() {
    for (const c of activeChips) c.el.remove();
    activeChips.length = 0;
    contentWidth = 0;
    clearTimeout(cleanupTimer);

    // Park the (empty) track just off the right edge, instantly.
    currentShiftX = trackEl.clientWidth;
    trackEl.style.transitionDuration = '0ms';
    trackEl.style.transform = `translateX(${currentShiftX}px)`;
  }

  function cleanupOffscreenChips() {
    for (let i = activeChips.length - 1; i >= 0; i--) {
      const c = activeChips[i];
      if (c.internalX + currentShiftX + c.width < -20) {
        c.el.remove();
        activeChips.splice(i, 1);
      }
    }
  }

  // Slides the whole track left just far enough to fit whatever was just
  // added, then holds -- everything already on screen stays put until the
  // next message shows up and needs the room in turn. `distance` is the
  // total width (messages + gaps) added since the last shift, so a batch of
  // several messages arriving in one poll still moves at the configured
  // speed instead of snapping straight to the end.
  function shiftTrack(distance) {
    if (distance <= 0) return;
    const speed = settings.speed || 140; // pixels/second
    const durationMs = Math.max(150, (distance / speed) * 1000);
    const windowWidth = trackEl.clientWidth;

    currentShiftX = windowWidth - contentWidth;
    trackEl.style.transitionDuration = durationMs + 'ms';
    trackEl.style.transform = `translateX(${currentShiftX}px)`;

    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(cleanupOffscreenChips, durationMs + 50);
  }

  // Adds one chip's worth of bookkeeping (position + width) without moving
  // anything yet -- callers add a whole batch this way, then shift once.
  function placeTickerChip(m) {
    const chip = document.createElement('div');
    chip.className = 'ticker-chip ' + m.kind;
    chip.appendChild(buildAvatar(m));

    const body = document.createElement('span');
    body.className = 'body';
    body.appendChild(buildAuthorSpan(m));
    body.appendChild(document.createTextNode(m.text));
    chip.appendChild(body);

    // Measure without a visible flash: append hidden, size it, then place it
    // at its fixed slot (its own transform never changes again after this --
    // only the shared track transform moves it, along with everything else).
    chip.style.visibility = 'hidden';
    trackEl.appendChild(chip);
    const width = chip.offsetWidth;

    const gap = settings.gap || 80;
    const internalX = contentWidth === 0 ? 0 : contentWidth + gap;
    // translateY(-50%) combined with `top: 50%` in CSS keeps the chip
    // vertically centered whether it ends up one line tall or two.
    chip.style.transform = `translate(${internalX}px, -50%)`;
    chip.style.visibility = '';

    activeChips.push({ el: chip, internalX, width });
    contentWidth = internalX + width;
  }

  // ---- Mode switching ----

  function applySettings(s) {
    const prevMode = settings.mode;
    settings = s;

    document.body.classList.remove('mode-stacked', 'mode-ticker');
    document.body.classList.add('mode-' + s.mode);
    document.body.style.fontSize = (s.fontSize || 16) + 'px';
    document.documentElement.style.setProperty('--overlay-alpha', s.opacity ?? 0.85);
    document.documentElement.style.setProperty('--ticker-max-width', (s.maxWidth ?? 480) + 'px');
    document.documentElement.style.setProperty('--ticker-max-lines', s.maxLines ?? 2);

    if (s.mode !== prevMode) {
      if (s.mode === 'ticker') {
        messagesEl.innerHTML = '';
        resetTicker();
      } else {
        for (const c of activeChips) c.el.remove();
        activeChips.length = 0;
        contentWidth = 0;
        clearTimeout(cleanupTimer);
      }
    }
  }

  // ---- Wire up IPC ----

  window.overlay.onChatMessages((messages) => {
    statusEl.classList.remove('visible');
    if (settings.mode === 'ticker') {
      const startWidth = contentWidth;
      for (const m of messages) placeTickerChip(m);
      shiftTrack(contentWidth - startWidth);
    } else {
      for (const m of messages) messagesEl.appendChild(renderStackedMessage(m));
      trimStacked();
    }
  });

  window.overlay.onStatus((text) => {
    statusEl.textContent = text;
    statusEl.classList.add('visible');
  });

  window.overlay.onMoveMode((enabled) => {
    document.body.classList.toggle('move-mode', enabled);
  });

  window.overlay.onDisplayMode((s) => applySettings(s));

  applySettings(await window.overlay.getConfig());
})();
