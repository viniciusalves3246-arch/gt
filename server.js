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

const H = 64;                  // altura máxima do mundo (igual ao YMAX do cliente; antes 48 recusava blocos altos)
const LIMITE_XZ = 100000;    // mundo praticamente infinito (antes era 200)
// Mapa de ids de bloco (igual ao cliente):
//   1..27  blocos · 28..32 plantas · 33 terra arada · 34..37 plantação · 38..42 tochas
//   43..58 porta (metade de baixo 43..50 = orientação*2 + aberta · metade de cima +8)
//   59..66 cama (pé 59..62 = direção da cabeceira · cabeceira 63..66)
//   75..90 porta espelhada (dobradiça do outro lado, mesma ordem da porta normal)
const ID_MAXBLOCO = 90;
const MAX_TIPO = ID_MAXBLOCO;  // ids acima disso são recusados
const TIMEOUT = 10;            // segundos sem sinal => jogador removido
const MAX_LOG = 300;
const MAX_BODY = 1024 * 1024;  // 1 MB
const TICK_MS = 66;            // ~15 envios por segundo pelo WebSocket
const MAX_ITEM = 63;           // ids de item aceitos nos drops e na mão (blocos, plantas, ferramentas, cama 43 e porta 44)
const DROP_TTL_MS = 5 * 60 * 1000;   // item no chão some depois de 5 min
const MAX_DROPS = 500;
const ALCANCE_PEGAR_XZ = 6;    // distância horizontal máxima (tolerante à latência) para coletar
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------- Mobs (ovelha, porco, zumbi) — o servidor guarda a lista e a vida; um jogador "dono" simula a IA ----------
const MOB_NOMES = ['ovelha', 'porco', 'zumbi'];
const MOB_HP = [4, 4, 20];
const MOB_MAX = [30, 30, 24];       // limite global por espécie
const MOB_RAIO_ATIVO = 80;          // mob sem nenhum jogador por perto some
const MOB_RAIO_DONO = 64;           // dono se afastou demais: passa para o jogador mais próximo
const MOB_RAIO_ENVIO = 110;         // só manda ao jogador os mobs perto dele
const ITEM_CARNE = 33, ITEM_LA = 42;   // ids de item (NTIPOS=27 no cliente: carne = NTIPOS+6, lã = NTIPOS+15)
const mobs = new Map();             // id -> { i, tp, x, y, z, r, e, sg, hp, dono }
let mobIdSeq = 0;
let mevSeq = 0;                     // eventos: dano/morte de mobs e morte de jogadores
let mobEv = [];
const taxaMob = {};                 // nome -> { t, n, d } (limites por segundo)
const contMortes = {};              // nome -> contador de mortes enviado pelo cliente

// ---------- Plantações (trigo) ----------
const ID_PLANTADO = 34;        // arado com semente; depois 35 (broto), 36 (crescendo) e 37 (trigo pronto)
const ID_MADURO = 37;          // (antes 31..34: ficou desatualizado quando entraram os minérios e a terra arada virava plantação sozinha)
const TEMPO_ESTAGIO_MS = Number(process.env.TEMPO_ESTAGIO_MS) || 40 * 1000;   // tempo de cada estágio (~2 min no total)
const cultivos = new Map();    // "x,y,z" -> hora (ms) em que passa para o próximo estágio

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
for (const k in blocos) agendarCrescimento(k, blocos[k]);   // retoma as plantações salvas

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

function agendarCrescimento(k, b) {
    if (b >= ID_PLANTADO && b < ID_MADURO) cultivos.set(k, Date.now() + TEMPO_ESTAGIO_MS * (0.8 + Math.random() * 0.4));
    else cultivos.delete(k);
}

function mudarBloco(x, y, z, b) {
    const k = `${x},${y},${z}`;
    blocos[k] = b;
    agendarCrescimento(k, b);
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

function mobEvento(e) {
    e.s = ++mevSeq;
    mobEv.push(e);
    if (mobEv.length > 200) mobEv = mobEv.slice(-200);
}
function contarMobs(tp) { let n = 0; for (const m of mobs.values()) if (m.tp === tp) n++; return n; }
function criarMobServidor(tp, x, y, z, dono) {
    if (contarMobs(tp) >= MOB_MAX[tp]) return;
    const id = ++mobIdSeq;
    mobs.set(id, { i: id, tp, x, y, z, r: Math.random() * 6.283, e: 0, sg: tp === 2 ? 1.6 : 0, hp: MOB_HP[tp], dono });
}
function soltarLootMob(m, por) {
    if (m.tp === 2) return;                                // zumbi não solta nada
    const j = jogadores[por];
    if (!j || !j.surv) return;                             // só no modo sobrevivência de quem matou
    const qtd = 1 + (Math.random() < 0.5 ? 1 : 0);
    for (let k = 0; k < qtd; k++) criarDrop(m.x + (Math.random() - 0.5) * 0.3, m.y + 0.5, m.z + (Math.random() - 0.5) * 0.3, ITEM_CARNE);
    if (m.tp === 0) criarDrop(m.x + (Math.random() - 0.5) * 0.3, m.y + 0.5, m.z + (Math.random() - 0.5) * 0.3, ITEM_LA);
}
function danoMob(nome, id, dano, dx, dz, fogo) {
    const m = mobs.get(id);
    if (!m) return;
    const eu = jogadores[nome];
    if (!eu) return;
    if (fogo) { if (m.dono !== nome || m.tp !== 2) return; dano = Math.min(dano, 1.5); }
    else {
        if (Math.hypot(m.x - eu.x, m.z - eu.z) > 12) return;   // longe demais (com folga para a latência)
        dano = Math.min(dano, 3);
    }
    if (!(dano > 0)) return;
    m.hp -= dano;
    if (m.hp <= 0) {
        mobs.delete(id);
        mobEvento({ t: 'm', i: id, k: m.tp, x: +m.x.toFixed(2), y: +m.y.toFixed(2), z: +m.z.toFixed(2), por: nome });
        if (!fogo) soltarLootMob(m, nome);
    } else if (!fogo) {
        mobEvento({ t: 'd', i: id, x: +dx || 0, z: +dz || 0, por: nome });
    }
}
// a cada segundo: troca de dono, remove mobs abandonados ou caídos no vazio
function manterMobs() {
    if (!mobs.size) return;
    const lista = Object.values(jogadores);
    for (const [id, m] of mobs) {
        if (m.y < -8) { mobs.delete(id); continue; }
        const dono = jogadores[m.dono];
        if (dono && Math.hypot(dono.x - m.x, dono.z - m.z) <= MOB_RAIO_DONO) continue;
        let melhor = null, md = Infinity;
        for (const j of lista) { const d = Math.hypot(j.x - m.x, j.z - m.z); if (d < md) { md = d; melhor = j; } }
        if (!melhor || md > MOB_RAIO_ATIVO) mobs.delete(id);
        else m.dono = melhor.nome;
    }
}
function listaMobsPara(nome) {
    const eu = jogadores[nome];
    const out = [];
    for (const m of mobs.values()) {
        if (eu && Math.hypot(m.x - eu.x, m.z - eu.z) > MOB_RAIO_ENVIO) continue;
        out.push([m.i, m.tp, +m.x.toFixed(2), +m.y.toFixed(2), +m.z.toFixed(2), +m.r.toFixed(2), m.e, m.hp, m.dono, m.sg]);
    }
    return out;
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
        item: (Number.isInteger(+d.item) && +d.item >= 0 && +d.item <= MAX_ITEM) ? +d.item : -1,   // item na mão
        emote: String(d.emote ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 16),
        keys: d.keys && typeof d.keys === 'object' ? d.keys : {},
        pit: Math.max(-1.6, Math.min(1.6, Number(d.pit) || 0)),            // inclinação da cabeça (olhar para cima/baixo)
        gp: (Math.trunc(Number(d.gp)) || 0) % 1000000,                     // contador de golpes (anima o braço dos outros)
        com: d.com ? 1 : 0,                                                // comendo
        qb: d.qb ? 1 : 0,                                                  // quebrando bloco
        surv: d.surv ? 1 : 0,                                              // modo sobrevivência (decide se recebe loot)
        dorm: (Array.isArray(d.dorm) && d.dorm.length === 4 && d.dorm.every(v => Number.isFinite(+v))) ? d.dorm.map(v => +(+v).toFixed(2)) : null,
        ultimo_acesso: agora
    };
    // morte do jogador: avisa todo mundo
    {
        const mc = Math.trunc(Number(d.mortes)) || 0;
        if (contMortes[nome] !== undefined && mc > contMortes[nome]) mobEvento({ t: 'p', n: nome });
        contMortes[nome] = mc;
    }
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
    // mobs: criação (o servidor dá o id), atualização pelo dono e dano
    {
        const eu = jogadores[nome];
        const ms = Date.now();
        const tm = taxaMob[nome] || (taxaMob[nome] = { t: ms, n: 0, d: 0 });
        if (ms - tm.t > 1000) { tm.t = ms; tm.n = 0; tm.d = 0; }
        if (Array.isArray(d.mobs_novos)) {
            for (const mn of d.mobs_novos.slice(0, 4)) {
                if (!Array.isArray(mn) || mn.length < 4 || tm.n >= 6) continue;
                const tp = Math.trunc(+mn[0]), x = +mn[1], y = +mn[2], z = +mn[3];
                if (!(tp >= 0 && tp < MOB_NOMES.length) || ![x, y, z].every(Number.isFinite)) continue;
                if (y < -2 || y > H + 8 || Math.abs(x) > LIMITE_XZ || Math.abs(z) > LIMITE_XZ) continue;
                if (Math.hypot(x - eu.x, z - eu.z) > 90) continue;
                tm.n++;
                criarMobServidor(tp, Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(z * 100) / 100, nome);
            }
        }
        if (Array.isArray(d.mobs_upd)) {
            for (const u of d.mobs_upd.slice(0, 60)) {
                if (!Array.isArray(u) || u.length < 6) continue;
                const m = mobs.get(Math.trunc(+u[0]));
                if (!m || m.dono !== nome) continue;                 // só o dono move o mob
                const x = +u[1], y = +u[2], z = +u[3], r = +u[4];
                if (![x, y, z, r].every(Number.isFinite)) continue;
                if (Math.abs(x) > LIMITE_XZ || Math.abs(z) > LIMITE_XZ || y < -20 || y > H + 40) continue;
                m.x = x; m.y = y; m.z = z; m.r = r;
                m.e = Math.trunc(+u[5]) || 0;
                m.sg = Math.max(0, Math.min(2, +u[6] || 0));
            }
        }
        if (Array.isArray(d.mobs_dano)) {
            for (const dn of d.mobs_dano.slice(0, 8)) {
                if (!Array.isArray(dn) || dn.length < 2 || tm.d >= 30) continue;
                tm.d++;
                danoMob(nome, Math.trunc(+dn[0]), +dn[1], dn[2], dn[3], !!dn[4]);
            }
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
        if (agora - jogadores[k].ultimo_acesso > TIMEOUT) { delete jogadores[k]; delete donos[k]; delete ultimoChatMs[k]; delete taxaDrop[k]; delete taxaMob[k]; delete contMortes[k]; }
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
    const desdeMev = Number.isFinite(+corpo.desdeMev) ? Math.trunc(+corpo.desdeMev) : -1;
    limparInativos(agora);
    const completo = precisaCompleto(desde);
    const saida = { jogadores: Object.values(jogadores), seq, tempo: agora, completo };
    if (completo) saida.blocos = blocos;
    else saida.eventos = log.filter(l => l.s > desde);
    saida.cseq = cseq;
    saida.mobs = listaMobsPara(nome);
    saida.mseq = mevSeq;
    if (desdeMev >= 0 && desdeMev < mevSeq) { const ev = mobEv.filter(e => e.s > desdeMev); if (ev.length) saida.mev = ev; }
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
    if (cli.nome && donos[cli.nome] === cli) { delete donos[cli.nome]; delete jogadores[cli.nome]; delete contMortes[cli.nome]; }
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
    const cli = { socket, nome: null, enviado: -1, enviadoChat: cseq, enviadoMev: mevSeq, ack: 0, dropVer: -1, aberto: true, buf: head && head.length ? Buffer.from(head) : Buffer.alloc(0), frag: [] };
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
        extra += `,"mobs":${JSON.stringify(listaMobsPara(cli.nome))},"mseq":${mevSeq}`;
        if (cli.enviadoMev < mevSeq) {
            const ev = mobEv.filter(e => e.s > cli.enviadoMev);
            if (ev.length) extra += `,"mev":${JSON.stringify(ev)}`;
            cli.enviadoMev = mevSeq;
        }
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

// Mobs: troca de dono / limpeza
setInterval(manterMobs, 1000);

// Plantações crescem sozinhas: a cada estágio o bloco do arado muda (todos os jogadores recebem o evento)
setInterval(() => {
    const agora = Date.now();
    for (const [k, quando] of cultivos) {
        if (agora < quando) continue;
        const b = blocos[k];
        if (!(b >= ID_PLANTADO && b < ID_MADURO)) { cultivos.delete(k); continue; }
        const [x, y, z] = k.split(',').map(Number);
        mudarBloco(x, y, z, b + 1);
    }
}, 1000);

server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

// Garante que o mundo seja salvo ao encerrar (o Render manda SIGTERM no redeploy)
function encerrar() {
    try { fs.writeFileSync(ARQ_BLOCOS, JSON.stringify(blocos)); } catch (e) { }
    process.exit(0);
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
