const { Client } = require('discord.js-selfbot-v13');
const http = require('http');

const TOKEN = process.env.DISCORD_TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '';
const CHANNEL_ID = process.env.CHANNEL_ID || '';
const PORT = process.env.PORT || 8080;

if (!TOKEN || !GUILD_ID || !CHANNEL_ID) {
    console.error('[VOICE] Missing env vars');
    process.exit(1);
}

const client = new Client({
    checkUpdate: false,
    ws: {
        properties: {
            $os: 'Windows',
            $browser: 'Discord Client',
            $device: 'Desktop',
            $referrer: '',
            $referring_domain: ''
        }
    }
});

let voiceConnection = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 50;

client.on('debug', (msg) => {
    if (msg.includes('voice') || msg.includes('VOICE') || msg.includes('Voice') || 
        msg.includes('ws') || msg.includes('WS') || msg.includes('WebSocket') ||
        msg.includes('error') || msg.includes('Error') || msg.includes('close')) {
        console.log(`[DEBUG] ${msg}`);
    }
});

async function joinVoice() {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            console.error(`[VOICE] Guild ${GUILD_ID} not found, fetching...`);
            const fetched = await client.guilds.fetch(GUILD_ID).catch(e => {
                console.error(`[VOICE] Cannot fetch guild: ${e.message} (${e.code || e.httpStatus})`);
                return null;
            });
            if (!fetched) return false;
        }
        
        const g = client.guilds.cache.get(GUILD_ID);
        console.log(`[VOICE] Guild: ${g.name}, member: ${g.me?.voice?.channelId || 'not in voice'}`);
        
        const channel = await g.channels.fetch(CHANNEL_ID).catch(e => {
            console.error(`[VOICE] Cannot fetch channel: ${e.message}`);
            return null;
        });
        
        if (!channel) return false;
        if (!channel.isVoice()) {
            console.error(`[VOICE] ${CHANNEL_ID} is not a voice channel (type: ${channel.type})`);
            return false;
        }

        console.log(`[VOICE] Joining: ${g.name} -> ${channel.name} (${channel.id})`);

        voiceConnection = await client.voice.joinChannel(channel, {
            selfDeaf: true,
            selfMute: false,
            selfVideo: false
        });

        reconnectAttempts = 0;

        voiceConnection.on('ready', () => {
            console.log('[VOICE] ✅ Voice connection READY — 24/7 mode active');
        });

        voiceConnection.on('disconnect', (err) => {
            console.warn(`[VOICE] Disconnected: ${typeof err === 'object' ? JSON.stringify(err) : (err || 'unknown')}`);
            voiceConnection = null;
            scheduleReconnect();
        });

        voiceConnection.on('error', (err) => {
            console.error(`[VOICE] Voice error: ${err?.message || err} (code: ${err?.code})`);
            console.error(err?.stack || '');
        });

        voiceConnection.on('stateChange', (oldState, newState) => {
            console.log(`[VOICE] State: ${oldState?.status || 'none'} -> ${newState?.status}`);
            if (newState.status === 'disconnected') {
                voiceConnection = null;
                scheduleReconnect();
            }
        });

        voiceConnection.on('debug', (msg) => console.log(`[VOICE-DEBUG] ${msg}`));
        voiceConnection.on('warn', (msg) => console.warn(`[VOICE-WARN] ${msg}`));
        voiceConnection.on('reconnecting', () => console.log('[VOICE] Reconnecting...'));
        voiceConnection.on('authenticated', () => console.log('[VOICE] Authenticated'));
        voiceConnection.on('failed', (reason) => console.error(`[VOICE] Auth failed: ${reason}`));

        return true;

    } catch (e) {
        console.error(`[VOICE] Join error: ${e.message}`);
        if (e.code) console.error(`[VOICE] Error code: ${e.code}`);
        if (e.httpStatus) console.error(`[VOICE] HTTP status: ${e.httpStatus}`);
        if (e.stack) console.error(e.stack);
        voiceConnection = null;
        scheduleReconnect();
        return false;
    }
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectAttempts++;
    const delay = Math.min(5000 * reconnectAttempts, 30000);
    console.log(`[VOICE] Reconnecting in ${delay / 1000}s (${reconnectAttempts}/${MAX_RECONNECT})`);
    if (reconnectAttempts > MAX_RECONNECT) {
        reconnectAttempts = 0;
        reconnectTimer = setTimeout(() => joinVoice(), 300000);
        return;
    }
    reconnectTimer = setTimeout(() => joinVoice(), delay);
}

client.on('ready', async () => {
    console.log(`[VOICE] Logged in: ${client.user.tag} (${client.user.id})`);
    console.log(`[VOICE] Guilds: ${client.guilds.cache.size}`);
    console.log(`[VOICE] Target: guild=${GUILD_ID} channel=${CHANNEL_ID}`);
    await joinVoice();
});

client.on('disconnect', (event) => {
    console.warn(`[VOICE] Gateway disconnected: code=${event?.code} reason=${event?.reason}`);
    voiceConnection = null;
    scheduleReconnect();
});

client.on('error', (err) => {
    console.error(`[VOICE] Gateway error: ${err?.message || err}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id !== client.user?.id) return;
    console.log(`[VOICE] Our voice state: ${oldState?.channelId || 'none'} -> ${newState?.channelId || 'none'}`);
    if (!newState.channelId) {
        console.warn('[VOICE] Kicked from voice by server');
        voiceConnection = null;
        scheduleReconnect();
    }
});

client.on('raw', (packet) => {
    if (packet.t === 'VOICE_SERVER_UPDATE' || packet.t === 'VOICE_STATE_UPDATE') {
        console.log(`[RAW] ${packet.t}: ${JSON.stringify(packet.d).slice(0, 200)}`);
    }
});

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(voiceConnection?.ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: voiceConnection?.ready ? 'alive' : 'reconnecting',
            user: client.user?.tag || null,
            guilds: client.guilds?.cache?.size || 0,
            uptime: Math.floor(process.uptime())
        }));
    } else {
        res.writeHead(200);
        res.end('OK');
    }
});
server.listen(PORT, () => console.log(`[HTTP] Port ${PORT}`));

process.on('unhandledRejection', (e) => {
    console.error('[VOICE] Unhandled rejection:', e?.stack || e);
    voiceConnection = null;
    scheduleReconnect();
});

// ==========================================
// ĐOẠN AUTO PING ĐÃ ĐƯỢC THÊM VÀO DƯỚI ĐÂY
// ==========================================
const APP_URL = process.env.APP_URL; 
if (APP_URL) {
    setInterval(() => {
        const url = APP_URL.startsWith('http') ? APP_URL : `https://${APP_URL}`;
        http.get(`${url}/health`, (res) => {
            console.log(`[KEEPALIVE] Auto-ping thành công - Status: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error(`[KEEPALIVE] Lỗi auto-ping: ${err.message}`);
        });
    }, 14 * 60 * 1000); // 14 phút ping 1 lần (Render ngủ sau 15p)
} else {
    // Dự phòng tự ping localhost nếu không có APP_URL
    setInterval(() => {
        http.get(`http://localhost:${PORT}/health`).on('error', () => {});
    }, 14 * 60 * 1000);
}
// ==========================================

console.log('[VOICE] Voice Farm v3.1 — discord.js-selfbot-v13');
client.login(TOKEN).catch(err => {
    console.error(`[VOICE] Login failed: ${err.message} (code: ${err.code})`);
    process.exit(1);
});