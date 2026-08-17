'use strict';
/* ─────────────────────────────────────────────────────────────────
   broadcast-vods.js — VOD archive tab: list, search, sort,
   filter, modal player, chat replay, and visibility controls.
   ─────────────────────────────────────────────────────────────── */

/* ═════════════════════════════════════════════════════════════
   BROADCAST TABS — VOD ARCHIVE & SETTINGS
   ═════════════════════════════════════════════════════════════ */

let _vodArchive = [];
let _vodCurrentModal = null;

/**
 * Load VODs for the Past Streams tab
 */
async function loadBroadcastVODs() {
    const grid = document.getElementById('bc-vod-grid');
    if (!grid) return;

    try {
        // Fetch the current creator's own VODs (includes private/recording ones).
        // The endpoint returns { vods, total, ... }, NOT a bare array.
        const response = await fetch('/api/vods/mine', { credentials: 'same-origin' });
        const data = await response.json();
        const vods = Array.isArray(data) ? data : (data.vods || []);

        _vodArchive = vods;
        renderBroadcastVODGrid(vods);
    } catch (err) {
        console.error('Error loading VODs:', err);
        grid.innerHTML = '<p class="muted" style="grid-column: 1/-1; text-align: center; padding: 40px">Error loading VODs</p>';
    }
}

/**
 * Render VOD cards in the grid
 */
function renderBroadcastVODGrid(vods) {
    const grid = document.getElementById('bc-vod-grid');
    if (!grid) return;

    if (vods.length === 0) {
        grid.innerHTML = '<p class="muted" style="grid-column: 1/-1; text-align: center; padding: 40px">No VODs found</p>';
        return;
    }

    grid.innerHTML = vods.map((vod, idx) => `
        <div class="bc-vod-card" onclick="openBroadcastVODModal(${idx})">
            <div class="bc-vod-card-thumb">
                ${vod.thumbnail_url ? `<img src="${vod.thumbnail_url}" alt="${vod.title || 'VOD'}">` : '<i class="fa-solid fa-video"></i>'}
                <div class="bc-vod-card-duration">${formatDuration(vod.duration_seconds || 0)}</div>
            </div>
            <div class="bc-vod-card-content">
                <h4 class="bc-vod-card-title">${vod.title || 'Untitled Stream'}</h4>
                <div class="bc-vod-card-meta">
                    <span><i class="fa-solid fa-calendar-days"></i> ${new Date(vod.created_at).toLocaleDateString()}</span>
                    <span><i class="fa-solid fa-eye"></i> ${vod.view_count || 0} views</span>
                    <span><i class="fa-solid fa-${vod.is_public ? 'globe' : 'lock'}"></i> ${vod.is_public ? 'Public' : 'Private'}</span>
                </div>
            </div>
        </div>
    `).join('');
}

/**
 * Open VOD detail modal
 */
function openBroadcastVODModal(vodIndex) {
    const vod = _vodArchive[vodIndex];
    if (!vod) return;

    _vodCurrentModal = vod;
    const modal = document.getElementById('bc-vod-modal');
    if (!modal) return;

    // Set VOD info
    document.getElementById('bc-vod-modal-title').textContent = vod.title || 'Untitled Stream';
    document.getElementById('bc-vod-modal-date').textContent = new Date(vod.created_at).toLocaleDateString();
    document.getElementById('bc-vod-modal-duration').textContent = formatDuration(vod.duration_seconds || 0);
    document.getElementById('bc-vod-modal-views').textContent = (vod.view_count || 0).toLocaleString();
    document.getElementById('bc-vod-is-public').checked = !!vod.is_public;

    // Set video source — VODs are served by filename via /api/vods/file/:filename
    // (there is no `stream_url` field on a VOD; the real path is `file_path`).
    const player = document.getElementById('bc-vod-player');
    if (player) {
        if (vod.file_path) {
            const filename = vod.file_path.split('/').pop();
            player.src = `/api/vods/file/${filename}?t=${Date.now()}`;
        } else {
            player.removeAttribute('src');
        }
    }

    // Load chat replay
    loadVODChatReplay(vod.id);

    // Show modal
    modal.style.display = 'flex';
    modal.classList.add('active');
}

/**
 * Load and display chat replay for a VOD
 */
async function loadVODChatReplay(vodId) {
    const chatContainer = document.getElementById('bc-vod-chat-replay');
    if (!chatContainer) return;

    try {
        const response = await fetch(`/api/vods/${vodId}/chat`);
        const messages = await response.json();

        if (!Array.isArray(messages) || messages.length === 0) {
            chatContainer.innerHTML = '<p class="muted">No chat messages during this stream</p>';
            return;
        }

        chatContainer.innerHTML = messages.map(msg => `
            <div class="bc-vod-chat-message" onclick="seekBroadcastVOD(${msg.timestamp || 0})">
                <div class="bc-vod-chat-message-info">
                    <span class="bc-vod-chat-message-username">${msg.username}</span>
                    <span class="bc-vod-chat-message-time">${formatDuration(msg.timestamp || 0)}</span>
                </div>
                <div class="bc-vod-chat-message-text">${msg.message}</div>
            </div>
        `).join('');
    } catch (err) {
        console.error('Error loading chat replay:', err);
        chatContainer.innerHTML = '<p class="muted">Error loading chat messages</p>';
    }
}

/**
 * Seek VOD to a specific timestamp
 */
function seekBroadcastVOD(seconds) {
    const player = document.getElementById('bc-vod-player');
    if (player) {
        player.currentTime = Math.max(0, seconds);
    }
}

/**
 * Close VOD modal
 */
function closeBroadcastVODModal() {
    const modal = document.getElementById('bc-vod-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('active');
        const player = document.getElementById('bc-vod-player');
        if (player) player.pause();
    }
    _vodCurrentModal = null;
}

/**
 * Search/filter VODs
 */
function searchBroadcastVODs() {
    const searchQuery = document.getElementById('bc-vod-search')?.value || '';
    const filtered = _vodArchive.filter(vod => 
        (vod.title || '').toLowerCase().includes(searchQuery.toLowerCase())
    );
    renderBroadcastVODGrid(filtered);
}

/**
 * Sort VODs
 */
function sortBroadcastVODs(sortBy) {
    let sorted = [..._vodArchive];

    switch (sortBy) {
        case 'newest':
            sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            break;
        case 'oldest':
            sorted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            break;
        case 'longest':
            sorted.sort((a, b) => (b.duration_seconds || 0) - (a.duration_seconds || 0));
            break;
        case 'mostviewed':
            sorted.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
            break;
    }

    renderBroadcastVODGrid(sorted);
}

/**
 * Filter VODs by public/private status
 */
function filterBroadcastVODs(filterValue, filterType) {
    let filtered = _vodArchive;

    if (filterValue === 'public') {
        filtered = filtered.filter(v => !!v.is_public);
    } else if (filterValue === 'private') {
        filtered = filtered.filter(v => !v.is_public);
    }

    renderBroadcastVODGrid(filtered);
}

/**
 * Update VOD visibility (public/private)
 */
async function updateBroadcastVODVisibility(isPublic) {
    if (!_vodCurrentModal) return;

    try {
        const response = await fetch(`/api/vods/${_vodCurrentModal.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_public: isPublic })
        });

        if (response.ok) {
            _vodCurrentModal.is_public = isPublic;
            // Reload VOD grid to reflect changes
            loadBroadcastVODs();
        }
    } catch (err) {
        console.error('Error updating VOD visibility:', err);
    }
}

/**
 * Download VOD
 */
function downloadBroadcastVOD() {
    if (!_vodCurrentModal || !_vodCurrentModal.file_path) return;
    const filename = _vodCurrentModal.file_path.split('/').pop();
    const ext = (filename.split('.').pop() || 'webm').toLowerCase();
    const link = document.createElement('a');
    link.href = `/api/vods/file/${filename}`;
    link.download = `${_vodCurrentModal.title || 'stream'}.${ext}`;
    link.click();
}

/**
 * Delete VOD
 */
async function deleteBroadcastVOD() {
    if (!_vodCurrentModal) return;
    if (!confirm('Delete this VOD? This cannot be undone.')) return;

    try {
        const response = await fetch(`/api/vods/${_vodCurrentModal.id}`, { method: 'DELETE' });
        if (response.ok) {
            closeBroadcastVODModal();
            loadBroadcastVODs();
        }
    } catch (err) {
        console.error('Error deleting VOD:', err);
    }
}

