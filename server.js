// server.js - Servidor do Pixel Block World (WebSocket + fallback HTTP)
// Sem dependências externas: usa só módulos nativos do Node.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
// No Render, aponte DATA_DIR para o disco persistente (ex.: /var/data). Local: pasta do projeto.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const ARQ_BLOCOS = path.join(DATA_DIR, 'mundo_blocos.json');

const H = 48;
const LIMITE_XZ = 200;
const MAX_TIPO = 255;
const TIMEOUT = 10;            // segundos sem sinal => jogador removido
const MAX_LOG = 300;
const MAX_BODY = 1024 * 1024;  // 1 MB
const TICK_MS = 66;            // ~15 envios por segundo pelo WebSocket
const MAX_ITEM = 63;           // ids de item aceitos nos drops (blocos + plantas)
const DROP_TTL_MS = 5 * 60 * 1000;   // item no chão some depois de 5 min
const MAX_DROPS = 500;
const ALCANCE_PEGAR_XZ = 6;    // distância horizontal máxima (tolerante à latência) para coletar
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------- Estado ----------
const jogadores = {};          // nome -> dados
const donos = {};              // nome -> conexão WebSocket dona do nome
let log = [];                  // eventos de blocos recentes
let seq = 0;
let blocos = {};               // "x,y,z" -> tipo
let cseq = 0;                  // contador de mensagens de chat
let chatLog = [];              // últimas mensagens {c, n, t}
const ultimoChatMs = {};       // nome -> hora da última mensagem (anti-spam)

// ---------- Itens no chão (drops) ----------
const drops = new Map();       // id -> { i, x, y, z, it, t }
let dropId = 0;
let dseq = 0;                  // muda sempre que a lista de drops muda
let dropsStr = null;           // cache JSON da lista
const ganhos = {};             // nome -> itens coletados, aguardando entrega ao jogador
const taxaDrop = {};           // nome -> { t, n } (limite de criação por segundo)

try {
    if (fs.existsSync(ARQ_BLOCOS)) blocos = JSON.parse(fs.readFileSync(ARQ_BLOCOS, 'utf8')) || {};
} catch (e) {
    console.error('Falha ao ler mundo_blocos.json, iniciando vazio:', e.message);
    blocos = {};
}

// Salva o mundo no disco de forma agrupada (no máx. 1x a cada 2s)
let salvarAgendado = null;
function agendarSalvar() {
    if (salvarAgendado) return;
    salvarAgendado = setTimeout(() => {
        salvarAgendado = null;
        const tmp = ARQ_BLOCOS + '.tmp';
        fs.writeFile(tmp, JSON.stringify(blocos), err => {
            if (err) return console.error('Erro ao salvar mundo:', err.message);
            fs.rename(tmp, ARQ_BLOCOS, e => { if (e) console.error('Erro ao renomear:', e.message); });
        });
    }, 2000);
}

function mudarBloco(x, y, z, b) {
    blocos[`${x},${y},${z}`] = b;
    seq++;
    log.push({ s: seq, x, y, z, b });
    if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
    agendarSalvar();
}

function dropsMudaram() { dseq++; dropsStr = null; }
function listaDrops() { return [...drops.values()].map(d => [d.i, d.x, d.y, d.z, d.it]); }
function listaDropsStr() {
    if (dropsStr === null) dropsStr = JSON.stringify(listaDrops());
    return dropsStr;
}
function criarDrop(x, y, z, it) {
    if (drops.size >= MAX_DROPS) drops.delete(drops.keys().next().value);   // descarta o mais antigo
    const id = ++dropId;
    drops.set(id, { i: id, x, y, z, it, t: Date.now() });
    dropsMudaram();
}

// ---------- Lógica compartilhada ----------
function adicionarChat(nome, txt) {
    txt = String(txt ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!txt) return;
    const agoraMs = Date.now();
    if (ultimoChatMs[nome] && agoraMs - ultimoChatMs[nome] < 400) return;   // anti-spam
    ultimoChatMs[nome] = agoraMs;
    cseq++;
    chatLog.push({ c: cseq, n: nome, t: txt });
    if (chatLog.length > 50) chatLog = chatLog.slice(-50);
}

// Aplica os dados de um jogador (posição + edições de blocos). Retorna o nome ou ''.
function aplicarJogador(d, agora) {
    if (!d || typeof d !== 'object') return '';
    const nome = String(d.nome ?? '').replace(/[^\p{L}\p{N}_ -]/gu, '').slice(0, 16);
    if (nome === '') return '';
    jogadores[nome] = {
        nome,
        genero: d.genero === 'f' ? 'f' : 'm',
        x: Number(d.x) || 0,
        y: Number(d.y) || 0,
        z: Number(d.z) || 0,
        rot: Number(d.rot) || 0,
        emote: String(d.emote ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 16),
        keys: d.keys && typeof d.keys === 'object' ? d.keys : {},
        ultimo_acesso: agora
    };
    if (Array.isArray(d.blocos)) {
        for (const bl of d.blocos) {
            if (!Array.isArray(bl) || bl.length < 4) continue;
            const bx = Math.trunc(+bl[0]), by = Math.trunc(+bl[1]);
            const bz = Math.trunc(+bl[2]), bt = Math.trunc(+bl[3]);
            if (![bx, by, bz, bt].every(Number.isFinite)) continue;
            if (by >= 0 && by < H && Math.abs(bx) < LIMITE_XZ && Math.abs(bz) < LIMITE_XZ &&
                bt >= 0 && bt <= MAX_TIPO) {
                mudarBloco(bx, by, bz, bt);
            }
        }
    }
    // itens que o jogador soltou ao quebrar blocos (modo sobrevivência)
    if (Array.isArray(d.drops_novos)) {
        const ms = Date.now();
        const tx = taxaDrop[nome] || (taxaDrop[nome] = { t: ms, n: 0 });
        if (ms - tx.t > 1000) { tx.t = ms; tx.n = 0; }
        for (const dn of d.drops_novos.slice(0, 8)) {
            if (!Array.isArray(dn) || dn.length < 4 || tx.n >= 40) continue;
            const x = Math.round(+dn[0] * 100) / 100, y = Math.round(+dn[1] * 100) / 100;
            const z = Math.round(+dn[2] * 100) / 100, it = Math.trunc(+dn[3]);
            if (![x, y, z, it].every(Number.isFinite)) continue;
            if (Math.abs(x) > LIMITE_XZ + 1 || Math.abs(z) > LIMITE_XZ + 1 || y < -2 || y > H + 24) continue;
            if (it < 0 || it > MAX_ITEM) continue;
            tx.n++;
            criarDrop(x, y, z, it);
        }
    }
    // coleta: o primeiro jogador a pedir leva o item; os outros não recebem nada
    if (Array.isArray(d.pegar)) {
        const eu = jogadores[nome];
        for (const rid of d.pegar.slice(0, 16)) {
            const dr = drops.get(Math.trunc(+rid));
            if (!dr) continue;
            if (Math.hypot(dr.x - eu.x, dr.z - eu.z) > ALCANCE_PEGAR_XZ || Math.abs(dr.y - eu.y) > 40) continue;
            drops.delete(dr.i);
            dropsMudaram();
            (ganhos[nome] || (ganhos[nome] = [])).push(dr.it);
        }
    }
    if (d.chat !== undefined && d.chat !== null) {
        const lista = Array.isArray(d.chat) ? d.chat.slice(0, 3) : [d.chat];
        for (const t of lista) adicionarChat(nome, t);
    }
    return nome;
}

function limparInativos(agora) {
    for (const k in jogadores) {
        if (agora - jogadores[k].ultimo_acesso > TIMEOUT) { delete jogadores[k]; delete donos[k]; delete ultimoChatMs[k]; delete taxaDrop[k]; }
    }
}

function precisaCompleto(desde) {
    const minSeq = log.length ? log[0].s : seq + 1;
    return desde < 0 || desde > seq || desde + 1 < minSeq;
}

// ---------- Fallback HTTP (/sync) ----------
function sincronizar(corpo) {
    const agora = Math.floor(Date.now() / 1000);
    const desde = Number.isFinite(+corpo.desde) ? Math.trunc(+corpo.desde) : -1;
    const desdeChat = Number.isFinite(+corpo.desdeChat) ? Math.trunc(+corpo.desdeChat) : -1;
    const nome = aplicarJogador(corpo.dados_jogador, agora);
    const desdeDrops = Number.isFinite(+corpo.desdeDrops) ? Math.trunc(+corpo.desdeDrops) : -1;
    limparInativos(agora);
    const completo = precisaCompleto(desde);
    const saida = { jogadores: Object.values(jogadores), seq, tempo: agora, completo };
    if (completo) saida.blocos = blocos;
    else saida.eventos = log.filter(l => l.s > desde);
    saida.cseq = cseq;
    if (desdeDrops !== dseq) { saida.drops = listaDrops(); saida.dseq = dseq; }
    if (nome && ganhos[nome] && ganhos[nome].length) { saida.ganhos = ganhos[nome]; ganhos[nome] = []; }
    if (desdeChat >= 0 && desdeChat <= cseq) {
        const ch = chatLog.filter(c => c.c > desdeChat);
        if (ch.length) saida.chats = ch;
    }
    return saida;
}

function enviarJSON(req, res, status, obj) {
    const buf = Buffer.from(JSON.stringify(obj));
    const headers = {
        'Content-Type': 'application/json; charset=UTF-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
    };
    if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        headers['Content-Encoding'] = 'gzip';
        res.writeHead(status, headers);
        return res.end(zlib.gzipSync(buf));
    }
    res.writeHead(status, headers);
    res.end(buf);
}

// ---------- index.html em memória (já comprimido) ----------
let indexBuf = null, indexGz = null;
try {
    indexBuf = fs.readFileSync(path.join(__dirname, 'index.html'));
    indexGz = zlib.gzipSync(indexBuf, { level: 9 });
} catch (e) { console.error('index.html não encontrado:', e.message); }

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

    if (req.method === 'POST' && url === '/sync') {
        let tamanho = 0;
        const partes = [];
        req.on('data', c => {
            tamanho += c.length;
            if (tamanho > MAX_BODY) { req.destroy(); return; }
            partes.push(c);
        });
        req.on('end', () => {
            let corpo;
            try { corpo = JSON.parse(Buffer.concat(partes).toString('utf8')); }
            catch (e) { return enviarJSON(req, res, 400, { erro: 'JSON inválido' }); }
            if (!corpo || typeof corpo !== 'object') return enviarJSON(req, res, 400, { erro: 'Corpo inválido' });
            try { enviarJSON(req, res, 200, sincronizar(corpo)); }
            catch (e) { console.error(e); enviarJSON(req, res, 500, { erro: 'Erro interno' }); }
        });
        return;
    }

    if (req.method === 'GET' && url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
    }

    // Só serve o index.html (não expõe os .json nem o código do servidor)
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        if (!indexBuf) { res.writeHead(404); return res.end('index.html não encontrado'); }
        const h = { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' };
        if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
            h['Content-Encoding'] = 'gzip';
            res.writeHead(200, h);
            return res.end(indexGz);
        }
        res.writeHead(200, h);
        return res.end(indexBuf);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Não encontrado');
});

// ---------- WebSocket (implementação mínima, sem dependências) ----------
const clientes = new Set();

function montarFrame(op, payload) {
    const len = payload.length;
    let h;
    if (len < 126) h = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([h, payload]);
}

function enviarTexto(cli, texto) {
    if (!cli.aberto) return;
    try { cli.socket.write(montarFrame(1, Buffer.from(texto))); } catch (e) { fechar(cli); }
}

function fechar(cli) {
    if (!cli.aberto) return;
    cli.aberto = false;
    clientes.delete(cli);
    if (cli.nome && donos[cli.nome] === cli) { delete donos[cli.nome]; delete jogadores[cli.nome]; }
    try { cli.socket.destroy(); } catch (e) { }
}

function lerFrame(cli) {
    const b = cli.buf;
    if (b.length < 2) return null;
    const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masc = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > MAX_BODY) { fechar(cli); return null; }
    const ini = off + (masc ? 4 : 0);
    if (b.length < ini + len) return null;
    let payload = b.subarray(ini, ini + len);
    if (masc) {
        const m = b.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
    }
    cli.buf = b.subarray(ini + len);
    return { fin, op, payload };
}

function tratarMensagem(cli, texto) {
    let m;
    try { m = JSON.parse(texto); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const agora = Math.floor(Date.now() / 1000);
    const nome = aplicarJogador(m.dados_jogador, agora);
    if (!nome) return;
    // se o nome mudou nesta conexão, libera o antigo
    if (cli.nome && cli.nome !== nome && donos[cli.nome] === cli) { delete donos[cli.nome]; delete jogadores[cli.nome]; }
    cli.nome = nome;
    donos[nome] = cli;
    if (Number.isFinite(+m.ed)) cli.ack = Math.trunc(+m.ed);
}

function tratarFrame(cli, f) {
    if (f.op === 8) { try { cli.socket.write(montarFrame(8, Buffer.alloc(0))); } catch (e) { } fechar(cli); return; }
    if (f.op === 9) { try { cli.socket.write(montarFrame(10, f.payload)); } catch (e) { } return; }
    if (f.op === 1 || f.op === 0) {
        cli.frag.push(f.payload);
        if (cli.frag.reduce((a, c) => a + c.length, 0) > MAX_BODY) { fechar(cli); return; }
        if (f.fin) {
            const texto = Buffer.concat(cli.frag).toString('utf8');
            cli.frag = [];
            tratarMensagem(cli, texto);
        }
    }
}

server.on('upgrade', (req, socket, head) => {
    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (url !== '/ws' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) {
        socket.destroy();
        return;
    }
    const aceite = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${aceite}\r\n\r\n`
    );
    socket.setNoDelay(true);
    const cli = { socket, nome: null, enviado: -1, enviadoChat: cseq, ack: 0, dropVer: -1, aberto: true, buf: head && head.length ? Buffer.from(head) : Buffer.alloc(0), frag: [] };
    clientes.add(cli);
    socket.on('data', chunk => {
        cli.buf = Buffer.concat([cli.buf, chunk]);
        if (cli.buf.length > MAX_BODY * 2) return fechar(cli);
        let f;
        while (cli.aberto && (f = lerFrame(cli))) tratarFrame(cli, f);
    });
    socket.on('close', () => fechar(cli));
    socket.on('error', () => fechar(cli));
});

// Envia o estado a todos os clientes em intervalos fixos
setInterval(() => {
    if (!clientes.size) return;
    const agora = Math.floor(Date.now() / 1000);
    limparInativos(agora);
    const jogStr = JSON.stringify(Object.values(jogadores));
    let blocosStr = null;
    for (const cli of clientes) {
        if (!cli.nome) continue;                          // ainda não se identificou
        if (cli.socket.writableLength > (1 << 20)) continue; // cliente lento: pula este envio
        const completo = precisaCompleto(cli.enviado);
        let extra;
        if (completo) {
            if (blocosStr === null) blocosStr = JSON.stringify(blocos);
            extra = `,"blocos":${blocosStr}`;
        } else {
            const ev = cli.enviado === seq ? [] : log.filter(l => l.s > cli.enviado);
            extra = `,"eventos":${JSON.stringify(ev)}`;
        }
        cli.enviado = seq;
        const chats = cli.enviadoChat >= cseq ? [] : chatLog.filter(c => c.c > cli.enviadoChat);
        cli.enviadoChat = cseq;
        if (chats.length) extra += `,"chats":${JSON.stringify(chats)}`;
        if (cli.dropVer !== dseq) { extra += `,"drops":${listaDropsStr()},"dseq":${dseq}`; cli.dropVer = dseq; }
        const gn = ganhos[cli.nome];
        if (gn && gn.length) { extra += `,"ganhos":${JSON.stringify(gn)}`; ganhos[cli.nome] = []; }
        enviarTexto(cli, `{"jogadores":${jogStr},"seq":${seq},"tempo":${agora},"completo":${completo},"ack":${cli.ack},"cseq":${cseq}${extra}}`);
    }
}, TICK_MS);

// Itens no chão que ficaram tempo demais somem
setInterval(() => {
    const agora = Date.now();
    let mudou = false;
    for (const [id, d] of drops) if (agora - d.t > DROP_TTL_MS) { drops.delete(id); mudou = true; }
    if (mudou) dropsMudaram();
}, 5000);

server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

// Garante que o mundo seja salvo ao encerrar (o Render manda SIGTERM no redeploy)
function encerrar() {
    try { fs.writeFileSync(ARQ_BLOCOS, JSON.stringify(blocos)); } catch (e) { }
    process.exit(0);
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
