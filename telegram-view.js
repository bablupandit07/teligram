const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const XLSX = require('xlsx');
const dir = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : path.join(__dirname, '.telegram-view');
const settingsFile = path.join(dir, 'settings.json');
const sessionFile = path.join(dir, 'session.txt');
let client, state = 'offline', failure = '', answer, busy = false;
let channels = new Map(), messages = new Map();
const forwardFile = path.join(dir, 'forward-progress.json');
let forwardBusy = false;
function loadForwardProgress() {
    if (!fs.existsSync(forwardFile)) return { sent: {}, pending: null, until: 0 };
    return JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
}
function saveForwardProgress(value) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(forwardFile + '.tmp', JSON.stringify(value));
    fs.renameSync(forwardFile + '.tmp', forwardFile);
}
function read(file, fallback) { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return fallback; } }
function challenge(type) { state = type; return new Promise(resolve => { answer = resolve; }); }
function status() { return { state, error: failure, configured: fs.existsSync(settingsFile) }; }
function parseExportDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw Error('Select From Date and To Date.');
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw Error('Invalid date.');
    return parsed;
}
function cleanLink(value) { return String(value).trim().replace(/[)\],.!?;`*]+$/g, ''); }
function classifiedLinks(text, provider, message = {}) {
    const candidates = String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
    for (const entity of message.entities || []) {
        if (entity.url) candidates.push(entity.url);
        else if (entity.className === 'MessageEntityUrl') {
            const value = String(text || '').slice(entity.offset, entity.offset + entity.length);
            candidates.push(/^https?:\/\//i.test(value) ? value : `https://${value}`);
        }
    }
    for (const row of message.replyMarkup?.rows || []) {
        for (const button of row.buttons || []) if (button.url) candidates.push(button.url);
    }
    const teraHosts = /^(?:www\.)?(?:terabox\.com|1024terabox\.com|teraboxapp\.com|teraboxlink\.com|terasharelink\.com|terafileshare\.com|terabox\.app|teraboxshare\.com|freeterabox\.com|4funbox\.com|nephobox\.com|mirrobox\.com|momerybox\.com)$/i;
    return [...new Set(candidates.map(cleanLink).filter(link => {
        try {
            const url = new URL(link);
            const isDisk = /^(?:www\.)?diskwala\.com$/i.test(url.hostname) && /^\/app\/[A-Za-z0-9_-]+/.test(url.pathname);
            const isTera = teraHosts.test(url.hostname) && (/^\/s\/[^/]+/.test(url.pathname) || (url.pathname === '/sharing/link' && url.searchParams.has('surl')));
            return provider === 'diskwala' ? isDisk : provider === 'terabox' ? isTera : isDisk || isTera;
        } catch (_) { return false; }
    }))];
}
function exportFileName(title, from, to) {
    const safe = String(title || 'telegram').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 70) || 'telegram';
    return `${safe}_${from}_${to}.xlsx`;
}
async function login(body) {
    if (busy || state === 'ready') return status();
    let config;
    if (body.apiId) {
        config = { apiId: Number(body.apiId), apiHash: String(body.apiHash || ''), phone: String(body.phone || '') };
        if (!Number.isInteger(config.apiId) || config.apiId <= 0 || !/^[a-f0-9]{32}$/i.test(config.apiHash) || !/^\+\d{7,15}$/.test(config.phone)) throw Error('Enter a valid API ID, API hash and phone with country code.');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(settingsFile, JSON.stringify(config));
    } else config = JSON.parse(read(settingsFile, 'null'));
    if (!config) throw Error('Set up Telegram in Settings first.');
    busy = true; state = 'connecting'; failure = '';
    (async () => {
        try {
            if (client) await client.disconnect();
            client = new TelegramClient(new StringSession(read(sessionFile, '')), config.apiId, config.apiHash, { connectionRetries: 2, requestRetries: 2 });
            await client.start({ phoneNumber: async () => config.phone, phoneCode: () => challenge('code'), password: () => challenge('password'), onError: e => { throw e; } });
            fs.writeFileSync(sessionFile, client.session.save());
            state = 'ready';
        } catch (e) { failure = e.seconds ? `Telegram requires a wait of ${e.seconds} seconds before trying again.` : e.message; state = 'error'; }
        finally { busy = false; answer = null; }
    })();
    return status();
}
async function handle(body) {
    if (body.action === 'status') return status();
    if (body.action === 'login') return login(body);
    if (body.action === 'answer') {
        if (!answer) throw Error('No login answer is required.');
        const resolve = answer; answer = null; state = 'connecting'; resolve(String(body.value || '')); return status();
    }
    if (state !== 'ready') throw Error('Connect Telegram in Settings first.');
    if (body.action === 'recipients') {
        const rows = [];
        for await (const d of client.iterDialogs({ limit: undefined })) {
            if (!d.entity || d.entity.deleted) continue;
            const id = String(d.id); channels.set(id, d.entity);
            rows.push({ id, title: d.name || d.entity.title || 'Telegram user' });
        }
        const { Api } = require('telegram');
        const contacts = await client.invoke(new Api.contacts.GetContacts({ hash: require('big-integer').zero }));
        for (const user of contacts.users || []) {
            if (user.deleted) continue;
            const id = String(user.id);
            if (!rows.some(r => r.id === id)) {
                channels.set(id, user);
                rows.push({ id, title: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || id });
            }
        }
        return { recipients: rows };
    }
    if (body.action === 'channels') {
        const rows = [];
        for await (const d of client.iterDialogs({ limit: undefined })) {
            if (!['Channel', 'Chat', 'User'].includes(d.entity?.className) || d.entity.deleted) continue;
            const id = String(d.id); channels.set(id, d.entity);
            rows.push({ id, title: d.name || d.entity.title, unread: d.unreadCount || 0 });
        }
        const { Api } = require('telegram');
        const contacts = await client.invoke(new Api.contacts.GetContacts({ hash: require('big-integer').zero }));
        for (const user of contacts.users || []) {
            if (user.deleted) continue;
            const id = String(user.id);
            if (!rows.some(r => r.id === id)) {
                channels.set(id, user);
                rows.push({ id, title: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || id, unread: 0 });
            }
        }
        return { channels: rows };
    }
    const channel = channels.get(String(body.channel));
    if (!channel) throw Error('Select a channel from the list.');
    if (body.action === 'exportExcel') {
        const from = parseExportDay(body.from);
        const end = parseExportDay(body.to);
        if (from > end) throw Error('From Date cannot be after To Date.');
        const provider = ['diskwala', 'terabox', 'all'].includes(body.provider) ? body.provider : 'all';
        const endExclusive = new Date(end.getTime() + 86400000);
        const rows = [];
        let group = 0;
        for await (const m of client.iterMessages(channel, { offsetDate: Math.floor(endExclusive.getTime() / 1000), waitTime: 3 })) {
            const timestamp = Number(m.date) * 1000;
            if (timestamp < from.getTime()) break;
            if (timestamp >= endExclusive.getTime() || m.className !== 'Message') continue;
            const links = classifiedLinks(m.message || '', provider, m);
            if (!links.length) continue;
            group++;
            const doc = m.document || m.media?.document;
            const mediaType = m.photo ? 'image' : doc ? (String(doc.mimeType || '').startsWith('video/') ? 'video' : 'file') : 'none';
            const fileName = doc?.attributes?.find(a => a.fileName)?.fileName || (m.photo ? `image_${m.id}.jpg` : mediaType === 'video' ? `video_${m.id}.mp4` : '');
            const date = new Date(timestamp);
            const relation = `G-${m.id}`;
            links.forEach((link, index) => rows.push({
                'RELATION GROUP': relation,
                'PART NO.': `${group}-${index + 1}`,
                'DATE': date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
                'TELEGRAM DATE': date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
                'TELEGRAM MESSAGE ID': m.id,
                'MEDIA INDEX': 1,
                'LINK INDEX': index + 1,
                'MEDIA TYPE': mediaType,
                'FILE NAME': fileName,
                'TAG': m.message || '',
                'LINKED MEDIA': fileName ? `${mediaType}: ${fileName}` : mediaType,
                'RELATED LINK': link,
                'LINK PROVIDER': /diskwala\.com/i.test(link) ? 'DiskWala' : 'TeraBox',
                'MAPPING METHOD': 'SAME_MESSAGE'
            }));
        }
        if (!rows.length) throw Error('No matching DiskWala/TeraBox links found in this date range.');
        rows.reverse();
        const sheet = XLSX.utils.json_to_sheet(rows);
        sheet['!cols'] = [18, 12, 12, 22, 20, 12, 12, 12, 28, 55, 32, 65, 14, 18].map(wch => ({ wch }));
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheet, 'Media_Link_Map');
        const data = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
        return { fileName: exportFileName(body.title, body.from, body.to), rows: rows.length, data: data.toString('base64') };
    }
    if (body.action === 'dateMessages') {
        const startDate = body.from || body.date;
        const finishDate = body.to || body.date;
        function parseDay(value) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw Error('Select From Date and To Date.');
            const [year, month, day] = value.split('-').map(Number);
            const parsed = new Date(year, month - 1, day);
            if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) throw Error('Invalid date.');
            return parsed;
        }
        const from = parseDay(startDate);
        const end = parseDay(finishDate);
        if (from > end) throw Error('From Date cannot be after To Date.');
        end.setDate(end.getDate() + 1);
        const ids = [];
        for await (const m of client.iterMessages(channel, { offsetDate: Math.floor(end.getTime()/1000), waitTime: 3 })) {
            if (m.date * 1000 < from.getTime()) break;
            if (m.date * 1000 < end.getTime() && m.className === 'Message') ids.push(m.id);
        }
        return { ids: ids.reverse() };
    }
    if (body.action === 'forward') {
        const target = channels.get(String(body.recipient));
        const ids = [...new Set(body.ids || [])];
        if (!target || !ids.length || ids.length > 100 || !ids.every(id => Number.isSafeInteger(id) && id > 0)) throw Error('Invalid forward request (maximum 100 messages per batch).');
        if (forwardBusy) throw Error('Another forwarding batch is running. Wait before retrying.');
        forwardBusy = true;
        try {
            const saved = loadForwardProgress();
            const account = String(client.session.save());
            const key = require('crypto').createHash('sha256').update(account + ':' + body.channel + ':' + body.recipient).digest('hex');
            const done = new Set(saved.sent[key] || []);
            const remaining = ids.filter(id => !done.has(id));
            if (!remaining.length) return { sent: 0, skipped: ids.length };
            if (saved.pending) throw Error('Previous batch delivery is uncertain. Check the recipient before retrying; automatic resend is blocked to prevent duplicates.');
            if (saved.until > Date.now()) throw Object.assign(Error('Telegram cooldown is still active.'), { seconds: Math.ceil((saved.until - Date.now()) / 1000) });
            saved.pending = { key, ids: remaining };
            saveForwardProgress(saved);
            try {
                await client.forwardMessages(target, { messages: remaining, fromPeer: channel });
            } catch (e) {
                if (e.seconds || (Number(e.code) >= 400 && Number(e.code) < 500)) {
                    saved.pending = null;
                    if (e.seconds) saved.until = Date.now() + (Number(e.seconds) + 2) * 1000;
                    saveForwardProgress(saved);
                }
                throw e;
            }
            remaining.forEach(id => done.add(id));
            saved.sent[key] = [...done];
            saved.pending = null;
            saveForwardProgress(saved);
            return { sent: remaining.length, skipped: ids.length - remaining.length };
        } finally { forwardBusy = false; }
    }
    if (body.action === 'messages') {
        const offsetId = Number(body.before || 0);
        if (!Number.isSafeInteger(offsetId) || offsetId < 0) throw Error('Invalid message offset');
        const rows = await client.getMessages(channel, { limit: 30, offsetId });
        const result = rows.map(m => {
            messages.set(`${body.channel}:${m.id}`, m);
            const doc = m.document || m.media?.document;
            return { id: m.id, text: m.message || '', date: m.date, type: m.photo ? 'photo' : doc ? (String(doc.mimeType).startsWith('video/') ? 'video' : 'file') : '', size: Number(doc?.size || 0), name: doc?.attributes?.find(a => a.fileName)?.fileName || '', preview: !!(m.photo || doc?.thumbs?.length) };
        });
        while (messages.size > 1500) messages.delete(messages.keys().next().value);
        return { messages: result, more: rows.length === 30 };
    }
    if (body.action === 'media') {
        const m = messages.get(`${body.channel}:${body.id}`);
        if (!m) throw Error('Reload messages to access this media.');
        const doc = m.document || m.media?.document;
        if (body.full && Number(doc?.size || 0) > 200 * 1024 * 1024) throw Error('In-app media is limited to 200 MB.');
        let options = {};
        if (!body.full && doc) {
            const thumbs = (doc.thumbs || []).filter(t => t.className === 'PhotoSize' || t.className === 'PhotoCachedSize');
            thumbs.sort((a, b) => (b.w * b.h) - (a.w * a.h));
            if (!thumbs.length) throw Error('No image thumbnail available for this video.');
            options = { thumb: thumbs[0] };
        }
        const data = await client.downloadMedia(m, options);
        if (!Buffer.isBuffer(data) || !data.length) throw Error('Preview unavailable.');
        return { data: data.toString('base64'), mime: body.full && doc ? doc.mimeType : 'image/jpeg' };
    }
    throw Error('Unknown action');
}
async function stream(req, res, channelId, messageId) {
    const m = messages.get(`${channelId}:${messageId}`);
    const doc = m?.document || m?.media?.document;
    if (state !== 'ready' || !doc) throw Error('Reload the channel before playing this video.');
    const size = Number(doc.size);
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || 'bytes=0-');
    if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    const start = Number(match[1]);
    const end = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1);
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    const { Api } = require('telegram');
    const bigInt = require('big-integer');
    const chunkSize = 512 * 1024;
    const aligned = Math.floor(start / chunkSize) * chunkSize;
    let skip = start - aligned, remaining = end - start + 1;
    const iterator = client.iterDownload({ file: new Api.InputDocumentFileLocation({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '' }), dcId: doc.dcId, offset: bigInt(aligned), requestSize: chunkSize, chunkSize, limit: Math.ceil((end - aligned + 1) / chunkSize), msgData: m.inputChat ? [m.inputChat, m.id] : undefined });
    try {
        res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': doc.mimeType || 'video/mp4', ...(req.downloadAttachment ? { 'Content-Disposition': `attachment; filename="video_${messageId}.mp4"` } : {}), 'Content-Length': remaining, 'Accept-Ranges': 'bytes', ...(req.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}), 'Cache-Control': 'no-store' });
        for await (const data of iterator) {
            if (res.destroyed) break;
            const part = data.subarray(skip, Math.min(data.length, skip + remaining));
            skip = Math.max(0, skip - data.length);
            remaining -= part.length;
            if (part.length && !res.write(part)) await new Promise(resolve => {
                const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
                res.once('drain', done); res.once('close', done);
            });
            if (!remaining) break;
        }
        res.end();
    } catch (_) { res.destroy(); }
    finally { await iterator.close(); }
}
module.exports = { handle, stream };
