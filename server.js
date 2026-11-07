// server.js - Servidor do Pixel Block World (substitui salvar_posicao.php)
// Sem dependências externas: usa só módulos nativos do Node.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
// No Render, aponte DATA_DIR para o disco persistente (ex.: /var/data). Local: pasta do projeto.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const ARQ_BLOCOS = path.join(DATA_DIR, 'mundo_blocos.json');

const H = 48;
const LIMITE_XZ = 200;
const MAX_TIPO = 255;
const TIMEOUT = 10;          // segundos sem sinal => jogador removido
const MAX_LOG = 300;
const MAX_BODY = 1024 * 1024; // 1 MB

// ---------- Estado ----------
const jogadores = {};        // nome -> dados
let log = [];                // eventos de blocos recentes
let seq = 0;
let blocos = {};             // "x,y,z" -> tipo

try {
    if (fs.existsSync(ARQ_BLOCOS)) {
        blocos = JSON.parse(fs.readFileSync(ARQ_BLOCOS, 'utf8')) || {};
    }
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

// ---------- Lógica de sincronização ----------
function sincronizar(corpo) {
    const agora = Math.floor(Date.now() / 1000);
    const desde = Number.isFinite(+corpo.desde) ? Math.trunc(+corpo.desde) : -1;
    const d = corpo.dados_jogador;

    if (d && typeof d === 'object') {
        const nome = String(d.nome ?? '').replace(/[^\p{L}\p{N}_ -]/gu, '').slice(0, 16);
        if (nome !== '') {
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
        }
    }

    // Remove inativos
    for (const k in jogadores) {
        if (agora - jogadores[k].ultimo_acesso > TIMEOUT) delete jogadores[k];
    }

    const minSeq = log.length ? log[0].s : seq + 1;
    const completo = desde < 0 || desde > seq || desde + 1 < minSeq;

    const saida = {
        jogadores: Object.values(jogadores),
        seq,
        tempo: agora,
        completo
    };
    if (completo) saida.blocos = blocos;
    else saida.eventos = log.filter(l => l.s > desde);
    return saida;
}

// ---------- HTTP ----------
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
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { res.writeHead(404); return res.end('index.html não encontrado'); }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-cache' });
            res.end(data);
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Não encontrado');
});

server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

// Garante que o mundo seja salvo ao encerrar (o Render manda SIGTERM no redeploy)
function encerrar() {
    try { fs.writeFileSync(ARQ_BLOCOS, JSON.stringify(blocos)); } catch (e) { }
    process.exit(0);
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
