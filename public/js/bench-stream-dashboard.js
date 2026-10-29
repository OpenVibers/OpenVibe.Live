/* The dashboard's Bench round starter. Chat votes are collected by Live after Bench finishes the entries. */
(function () {
    const form = document.getElementById('dash-bench-form');
    const status = document.getElementById('dash-bench-status');
    if (!form || !status) return;
    async function refresh() {
        try {
            const { poll } = await api('/bench-stream/mine');
            if (!poll) {
                status.textContent = '';
                form.querySelector('button').disabled = false;
                return;
            }
            status.textContent = `Round ${poll.round_id}: ${poll.status}${poll.status === 'open' ? ` — vote !1, !2 or !tie until ${new Date(poll.closes_at).toLocaleTimeString()}` : ''}`;
            form.querySelector('button').disabled = ['pending', 'open', 'closing'].includes(poll.status);
        } catch (e) { status.textContent = e.message || 'Could not load Bench.'; }
    }
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button');
        button.disabled = true;
        status.textContent = 'Starting Bench round…';
        try {
            const { poll } = await api('/bench-stream/mine', { method: 'POST', body: {
                kind: form.elements.kind.value, prompt: form.elements.prompt.value,
                duration_seconds: Number(form.elements.duration.value),
            } });
            status.textContent = `Round ${poll.round_id} is generating its entries.`;
        } catch (e) { status.textContent = e.message || 'Could not start Bench round.'; button.disabled = false; }
    });
    refresh();
    setInterval(() => { if (document.getElementById('page-dashboard')?.classList.contains('active')) refresh(); }, 5000);
})();
