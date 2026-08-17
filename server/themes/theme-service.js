/**
 * OpenVibe.Live — Theme Service
 * Manages built-in themes, custom themes, and the theme directory.
 */
const db = require('../db/database');

/* ═══════════════════════════════════════════════════════════════
   BUILT-IN THEME DEFINITIONS  (30+ themes)
   Each theme overrides the 28 CSS custom-properties from :root
   ═══════════════════════════════════════════════════════════════ */

const BUILTIN_THEMES = (() => {
    // ── Modern palette generator: consistent ramps from a base surface + accent ──
    const _cl = (n) => Math.max(0, Math.min(255, Math.round(n)));
    const _rgb = (h) => { h = h.replace('#',''); if (h.length===3) h=h.split('').map(c=>c+c).join(''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; };
    const _hex = (r,g,b) => '#'+[r,g,b].map(v=>_cl(v).toString(16).padStart(2,'0')).join('');
    const mix = (a,b,t) => { const A=_rgb(a),B=_rgb(b); return _hex(A[0]+(B[0]-A[0])*t,A[1]+(B[1]-A[1])*t,A[2]+(B[2]-A[2])*t); };
    const lum = (h) => { const c=_rgb(h).map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]; };
    const onAccent = (a) => lum(a) > 0.42 ? '#0b0d10' : '#ffffff';
    const rgba = (h,a) => { const c=_rgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
    // HSL conditioning: keep every theme's accent + surfaces in a comfortable,
    // cohesive band (no neon accents, no harsh-black or blinding-white surfaces),
    // while preserving each theme's hue identity.
    const _r2h = (c) => { const r=c[0]/255,g=c[1]/255,b=c[2]/255,mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn; let h=0,s=0,l=(mx+mn)/2; if(d){ s=l>0.5?d/(2-mx-mn):d/(mx+mn); h=mx===r?((g-b)/d+(g<b?6:0)):mx===g?((b-r)/d+2):((r-g)/d+4); h/=6;} return [h,s,l]; };
    const _h2r = (h,s,l) => { if(!s) return [l*255,l*255,l*255]; const q=l<0.5?l*(1+s):l+s-l*s,p=2*l-q,f=(t)=>{t=(t%1+1)%1;return t<1/6?p+(q-p)*6*t:t<0.5?q:t<2/3?p+(q-p)*(2/3-t)*6:p;}; return [f(h+1/3)*255,f(h)*255,f(h-1/3)*255]; };
    const clmp = (v,a,b)=>Math.max(a,Math.min(b,v));
    const condAcc  = (hex)=>{ const [h,s,l]=_r2h(_rgb(hex)); return _hex(..._h2r(h, clmp(s,0.45,0.68), clmp(l,0.58,0.70))); };
    const condDark = (hex)=>{ const [h,s,l]=_r2h(_rgb(hex)); return _hex(..._h2r(h, Math.min(s,0.20), clmp(l,0.085,0.145))); };
    const condLight= (hex)=>{ const [h,s,l]=_r2h(_rgb(hex)); return _hex(..._h2r(h, Math.min(s,0.10), clmp(l,0.895,0.94))); };
    const W='#ffffff', K='#000000';
    const SEM = { '--live-red':'#f0485c', '--success':'#37c871', '--warning':'#e6a53a', '--danger':'#f0485c', '--info':'#4aa3e8' };
    const dark = (b0, a0, sem) => { const base=condDark(b0), accent=condAcc(a0); return Object.assign({
        '--bg-primary': mix(base,K,0.30), '--bg-secondary': base,
        '--bg-tertiary': mix(base,W,0.06), '--bg-card': mix(base,W,0.03),
        '--bg-hover': mix(base,W,0.10), '--bg-input': mix(base,K,0.20),
        '--text-primary': mix(base,W,0.90), '--text-secondary': mix(base,W,0.56), '--text-muted': mix(base,W,0.38),
        '--accent': accent, '--accent-light': mix(accent,W,0.20), '--accent-dark': mix(accent,K,0.26),
        '--border': mix(base,W,0.09), '--border-light': mix(base,W,0.15), '--on-accent': onAccent(accent),
        '--glass': rgba(mix(base,K,0.08), 0.85), '--glass-strong': rgba(mix(base,K,0.24), 0.95),
        '--ring-accent': `0 0 0 1px ${rgba(accent,0.22)}, 0 18px 40px rgba(0,0,0,0.30)`,
        '--shadow': '0 2px 12px rgba(0,0,0,0.45)', '--shadow-lg': '0 12px 40px rgba(0,0,0,0.6)',
        '--shadow-soft': '0 12px 40px rgba(0,0,0,0.28)',
    }, SEM, sem||{}); };
    // Light: soft tinted-paper surfaces (never harsh white), gently elevated cards,
    // a calm muted navbar; accents conditioned to the same pleasant band.
    const light = (b0, a0, sem) => { const base=mix(condLight(b0),K,0.04), accent=condAcc(a0); return Object.assign({
        '--bg-primary': mix(base,K,0.035), '--bg-secondary': mix(base,K,0.085),
        '--bg-tertiary': mix(base,K,0.13), '--bg-card': mix(base,W,0.32),
        '--bg-hover': mix(base,K,0.09), '--bg-input': mix(base,W,0.38),
        '--text-primary': mix(base,K,0.88), '--text-secondary': mix(base,K,0.52), '--text-muted': mix(base,K,0.40),
        '--accent': accent, '--accent-light': mix(accent,W,0.16), '--accent-dark': mix(accent,K,0.20),
        '--border': mix(base,K,0.15), '--border-light': mix(base,K,0.08), '--on-accent': onAccent(accent),
        '--glass': rgba(mix(base,K,0.07), 0.92), '--glass-strong': rgba(mix(base,W,0.10), 0.96),
        '--ring-accent': `0 0 0 1px ${rgba(accent,0.24)}, 0 16px 36px rgba(20,25,40,0.12)`,
        '--shadow': '0 2px 12px rgba(20,25,40,0.07)', '--shadow-lg': '0 12px 40px rgba(20,25,40,0.12)',
        '--shadow-soft': '0 12px 40px rgba(20,25,40,0.09)',
    }, SEM, sem||{}); };
    const T = (name, slug, mode, description, tags, variables) => ({ name, slug, mode, description, tags, variables });
    return [
        // ─── DARK ───
        T('Vibe','vibe','dark','The OpenVibe signature — deep night violet.',['default','purple','vibe'], dark('#131318','#8b5cf6',{'--info':'#22d3ee'})),
        T('Midnight','midnight','dark','Deep blue-black with a cool indigo glow.',['cool','blue','minimal'], dark('#12151f','#7c83ff')),
        T('Forest','forest','dark','Mossy greens in low light.',['nature','green'], dark('#121a15','#4ecb8d')),
        T('Neon Tokyo','neon-tokyo','dark','Rainy-night neon — pink on violet.',['neon','vibrant','pink'], dark('#14121c','#ff5ca8',{'--info':'#5ce1ff'})),
        T('Dracula','dracula','dark','The classic Dracula palette.',['popular','purple'], dark('#22242e','#bd93f9',{'--success':'#50fa7b','--warning':'#f1fa8c','--danger':'#ff5555','--info':'#8be9fd'})),
        T('Monokai','monokai','dark','Editor-classic lime on charcoal.',['code','green'], dark('#20211b','#a6e22e',{'--danger':'#f92672','--warning':'#fd971f','--info':'#66d9ef'})),
        T('Ocean Deep','ocean-deep','dark','Deep-sea teal and cyan.',['cool','teal'], dark('#0e1720','#2bb7c4')),
        T('Sunset','sunset','dark','Dusky warmth with a coral glow.',['warm','coral'], dark('#1c1417','#ff7a59')),
        T('Arctic','arctic','dark','Cold, crisp icy blue.',['cool','blue'], dark('#131a20','#63c7e6')),
        T('Ember','ember','dark','Smouldering red-orange coals.',['warm','red'], dark('#1a1210','#ff5a3c')),
        T('Vapor','vapor','dark','Vaporwave pink and cyan dream.',['neon','pink','retro'], dark('#171422','#ff6ad5',{'--info':'#5ce1ff'})),
        T('Slate','slate','dark','Muted neutral steel — easy on the eyes.',['minimal','neutral'], dark('#16181d','#8aa0bf')),
        T('Matrix','matrix','dark','Terminal green rain.',['green','retro'], dark('#0c110c','#35d94c')),
        T('Nord','nord','dark','The cool, arctic Nord palette.',['popular','cool','blue'], dark('#2e3440','#88c0d0',{'--success':'#a3be8c','--warning':'#ebcb8b','--danger':'#bf616a','--info':'#81a1c1'})),
        T('Gruvbox Dark','gruvbox-dark','dark','Retro warm Gruvbox.',['retro','warm'], dark('#282828','#fabd2f',{'--success':'#b8bb26','--warning':'#fe8019','--danger':'#fb4934','--info':'#83a598'})),
        T('Abyss','abyss','dark','Near-black depths with electric blue.',['minimal','blue','dark'], dark('#0b0e14','#4d8dff')),
        T('Copper','copper','dark','Aged copper and bronze warmth.',['warm','metal'], dark('#1a1512','#c87e4f')),
        T('Sakura Night','sakura-night','dark','Cherry-blossom pink at night.',['pink','soft'], dark('#1c1620','#f6a5c0')),
        T('Hacker','hacker','dark','Blackout with acid green.',['green','retro'], dark('#0b0f0b','#00d451')),
        T('Solarized Dark','solarized-dark','dark','The precise Solarized dark palette.',['popular','cool'], dark('#0a2f38','#268bd2',{'--success':'#859900','--warning':'#b58900','--danger':'#dc322f','--info':'#2aa198'})),
        T('Catppuccin Mocha','catppuccin-mocha','dark','Soft pastel Mocha.',['popular','pastel','purple'], dark('#1e1e2e','#cba6f7',{'--success':'#a6e3a1','--warning':'#f9e2af','--danger':'#f38ba8','--info':'#89dceb'})),
        (() => { const t = T('High Contrast','high-contrast','dark','Maximum contrast for accessibility.',['a11y','contrast'], dark('#0a0a0a','#ffd21e')); Object.assign(t.variables, {'--bg-primary':'#000000','--bg-secondary':'#0a0a0a','--text-primary':'#ffffff','--text-secondary':'#d6d6d6','--text-muted':'#a8a8a8','--border':'#5a5a5a','--border-light':'#7a7a7a'}); return t; })(),
        // ─── LIGHT ───
        T('Daylight','daylight','light','Clean, bright and blue.',['clean','blue'], light('#f4f6f9','#3b7dd8')),
        T('Paper','paper','light','Warm off-white paper with violet ink.',['warm','minimal'], light('#f6f3ec','#8b5cf6')),
        T('Cloud','cloud','light','Soft cool gray with periwinkle.',['cool','soft'], light('#eef1f5','#6d7cff')),
        T('Meadow','meadow','light','Fresh spring green on cream.',['nature','green'], light('#eef4ec','#3fae6a')),
        T('Peach','peach','light','Soft peach and coral.',['warm','soft'], light('#fbf0ea','#f0805a')),
        T('Lavender','lavender','light','Gentle lavender purple.',['soft','purple'], light('#f2eef8','#8b6fd8')),
        T('Gruvbox Light','gruvbox-light','light','Warm retro Gruvbox, bright.',['retro','warm'], light('#f2e5bc','#b57614',{'--success':'#79740e','--warning':'#af3a03','--danger':'#9d0006','--info':'#076678'})),
        T('Snow','snow','light','Crisp near-white with clean blue.',['clean','minimal'], light('#f7f9fc','#4a86e8')),
        T('Sand','sand','light','Warm sandy neutrals.',['warm','neutral'], light('#f3ece0','#bf8f4a')),
        T('Rose','rose','light','Delicate rose pink.',['soft','pink'], light('#faedf0','#d9557f')),
        T('Solarized Light','solarized-light','light','The precise Solarized light palette.',['popular','warm'], light('#eee8d5','#268bd2',{'--success':'#859900','--warning':'#b58900','--danger':'#dc322f','--info':'#2aa198'})),
        T('Catppuccin Latte','catppuccin-latte','light','Soft pastel Latte.',['popular','pastel'], light('#eff1f5','#8839ef',{'--success':'#40a02b','--warning':'#df8e1d','--danger':'#d20f39','--info':'#209fb5'})),
    ];
})();

/* ═══════════════════════════════════════════════════════════════
   SERVICE FUNCTIONS
   ═══════════════════════════════════════════════════════════════ */

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function previewFromVars(vars) {
    return JSON.stringify({
        bg: vars['--bg-primary'] || '#0d0d0f',
        accent: vars['--accent'] || '#8b5cf6',
        text: vars['--text-primary'] || '#e8e6e3',
    });
}

/**
 * Seed all built-in themes into the database.
 */
function seedBuiltinThemes() {
    const dbh = db.getDb();
    const find = dbh.prepare('SELECT id FROM themes WHERE slug = ?');
    // Update in place (keeps theme IDs stable so saved user selections still resolve)
    // so re-tuned palettes actually take effect on an existing DB.
    const upd = dbh.prepare(`
        UPDATE themes SET name = ?, mode = ?, description = ?, variables = ?, preview_colors = ?, tags = ?, is_builtin = 1, is_public = 1
        WHERE slug = ?
    `);
    const ins = dbh.prepare(`
        INSERT INTO themes (name, slug, mode, description, variables, preview_colors, is_builtin, is_public, tags)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
    `);
    const seed = dbh.transaction(() => {
        for (const t of BUILTIN_THEMES) {
            const vars = JSON.stringify(t.variables);
            const pv = previewFromVars(t.variables);
            const tags = JSON.stringify(t.tags || []);
            if (find.get(t.slug)) upd.run(t.name, t.mode, t.description, vars, pv, tags, t.slug);
            else ins.run(t.name, t.slug, t.mode, t.description, vars, pv, tags);
        }
    });
    seed();
}

/**
 * Get all public themes (built-in + community)  
 */
function getAllThemes({ mode, search, sort = 'name', limit = 100, offset = 0 } = {}) {
    let sql = `SELECT t.*, u.username as author_name FROM themes t LEFT JOIN users u ON t.author_id = u.id WHERE t.is_public = 1`;
    const params = [];

    if (mode) {
        sql += ' AND t.mode = ?';
        params.push(mode);
    }
    if (search) {
        sql += ' AND (t.name LIKE ? OR t.description LIKE ? OR t.tags LIKE ?)';
        const s = `%${search}%`;
        params.push(s, s, s);
    }

    // Sort
    const sortMap = {
        name: 't.name ASC',
        popular: 't.downloads DESC',
        newest: 't.created_at DESC',
        rating: '(CASE WHEN t.rating_count > 0 THEN CAST(t.rating_sum AS REAL)/t.rating_count ELSE 0 END) DESC',
    };
    sql += ` ORDER BY t.is_builtin DESC, ${sortMap[sort] || sortMap.name}`;
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return db.all(sql, params);
}

function getThemeById(id) {
    return db.get(`SELECT t.*, u.username as author_name FROM themes t LEFT JOIN users u ON t.author_id = u.id WHERE t.id = ?`, [id]);
}

function getThemeBySlug(slug) {
    return db.get(`SELECT t.*, u.username as author_name FROM themes t LEFT JOIN users u ON t.author_id = u.id WHERE t.slug = ?`, [slug]);
}

/**
 * Sanitize CSS variable values — reject dangerous patterns.
 */
const CSS_FORBIDDEN = /url\s*\(|expression\s*\(|@import|javascript:|data:|behavior\s*:|binding\s*:/i;
function sanitizeCssVariables(vars) {
    if (!vars || typeof vars !== 'object') return {};
    const clean = {};
    for (const [key, value] of Object.entries(vars)) {
        if (!key.startsWith('--')) continue; // only CSS custom properties
        const v = String(value);
        if (CSS_FORBIDDEN.test(v)) {
            throw new Error(`Forbidden CSS value in ${key}`);
        }
        if (v.length > 200) {
            throw new Error(`CSS value too long for ${key}`);
        }
        clean[key] = v;
    }
    return clean;
}

/**
 * Create a community theme.
 */
function createTheme({ name, author_id, description, mode, variables, tags }) {
    const slug = slugify(name);
    // Check uniqueness
    const existing = db.get('SELECT id FROM themes WHERE slug = ?', [slug]);
    if (existing) throw new Error('Theme name already taken');

    const parsedVars = typeof variables === 'string' ? JSON.parse(variables) : variables;
    const sanitized = sanitizeCssVariables(parsedVars);
    const varsJson = JSON.stringify(sanitized);

    return db.run(
        `INSERT INTO themes (name, slug, author_id, description, mode, variables, preview_colors, is_builtin, is_public, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
        [name, slug, author_id, description || '', mode || 'dark', varsJson, previewFromVars(sanitized), JSON.stringify(tags || [])]
    );
}

/**
 * Update a community theme (only by author).
 */
function updateTheme(id, authorId, { name, description, mode, variables, tags }) {
    const theme = db.get('SELECT * FROM themes WHERE id = ?', [id]);
    if (!theme) throw new Error('Theme not found');
    if (theme.is_builtin) throw new Error('Cannot edit built-in themes');
    if (theme.author_id !== authorId) throw new Error('Not your theme');

    const updates = [];
    const params = [];

    if (name) {
        const slug = slugify(name);
        updates.push('name = ?', 'slug = ?');
        params.push(name, slug);
    }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (mode) { updates.push('mode = ?'); params.push(mode); }
    if (variables) {
        const parsedVars = typeof variables === 'string' ? JSON.parse(variables) : variables;
        const sanitized = sanitizeCssVariables(parsedVars);
        const varsJson = JSON.stringify(sanitized);
        updates.push('variables = ?', 'preview_colors = ?');
        params.push(varsJson, previewFromVars(sanitized));
    }
    if (tags) { updates.push('tags = ?'); params.push(JSON.stringify(tags)); }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    return db.run(`UPDATE themes SET ${updates.join(', ')} WHERE id = ?`, params);
}

/**
 * Delete a community theme (only by author or admin).
 */
function deleteTheme(id, userId, isAdmin = false) {
    const theme = db.get('SELECT * FROM themes WHERE id = ?', [id]);
    if (!theme) throw new Error('Theme not found');
    if (theme.is_builtin) throw new Error('Cannot delete built-in themes');
    if (theme.author_id !== userId && !isAdmin) throw new Error('Not authorized');
    return db.run('DELETE FROM themes WHERE id = ?', [id]);
}

/**
 * Increment download count.
 */
function downloadTheme(id) {
    return db.run('UPDATE themes SET downloads = downloads + 1 WHERE id = ?', [id]);
}

/**
 * Get / set user's active theme preference.
 */
function getUserTheme(userId) {
    return db.get('SELECT * FROM user_themes WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
}

function setUserTheme(userId, { theme_id, custom_variables, is_custom }) {
    // Upsert
    const existing = db.get('SELECT id FROM user_themes WHERE user_id = ?', [userId]);
    if (existing) {
        return db.run(
            `UPDATE user_themes SET theme_id = ?, custom_variables = ?, is_custom = ? WHERE user_id = ?`,
            [theme_id || null, custom_variables ? JSON.stringify(custom_variables) : '{}', is_custom ? 1 : 0, userId]
        );
    }
    return db.run(
        `INSERT INTO user_themes (user_id, theme_id, custom_variables, is_custom) VALUES (?, ?, ?, ?)`,
        [userId, theme_id || null, custom_variables ? JSON.stringify(custom_variables) : '{}', is_custom ? 1 : 0]
    );
}

module.exports = {
    BUILTIN_THEMES,
    seedBuiltinThemes,
    getAllThemes,
    getThemeById,
    getThemeBySlug,
    createTheme,
    updateTheme,
    deleteTheme,
    downloadTheme,
    getUserTheme,
    setUserTheme,
};
