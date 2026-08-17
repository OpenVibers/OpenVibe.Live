let canvasPageBootstrapped = false;
let canvasSocket = null;
let canvasBoardState = null;
let canvasTiles = new Map();
let canvasPresence = [];
let canvasActivity = [];
let canvasCursor = { x: 256, y: 256 };
let canvasHover = null;
let canvasSelectedColor = 1;
let canvasZoom = 2;
let canvasOffsetX = 0;
let canvasOffsetY = 0;
let canvasPanning = false;
let canvasDragStart = null;
let canvasRenderQueued = false;
let canvasUiTimer = null;
let canvasBitmap = null;
let canvasBitmapCtx = null;
let canvasBoundEvents = false;
let canvasShowGrid = true;
let canvasResizeObserver = null;
let canvasPlacedCount = 0;
let canvasLastPlaceTime = 0;

/* Helper: ensure timestamp string is valid ISO for Date() parsing */
function toIso(ts) {
    if (!ts) return ts;
    if (typeof ts === 'string' && !ts.includes('T') && ts.includes(' ')) {
        return ts.replace(' ', 'T') + (ts.endsWith('Z') ? '' : 'Z');
    }
    return ts;
}

/* ── Canvas Sizing — CRITICAL for correct tile coords ── */
function resizeCanvasBoard() {
    const canvas = document.getElementById('canvas-board');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        queueCanvasRender();
    }
}

const PALETTE_NAMES = [
    'Background', 'White', 'Light Gray', 'Dark Gray', 'Black',
    'Pink', 'Red', 'Orange', 'Yellow', 'Lime',
    'Green', 'Cyan', 'Blue', 'Indigo', 'Purple',
    'Brown', 'Beige', 'Maroon', 'Teal', 'Navy',
    'Coral', 'Gold', 'Mint', 'Lavender', 'Salmon',
    'Sky Blue', 'Rose', 'Olive', 'Slate', 'Crimson',
    'Sand', 'Forest'
];

function buildCanvasPalette(colors) {
    const palette = document.getElementById('canvas-palette');
    if (!palette) return;
    palette.innerHTML = (colors || []).map((color, index) => {
        if (index === 0) return ''; // skip background color
        const name = PALETTE_NAMES[index] || `Color ${index}`;
        const active = index === canvasSelectedColor;
        return `<button class="canvas-swatch ${active ? 'active' : ''}" style="background:${color}" onclick="selectCanvasColor(${index})" title="${name} (${color})"></button>`;
    }).join('');
    // Update selected color preview
    const preview = document.getElementById('canvas-color-preview');
    if (preview && colors) {
        const selColor = colors[canvasSelectedColor] || colors[1];
        const selName = PALETTE_NAMES[canvasSelectedColor] || `Color ${canvasSelectedColor}`;
        preview.innerHTML = `<span class="canvas-preview-dot" style="background:${selColor}"></span> ${selName}`;
    }
}

function selectCanvasColor(index) {
    canvasSelectedColor = index;
    buildCanvasPalette(canvasBoardState?.board?.palette || []);
    queueCanvasRender();
}

function resetCanvasCamera() {
    const canvas = document.getElementById('canvas-board');
    if (!canvas || !canvasBoardState) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;
    canvasZoom = Math.max(1, Math.min(cw / canvasBoardState.board.width, ch / canvasBoardState.board.height));
    canvasOffsetX = Math.floor((cw - canvasBoardState.board.width * canvasZoom) / 2);
    canvasOffsetY = Math.floor((ch - canvasBoardState.board.height * canvasZoom) / 2);
    queueCanvasRender();
}

function centerCanvasCursor() {
    const canvas = document.getElementById('canvas-board');
    if (!canvas || !canvasBoardState) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;
    canvasOffsetX = Math.floor(cw / 2 - (canvasCursor.x + 0.5) * canvasZoom);
    canvasOffsetY = Math.floor(ch / 2 - (canvasCursor.y + 0.5) * canvasZoom);
    queueCanvasRender();
}

function syncCanvasAuthState() {
    const prompt = document.getElementById('canvas-login-prompt');
    if (prompt) prompt.style.display = currentUser ? 'none' : '';
}

function setupCanvasBitmap() {
    if (!canvasBoardState) return;
    canvasBitmap = document.createElement('canvas');
    canvasBitmap.width = canvasBoardState.board.width;
    canvasBitmap.height = canvasBoardState.board.height;
    canvasBitmapCtx = canvasBitmap.getContext('2d');
    paintCanvasBitmapBackground();
}

function paintCanvasBitmapBackground() {
    if (!canvasBitmapCtx || !canvasBoardState) return;
    canvasBitmapCtx.fillStyle = canvasBoardState.board.palette[0] || '#101418';
    canvasBitmapCtx.fillRect(0, 0, canvasBitmap.width, canvasBitmap.height);
}

function applyCanvasTiles(tiles) {
    for (const tile of tiles || []) {
        const key = `${tile.x},${tile.y}`;
        if (Number(tile.color_index || 0) === 0) {
            canvasTiles.delete(key);
        } else {
            canvasTiles.set(key, tile);
        }
        if (canvasBitmapCtx && canvasBoardState) {
            canvasBitmapCtx.fillStyle = canvasBoardState.board.palette[Number(tile.color_index || 0)] || canvasBoardState.board.palette[0];
            canvasBitmapCtx.fillRect(tile.x, tile.y, 1, 1);
        }
    }
}

function replaceCanvasTiles(tiles) {
    canvasTiles = new Map();
    paintCanvasBitmapBackground();
    applyCanvasTiles(tiles || []);
}

function queueCanvasRender() {
    if (canvasRenderQueued) return;
    canvasRenderQueued = true;
    requestAnimationFrame(() => {
        canvasRenderQueued = false;
        renderCanvasBoard();
    });
}

function renderCanvasBoard() {
    const canvas = document.getElementById('canvas-board');
    if (!canvas || !canvasBitmap || !canvasBoardState) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#0f1318';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(canvasBitmap, canvasOffsetX, canvasOffsetY, canvasBitmap.width * canvasZoom, canvasBitmap.height * canvasZoom);

    // Grid lines at high zoom
    if (canvasShowGrid && canvasZoom >= 6) {
        ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.15, (canvasZoom - 6) * 0.02)})`;
        ctx.lineWidth = 0.5;
        const startX = Math.max(0, Math.floor(-canvasOffsetX / canvasZoom));
        const endX = Math.min(canvasBitmap.width, Math.ceil((cw - canvasOffsetX) / canvasZoom));
        const startY = Math.max(0, Math.floor(-canvasOffsetY / canvasZoom));
        const endY = Math.min(canvasBitmap.height, Math.ceil((ch - canvasOffsetY) / canvasZoom));
        for (let x = startX; x <= endX; x++) {
            const drawX = Math.round(canvasOffsetX + x * canvasZoom) + 0.5;
            ctx.beginPath();
            ctx.moveTo(drawX, Math.max(0, canvasOffsetY));
            ctx.lineTo(drawX, Math.min(ch, canvasOffsetY + canvasBitmap.height * canvasZoom));
            ctx.stroke();
        }
        for (let y = startY; y <= endY; y++) {
            const drawY = Math.round(canvasOffsetY + y * canvasZoom) + 0.5;
            ctx.beginPath();
            ctx.moveTo(Math.max(0, canvasOffsetX), drawY);
            ctx.lineTo(Math.min(cw, canvasOffsetX + canvasBitmap.width * canvasZoom), drawY);
            ctx.stroke();
        }
    }

    // Cursor highlight — show selected color as ghost
    const cursorX = canvasOffsetX + canvasCursor.x * canvasZoom;
    const cursorY = canvasOffsetY + canvasCursor.y * canvasZoom;
    const palette = canvasBoardState.board.palette;
    if (palette[canvasSelectedColor]) {
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = palette[canvasSelectedColor];
        ctx.fillRect(cursorX, cursorY, canvasZoom, canvasZoom);
        ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(cursorX + 1, cursorY + 1, canvasZoom - 2, canvasZoom - 2);

    // Other users' cursors
    canvasPresence.forEach((entry) => {
        if (!entry.cursor) return;
        const px = canvasOffsetX + (entry.cursor.x + 0.5) * canvasZoom;
        const py = canvasOffsetY + (entry.cursor.y + 0.5) * canvasZoom;
        ctx.beginPath();
        ctx.fillStyle = '#7ecbff';
        ctx.arc(px, py, Math.max(3, Math.min(6, canvasZoom / 2)), 0, Math.PI * 2);
        ctx.fill();
        // Username label at high zoom
        if (canvasZoom >= 4 && entry.username) {
            ctx.font = `${Math.min(11, canvasZoom * 0.8)}px sans-serif`;
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.fillText(entry.username, px + canvasZoom * 0.5 + 4, py + 3);
        }
    });

    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function canvasTileFromPoint(clientX, clientY) {
    const canvas = document.getElementById('canvas-board');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    // Use CSS coordinates (not canvas pixel coords)
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const x = Math.floor((cssX - canvasOffsetX) / canvasZoom);
    const y = Math.floor((cssY - canvasOffsetY) / canvasZoom);
    if (!canvasBoardState || x < 0 || y < 0 || x >= canvasBoardState.board.width || y >= canvasBoardState.board.height) return null;
    return { x, y };
}

function updateCanvasHover(tile) {
    canvasHover = tile;
    const meta = document.getElementById('canvas-hover');
    const coords = document.getElementById('canvas-coords');
    if (coords) coords.textContent = tile ? `Tile: ${tile.x}, ${tile.y}` : 'Hover over the canvas';
    if (!meta) return;
    if (!tile) {
        meta.textContent = 'Hover over a tile to see details';
        return;
    }
    const stored = canvasTiles.get(`${tile.x},${tile.y}`);
    if (!stored) {
        meta.innerHTML = `Tile <strong>${tile.x}, ${tile.y}</strong><br>Empty — click to paint!`;
        return;
    }
    // Calculate tile lock status
    let lockInfo = '';
    if (stored.updated_at) {
        const updatedMs = new Date(toIso(stored.updated_at)).getTime();
        const tileCooldown = (canvasBoardState?.settings?.tile_cooldown_seconds || 20) * 1000;
        const unlockAt = updatedMs + tileCooldown;
        const remaining = Math.ceil(Math.max(0, unlockAt - Date.now()) / 1000);
        if (remaining > 0) {
            lockInfo = `<br><span style="color:#f6ad55"><i class="fa-solid fa-lock"></i> Locked (${remaining}s)</span>`;
        } else {
            lockInfo = `<br><span style="color:#68d391"><i class="fa-solid fa-lock-open"></i> Can override</span>`;
        }
    }
    meta.innerHTML = `
        Tile <strong>${tile.x}, ${tile.y}</strong><br>
        Color: ${stored.color_index}<br>
        By: ${esc(stored.username || 'unknown')}<br>
        Updated: ${stored.updated_at ? new Date(toIso(stored.updated_at)).toLocaleString() : 'unknown'}${lockInfo}
    `;
}

function pushCanvasActivity(entries) {
    const next = (entries || []).filter((entry) => entry.action_type !== 'blocked');
    canvasActivity = [...next, ...canvasActivity].slice(0, 60);
    const list = document.getElementById('canvas-activity');
    if (!list) return;
    if (!canvasActivity.length) {
        list.innerHTML = '<div class="muted">No activity yet.</div>';
        return;
    }
    list.innerHTML = canvasActivity.slice(0, 30).map((entry) => {
        const time = entry.created_at ? new Date(toIso(entry.created_at)).toLocaleTimeString() : '';
        if (entry.action_type === 'place') {
            return `<div class="canvas-activity-row"><strong>${esc(entry.username || 'unknown')}</strong> placed color ${entry.color_index} at ${entry.x},${entry.y}<span class="muted">${time}</span></div>`;
        }
        if (entry.action_type === 'rollback') {
            return `<div class="canvas-activity-row"><strong>${esc(entry.username || 'staff')}</strong> rolled back ${entry.x},${entry.y}<span class="muted">${time}</span></div>`;
        }
        return `<div class="canvas-activity-row"><strong>${esc(entry.action_type)}</strong><span class="muted">${time}</span></div>`;
    }).join('');
}

function renderCanvasPresence() {
    const list = document.getElementById('canvas-presence');
    const count = document.getElementById('canvas-online');
    if (count) count.innerHTML = `<i class="fa-solid fa-users"></i> ${canvasPresence.length} online`;
    if (!list) return;
    if (!canvasPresence.length) {
        list.innerHTML = '<div class="muted">No active cursors.</div>';
        return;
    }
    list.innerHTML = canvasPresence.slice(0, 20).map((entry) => `
        <div class="canvas-presence-row">
            <strong>${esc(entry.username || 'viewer')}</strong>
            <span class="muted">${entry.cursor ? `${entry.cursor.x}, ${entry.cursor.y}` : 'watching'}</span>
        </div>
    `).join('');
}

function renderCanvasBoardMode() {
    const status = document.getElementById('canvas-status');
    if (!status || !canvasBoardState) return;
    const mode = canvasBoardState.settings?.frozen ? 'Frozen' : canvasBoardState.settings?.read_only ? 'Read Only' : 'Live';
    status.textContent = `Board status: ${mode}`;
}

function updateCanvasCooldownText() {
    const el = document.getElementById('canvas-cooldown');
    if (!el) return;
    if (!currentUser) {
        el.innerHTML = '<span class="canvas-cd-text"><i class="fa-solid fa-lock"></i> Login required to paint</span>';
        return;
    }
    const cooldown = canvasBoardState?.cooldown;
    if (!cooldown) {
        el.innerHTML = '<span class="canvas-cd-text">--</span>';
        return;
    }
    const totalMs = (cooldown.cooldown_seconds || 5) * 1000;
    const remainMs = Math.max(0, cooldown.remaining_ms || 0);
    const seconds = Math.ceil(remainMs / 1000);

    // Decrease remaining_ms by ~500ms each tick (the timer fires every 500ms)
    if (cooldown.remaining_ms > 0) {
        cooldown.remaining_ms = Math.max(0, cooldown.remaining_ms - 500);
    }

    if (seconds > 0) {
        const pct = Math.min(100, (remainMs / totalMs) * 100);
        el.innerHTML = `
            <div class="canvas-cd-bar-track">
                <div class="canvas-cd-bar-fill" style="width:${pct}%"></div>
            </div>
            <span class="canvas-cd-text"><i class="fa-solid fa-hourglass-half"></i> ${seconds}s</span>`;
    } else {
        el.innerHTML = `<span class="canvas-cd-text canvas-cd-ready"><i class="fa-solid fa-check-circle"></i> Ready! <span class="muted">(${cooldown.cooldown_seconds}s base, lv${cooldown.total_level})</span></span>`;
    }
}

async function fetchCanvasState() {
    const data = await api('/game/canvas/state');
    canvasBoardState = data;
    setupCanvasBitmap();
    replaceCanvasTiles(data.tiles);
    canvasActivity = data.recent_actions || [];
    buildCanvasPalette(data.board.palette);
    renderCanvasBoardMode();
    pushCanvasActivity([]);
    syncCanvasAuthState();
    resizeCanvasBoard();
    resetCanvasCamera();
    queueCanvasRender();
    updateCanvasCooldownText();
}

function attachCanvasEvents() {
    if (canvasBoundEvents) return;
    canvasBoundEvents = true;
    const canvas = document.getElementById('canvas-board');
    if (!canvas) return;

    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    /* ── Mouse events ── */
    canvas.addEventListener('mousedown', (event) => {
        if (event.button === 2 || event.button === 1) {
            event.preventDefault();
            canvasPanning = true;
            canvasDragStart = { x: event.clientX, y: event.clientY, ox: canvasOffsetX, oy: canvasOffsetY };
            canvas.style.cursor = 'grabbing';
            return;
        }
        const tile = canvasTileFromPoint(event.clientX, event.clientY);
        if (!tile) return;
        canvasCursor = tile;
        updateCanvasHover(tile);
        sendCanvasCursor();
        if (event.button === 0) placeCanvasTile(tile.x, tile.y);
        queueCanvasRender();
    });
    canvas.addEventListener('mousemove', (event) => {
        if (canvasPanning && canvasDragStart) {
            canvasOffsetX = canvasDragStart.ox + (event.clientX - canvasDragStart.x);
            canvasOffsetY = canvasDragStart.oy + (event.clientY - canvasDragStart.y);
            queueCanvasRender();
            return;
        }
        const tile = canvasTileFromPoint(event.clientX, event.clientY);
        if (tile) canvasCursor = tile;
        updateCanvasHover(tile);
        queueCanvasRender();
    });
    window.addEventListener('mouseup', () => {
        if (canvasPanning) {
            canvasPanning = false;
            canvasDragStart = null;
            canvas.style.cursor = 'crosshair';
        }
    });
    canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        const tileBefore = canvasTileFromPoint(event.clientX, event.clientY);
        const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
        canvasZoom = Math.max(0.5, Math.min(40, canvasZoom * factor));
        if (tileBefore) {
            const rect = canvas.getBoundingClientRect();
            canvasOffsetX = event.clientX - rect.left - tileBefore.x * canvasZoom;
            canvasOffsetY = event.clientY - rect.top - tileBefore.y * canvasZoom;
        }
        queueCanvasRender();
    }, { passive: false });

    /* ── Touch events (mobile pinch-zoom + pan + tap-to-place) ── */
    let touchIds = [];
    let lastTouchDist = 0;
    let lastTouchMid = { x: 0, y: 0 };
    let touchMoved = false;

    canvas.addEventListener('touchstart', (event) => {
        event.preventDefault();
        const touches = event.touches;
        touchMoved = false;
        if (touches.length === 1) {
            canvasPanning = true;
            canvasDragStart = { x: touches[0].clientX, y: touches[0].clientY, ox: canvasOffsetX, oy: canvasOffsetY };
        }
        if (touches.length === 2) {
            canvasPanning = false;
            canvasDragStart = null;
            const dx = touches[1].clientX - touches[0].clientX;
            const dy = touches[1].clientY - touches[0].clientY;
            lastTouchDist = Math.hypot(dx, dy);
            lastTouchMid = { x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 };
        }
        touchIds = Array.from(touches).map(t => t.identifier);
    }, { passive: false });

    canvas.addEventListener('touchmove', (event) => {
        event.preventDefault();
        const touches = event.touches;
        if (touches.length === 1 && canvasPanning && canvasDragStart) {
            const dx = touches[0].clientX - canvasDragStart.x;
            const dy = touches[0].clientY - canvasDragStart.y;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) touchMoved = true;
            canvasOffsetX = canvasDragStart.ox + dx;
            canvasOffsetY = canvasDragStart.oy + dy;
            queueCanvasRender();
        }
        if (touches.length === 2) {
            touchMoved = true;
            const dx = touches[1].clientX - touches[0].clientX;
            const dy = touches[1].clientY - touches[0].clientY;
            const dist = Math.hypot(dx, dy);
            const mid = { x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 };
            if (lastTouchDist > 0) {
                const scale = dist / lastTouchDist;
                const oldZoom = canvasZoom;
                canvasZoom = Math.max(0.5, Math.min(40, canvasZoom * scale));
                const rect = canvas.getBoundingClientRect();
                const cx = mid.x - rect.left;
                const cy = mid.y - rect.top;
                canvasOffsetX = cx - (cx - canvasOffsetX) * (canvasZoom / oldZoom) + (mid.x - lastTouchMid.x);
                canvasOffsetY = cy - (cy - canvasOffsetY) * (canvasZoom / oldZoom) + (mid.y - lastTouchMid.y);
            }
            lastTouchDist = dist;
            lastTouchMid = mid;
            queueCanvasRender();
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (event) => {
        event.preventDefault();
        // Tap-to-place: if single touch ended without moving
        if (!touchMoved && event.changedTouches.length === 1 && event.touches.length === 0) {
            const t = event.changedTouches[0];
            const tile = canvasTileFromPoint(t.clientX, t.clientY);
            if (tile) {
                canvasCursor = tile;
                updateCanvasHover(tile);
                sendCanvasCursor();
                placeCanvasTile(tile.x, tile.y);
                queueCanvasRender();
            }
        }
        canvasPanning = false;
        canvasDragStart = null;
        lastTouchDist = 0;
        touchIds = Array.from(event.touches).map(t => t.identifier);
    }, { passive: false });

    window.addEventListener('keydown', handleCanvasHotkeys);
}

function handleCanvasHotkeys(event) {
    if (currentPage !== 'canvas') return;
    if (event.target && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
    let moved = false;
    if (event.key === 'ArrowLeft') { canvasCursor.x = Math.max(0, canvasCursor.x - 1); moved = true; }
    if (event.key === 'ArrowRight') { canvasCursor.x = Math.min((canvasBoardState?.board?.width || 512) - 1, canvasCursor.x + 1); moved = true; }
    if (event.key === 'ArrowUp') { canvasCursor.y = Math.max(0, canvasCursor.y - 1); moved = true; }
    if (event.key === 'ArrowDown') { canvasCursor.y = Math.min((canvasBoardState?.board?.height || 512) - 1, canvasCursor.y + 1); moved = true; }
    if (moved) {
        event.preventDefault();
        updateCanvasHover(canvasCursor);
        sendCanvasCursor();
        queueCanvasRender();
    }
    if (event.key === ' ' || event.key.toLowerCase() === 'enter') {
        event.preventDefault();
        placeCanvasTile(canvasCursor.x, canvasCursor.y);
    }
    if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        resetCanvasCamera();
    }
}

function sendCanvasCursor() {
    if (canvasSocket && canvasSocket.readyState === WebSocket.OPEN) {
        canvasSocket.send(JSON.stringify({ type: 'cursor', x: canvasCursor.x, y: canvasCursor.y }));
    }
}

async function placeCanvasTile(x, y) {
    if (!currentUser) {
        syncCanvasAuthState();
        toast('Login required to place tiles', 'info');
        return;
    }
    try {
        const result = await api('/game/canvas/place', { method: 'POST', body: { x, y, color_index: canvasSelectedColor } });
        if (result.tile) {
            applyCanvasTiles([result.tile]);
            canvasBoardState.cooldown = result.cooldown;
            updateCanvasCooldownText();
            canvasPlacedCount++;
            canvasLastPlaceTime = Date.now();
            // Visual feedback — flash the stage border
            const stage = document.querySelector('.canvas-stage');
            if (stage) {
                stage.classList.remove('canvas-place-flash');
                void stage.offsetWidth; // force reflow
                stage.classList.add('canvas-place-flash');
            }
            // Update placed counter badge
            const counter = document.getElementById('canvas-place-count');
            if (counter) counter.textContent = `${canvasPlacedCount} placed`;
            queueCanvasRender();
        }
    } catch (error) {
        if (error.remaining_ms && canvasBoardState?.cooldown) {
            canvasBoardState.cooldown.remaining_ms = error.remaining_ms;
        }
        updateCanvasCooldownText();
        toast(error.message || 'Failed to place tile', 'error');
    }
}

function connectCanvasSocket() {
    if (canvasSocket) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = localStorage.getItem('token');
    const url = `${proto}//${window.location.host}/ws/canvas${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    canvasSocket = new WebSocket(url);
    canvasSocket.addEventListener('open', () => sendCanvasCursor());
    canvasSocket.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'tile_patch' && msg.tile) {
            applyCanvasTiles([msg.tile]);
            pushCanvasActivity([{ ...msg.tile, action_type: 'place', created_at: msg.tile.updated_at }]);
            queueCanvasRender();
        }
        if (msg.type === 'bulk_patch') {
            replaceCanvasTiles(msg.tiles || []);
            queueCanvasRender();
        }
        if (msg.type === 'board_reset') {
            replaceCanvasTiles([]);
            queueCanvasRender();
        }
        if (msg.type === 'board_state') {
            canvasBoardState.settings = { ...canvasBoardState.settings, ...msg.settings };
            renderCanvasBoardMode();
        }
        if (msg.type === 'presence' || msg.type === 'presence_snapshot') {
            canvasPresence = msg.users || [];
            renderCanvasPresence();
            queueCanvasRender();
        }
    });
    canvasSocket.addEventListener('close', () => { canvasSocket = null; });
}

async function loadCanvasPage() {
    syncCanvasAuthState();
    canvasPageBootstrapped = true;
    // Set up ResizeObserver for DPR-correct canvas sizing
    const canvas = document.getElementById('canvas-board');
    if (canvas && !canvasResizeObserver) {
        canvasResizeObserver = new ResizeObserver(() => {
            resizeCanvasBoard();
            queueCanvasRender();
        });
        canvasResizeObserver.observe(canvas);
    }
    resizeCanvasBoard();
    try {
        await fetchCanvasState();
        attachCanvasEvents();
        connectCanvasSocket();
        clearInterval(canvasUiTimer);
        canvasUiTimer = setInterval(updateCanvasCooldownText, 500);
    } catch (error) {
        toast(error.message || 'Failed to load canvas', 'error');
    }
}

function destroyCanvasPage() {
    clearInterval(canvasUiTimer);
    canvasUiTimer = null;
    if (canvasResizeObserver) {
        canvasResizeObserver.disconnect();
        canvasResizeObserver = null;
    }
    if (canvasSocket) {
        canvasSocket.close();
        canvasSocket = null;
    }
}

function canvasToggleGrid() {
    canvasShowGrid = !canvasShowGrid;
    const btn = document.getElementById('canvas-grid-btn');
    if (btn) btn.classList.toggle('active', canvasShowGrid);
    queueCanvasRender();
}

window.loadCanvasPage = loadCanvasPage;
window.destroyCanvasPage = destroyCanvasPage;
window.resetCanvasCamera = resetCanvasCamera;
window.centerCanvasCursor = centerCanvasCursor;
window.selectCanvasColor = selectCanvasColor;
window.syncCanvasAuthState = syncCanvasAuthState;
window.canvasToggleGrid = canvasToggleGrid;
window.resizeCanvasBoard = resizeCanvasBoard;
