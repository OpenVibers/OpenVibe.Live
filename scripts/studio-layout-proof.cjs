'use strict';
// Isolated visual proof of the signed-in studio card. No camera, account or production service is used.
const fs = require('fs');
const path = require('path');
const { chromium } = require('/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright');
const root = path.join(__dirname, '..');
const output = path.join(root, 'docs', 'shots');
fs.mkdirSync(output, { recursive: true });
const css = fs.readFileSync(path.join(root, 'public/css/features/broadcast.css'), 'utf8');
const logo = `data:image/svg+xml;base64,${fs.readFileSync(path.join(root, 'public/assets/logo.svg')).toString('base64')}`;

function html(mode) {
    const preview = mode === 'ready' ? `<div class="gl-preview is-allowed" data-state="on"><div class="shot-feed"></div><div class="gl-pv-chips"><span class="gl-pv-chip">Front camera</span><span class="gl-pv-chip">Mic level ▰▰▱</span><span class="gl-pv-chip gl-pv-net is-ok">Good network</span></div><div class="gl-pv-controls"><button aria-label="Flip camera">⟳</button><button aria-label="Choose lens">◎</button><button aria-label="Choose microphone">♩</button><button aria-label="More camera settings">⋯</button></div></div>` : '';
    const allow = mode === 'allow' ? `<div class="bc-perm-request gl-allow"><span class="gl-allow-mark"><img src="${logo}" alt=""></span><strong>Your camera is off</strong><p class="bc-perm-hint">You choose when this browser may use your camera and microphone.</p><button class="shot-primary">Turn on camera</button><button class="gl-allow-other">Use a screen or an app instead</button></div>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="bc-golive-dock-on"><main id="page-broadcast"><div class="bc-workspace"><div class="bc-ws-main"><div class="gl"><section class="gl-card"><div class="gl-title-row"><h1 class="gl-title">Goosely goes live</h1><span class="bc-ws-save-status bc-ws-saved">Saved</span></div><div class="gl-chips"><span class="gl-chip">Camera + mic</span><span class="gl-chip">Public</span><span class="gl-chip">IRL</span></div><div class="bc-ws-golive-section is-browser">${preview}${allow}<div class="shot-destination">Live at <strong>openvibe.live/@goosely/irl</strong></div><button class="shot-primary shot-inline">Go live</button></div></section><section class="shot-side"><h2>How you stream</h2><p>Camera and microphone from this browser.</p><h2>Video quality</h2><p>720p · 30 fps</p><h2>Restreams</h2><p>Choose where else to send your stream.</p></section></div></div></div></main><div class="bcs-golive" data-mode="${mode === 'allow' ? 'allow' : 'golive'}"><button class="bcs-golive-btn">${mode === 'allow' ? 'Turn on camera' : 'Go live'}</button><small class="bcs-golive-where">${mode === 'allow' ? 'Camera off · you choose when to start' : 'Ready · openvibe.live/@goosely/irl'}</small></div></body></html>`;
}

(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
    try {
        for (const width of [390, 1280]) for (const theme of ['dark', 'light']) for (const mode of ['allow', 'ready']) {
            const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: theme, deviceScaleFactor: 1, isMobile: width < 700, hasTouch: width < 700 });
            await page.setContent(html(mode));
            await page.addStyleTag({ content: css });
            await page.addStyleTag({ content: `:root{--bg-primary:${theme === 'dark' ? '#101116' : '#f5f7fb'};--bg-card:${theme === 'dark' ? '#1b1d25' : '#fff'};--text-primary:${theme === 'dark' ? '#f4f5f8' : '#181c27'};--text-secondary:${theme === 'dark' ? '#b8bdc9' : '#50596c'};--text-muted:${theme === 'dark' ? '#9aa3b4' : '#637087'};--border:${theme === 'dark' ? '#353944' : '#d9dfe9'};--accent:#3285ed;--accent-strong:#286de3;--on-accent-strong:#fff;--ovnav-appbar-h:${width < 700 ? '62px' : '0px'}}*{box-sizing:border-box}body{margin:0;background:var(--bg-primary);color:var(--text-primary);font:16px/1.45 system-ui}#page-broadcast{max-width:1200px;margin:auto;padding:24px 14px 140px}.bc-workspace,.bc-ws-main{display:block}.gl{display:grid;grid-template-columns:${width < 700 ? '1fr' : 'minmax(0,1.2fr) minmax(0,.8fr)'};gap:18px}.gl-title{margin:0}.gl-card{padding:18px}.gl-chip{cursor:default}.shot-side{padding:20px;border:1px solid var(--border);border-radius:18px;background:var(--bg-card)}.shot-side h2{font-size:1rem;margin:0 0 6px}.shot-side p{margin:0 0 24px;color:var(--text-secondary)}.shot-primary{min-height:48px;padding:10px 18px;border:0;border-radius:12px;background:var(--accent-strong);color:#fff;font:700 1rem system-ui}.shot-inline{width:100%;margin-top:16px}.shot-destination{font-size:.85rem;color:var(--text-secondary);margin-top:14px}.gl-allow-mark img{width:43px;height:43px}.shot-feed{position:absolute;inset:0;background:linear-gradient(150deg,#181f29,#364459 46%,#191d27);}.gl-pv-chips{bottom:62px}.gl-pv-controls{bottom:8px}.gl-pv-controls button{font-size:1.3rem}.bcs-golive{display:${width < 700 ? 'grid' : 'none'}}@media(max-width:700px){.shot-side,.shot-inline{display:none}}` });
            const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
            if (docWidth > width) throw new Error(`${width}/${theme}/${mode}: horizontal overflow ${docWidth}`);
            await page.screenshot({ path: path.join(output, `live-studio-${width}-${theme}-${mode}.png`), fullPage: true });
            await page.close();
        }
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
