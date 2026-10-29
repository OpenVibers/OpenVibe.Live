/* Plain watch-page side panel; the main session owns the visual treatment. */
(function () {
    const panel = document.getElementById('ch-bench-stream');
    if (!panel) return;
    let shown = '';
    function entryView(entry, number) {
        const box = document.createElement('article');
        box.className = 'dash-card';
        const heading = document.createElement('h4');
        heading.textContent = `Entry ${number}`;
        box.append(heading);
        const payload = entry.payload || {};
        if (typeof payload.html === 'string') {
            const frame = document.createElement('iframe');
            frame.title = `Bench entry ${number}`;
            frame.setAttribute('sandbox', '');
            frame.setAttribute('referrerpolicy', 'no-referrer');
            frame.srcdoc = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
                + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">'
                + '<style>html,body{margin:0;min-height:100%;background:#fff}img{max-width:100%;height:auto}</style>' + payload.html;
            box.append(frame);
        } else {
            for (const [key, value] of Object.entries(payload)) {
                if (typeof value !== 'string') {
                    if (value == null) continue;
                    const pre = document.createElement('pre');
                    pre.textContent = `${key}: ${JSON.stringify(value, null, 2)}`;
                    box.append(pre);
                    continue;
                }
                if (key === 'image' && (/^https:\/\//i.test(value) || /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value))) {
                    const img = document.createElement('img');
                    img.src = value;
                    img.alt = `Bench entry ${number}`;
                    img.loading = 'lazy';
                    box.append(img);
                    continue;
                }
                if (key === 'audio_url' && /^https:\/\//i.test(value)) {
                    const audio = document.createElement('audio');
                    audio.controls = true;
                    audio.src = value;
                    box.append(audio);
                    continue;
                }
                const p = document.createElement('p');
                p.textContent = `${key}: ${value}`;
                box.append(p);
            }
        }
        return box;
    }
    async function refresh() {
        const username = typeof currentChannelUsername === 'string' ? currentChannelUsername : null;
        if (!username || !location.pathname.startsWith('/@')) return;
        try {
            const { poll } = await api(`/bench-stream/channel/${encodeURIComponent(username)}`);
            if (username !== currentChannelUsername || !location.pathname.startsWith('/@')) return;
            if (!poll || poll.status === 'failed' || (typeof currentStreamId !== 'undefined' && Number(currentStreamId) !== poll.stream_id)) {
                panel.hidden = true; shown = ''; return;
            }
            const key = `${poll.round_id}:${poll.status}`;
            if (shown === key) return;
            shown = key;
            panel.replaceChildren();
            const title = document.createElement('h3');
            title.textContent = `Bench: ${poll.kind_id}`;
            const prompt = document.createElement('p');
            prompt.textContent = poll.prompt;
            const state = document.createElement('p');
            state.textContent = poll.status === 'open' ? `Vote in chat: !1, !2 or !tie. Closes ${new Date(poll.closes_at).toLocaleTimeString()}.`
                : poll.status === 'closed' ? `Result: ${poll.vote_counts.left} for 1, ${poll.vote_counts.right} for 2, ${poll.vote_counts.tie} ties (${poll.vote_counts.voters} voters).`
                : 'Entries are generating…';
            panel.append(title, prompt, state);
            if (poll.entries) for (const [i, entry] of poll.entries.entries()) panel.append(entryView(entry, i + 1));
            panel.hidden = false;
        } catch { /* Chat and the stream stay usable while Bench is unavailable. */ }
    }
    refresh();
    setInterval(refresh, 3000);
})();
