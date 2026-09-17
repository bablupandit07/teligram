const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const telegramView = require('./telegram-view');
const token = crypto.randomBytes(24).toString('hex');
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
let job = null;
let lines = [];
let sequence = 0;
const scripts = { small: 'index.js', large: 'index200.js', links: 'diskwala.js' };
function record(text) {
    lines.push({ id: ++sequence, text: text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') });
    if (lines.length > 1500) lines.shift();
}
function reply(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
}
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/healthz') return reply(res, 200, { ok: true });
        // Legacy CLI tasks are local-only and are not part of this deployment.
        if (!['/', '/api/video', '/api/telegram'].includes(url.pathname)) return reply(res, 404, { error: 'Not found' });
        if (req.method === 'GET' && url.pathname === '/api/video' && url.searchParams.get('token') === token) {
            req.downloadAttachment = url.searchParams.get('download') === '1';
            return await telegramView.stream(req, res, url.searchParams.get('channel'), url.searchParams.get('id'));
        }
        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
            return res.end(fs.readFileSync(path.join(__dirname, 'telegram.html'), 'utf8').replace('__TOKEN__', token));
        }
        if (req.headers['x-app-token'] !== token) return reply(res, 403, { error: 'Open the local dashboard first.' });
        if (req.method === 'GET' && url.pathname === '/api/status') {
            return reply(res, 200, { job: job && { mode: job.mode, started: job.started, running: job.running, code: job.code }, lines: lines.filter(x => x.id > Number(url.searchParams.get('after') || 0)) });
        }
        if (req.method !== 'POST') return reply(res, 404, { error: 'Not found' });
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 8192) return reply(res, 413, { error: 'Input too large' }); }
        const body = JSON.parse(raw || '{}');
        if (url.pathname === '/api/telegram') return reply(res, 200, await telegramView.handle(body));
        if (url.pathname === '/api/start') {
            if (job?.running) return reply(res, 409, { error: 'A task is already running. Finish or stop it first.' });
            if (!scripts[body.mode]) return reply(res, 400, { error: 'Invalid task' });
            lines = [];
            const child = spawn(process.execPath, ['--require', path.join(__dirname, 'app-input.js'), path.join(__dirname, scripts[body.mode])], { cwd: __dirname, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } });
            job = { child, mode: body.mode, running: true, started: Date.now(), code: null };
            const current = job;
            child.stdout.on('data', x => record(x.toString()));
            child.stderr.on('data', x => record(x.toString()));
            child.stdin.on('error', () => {});
            child.on('error', e => { record(e.message); current.running = false; });
            child.on('close', code => { current.running = false; current.code = code; record(`\nTask ended (exit ${code}).\n`); });
            return reply(res, 200, { ok: true });
        }
        if (url.pathname === '/api/input') {
            if (!job?.running) return reply(res, 409, { error: 'No active task' });
            if (typeof body.value !== 'string' || /[\r\n]/.test(body.value)) return reply(res, 400, { error: 'Send one answer at a time' });
            job.child.stdin.write(body.value + '\n');
            return reply(res, 200, { ok: true });
        }
        if (url.pathname === '/api/stop') {
            if (job?.running) job.child.kill();
            return reply(res, 200, { ok: true });
        }
        reply(res, 404, { error: 'Not found' });
    } catch (e) { if (res.headersSent) return res.destroy(); reply(res, 400, { error: e.message, seconds: e.seconds || 0 }); }
});
server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. If Flow is already running, open http://127.0.0.1:${port}`);
        console.error('To use another port in PowerShell: $env:PORT=3211; node app-server.js');
    } else {
        console.error('Could not start dashboard:', error.message);
    }
    process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Flow listening on ${host}:${port}`));
process.on('SIGINT', () => { if (job?.running) job.child.kill(); server.close(); });
