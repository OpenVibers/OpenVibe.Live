const express = require('express');

const router = express.Router();

const REPO_OWNER = 'OpenVibe.Live';
const REPO_NAME = 'OpenVibeApp';
const REPO_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
const CACHE_TTL_MS = 15 * 60 * 1000;

let cache = { data: null, expiresAt: 0 };

function githubHeaders() {
    const headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'OpenVibe.Live/1.0 (openvibeapp-meta)',
    };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

async function fetchGitHubJson(url, { allow404 = false } = {}) {
    const res = await fetch(url, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(8000),
    });

    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub request failed (${res.status})`);
    return res.json();
}

async function fetchOpenVibeAppMeta() {
    const now = Date.now();
    if (cache.data && cache.expiresAt > now) return cache.data;

    const [repo, latestCommit, packageFile, latestRelease] = await Promise.all([
        fetchGitHubJson(REPO_API),
        fetchGitHubJson(`${REPO_API}/commits/main`),
        fetchGitHubJson(`${REPO_API}/contents/package.json?ref=main`),
        fetchGitHubJson(`${REPO_API}/releases/latest`, { allow404: true }),
    ]);

    let packageJson = {};
    try {
        const content = Buffer.from(packageFile.content || '', 'base64').toString('utf8');
        packageJson = JSON.parse(content);
    } catch {
        packageJson = {};
    }

    const commitMessage = latestCommit?.commit?.message || '';
    const data = {
        repo: {
            owner: REPO_OWNER,
            name: REPO_NAME,
            fullName: repo?.full_name || `${REPO_OWNER}/${REPO_NAME}`,
            htmlUrl: repo?.html_url || `https://github.com/${REPO_OWNER}/${REPO_NAME}`,
            defaultBranch: repo?.default_branch || 'main',
            stars: repo?.stargazers_count || 0,
            forks: repo?.forks_count || 0,
            openIssues: repo?.open_issues_count || 0,
            pushedAt: repo?.pushed_at || null,
            updatedAt: repo?.updated_at || null,
        },
        packageVersion: packageJson.version || null,
        latestRelease: latestRelease ? {
            tagName: latestRelease.tag_name || null,
            name: latestRelease.name || null,
            publishedAt: latestRelease.published_at || latestRelease.created_at || null,
            htmlUrl: latestRelease.html_url || null,
        } : null,
        latestCommit: {
            sha: latestCommit?.sha || null,
            shortSha: latestCommit?.sha ? latestCommit.sha.slice(0, 7) : null,
            message: commitMessage.split('\n')[0] || null,
            committedAt: latestCommit?.commit?.author?.date || null,
            htmlUrl: latestCommit?.html_url || null,
        },
    };

    data.displayVersion = data.latestRelease?.tagName || (data.packageVersion ? `v${data.packageVersion.replace(/^v/i, '')}` : 'Unreleased');
    cache = { data, expiresAt: now + CACHE_TTL_MS };
    return data;
}

router.get('/openvibeapp', async (req, res) => {
    try {
        const data = await fetchOpenVibeAppMeta();
        res.json(data);
    } catch (error) {
        res.status(502).json({ error: 'Failed to fetch OpenVibeApp metadata', detail: error.message });
    }
});

module.exports = router;
