// server.js - Servidor Node.js para Pixel Block World
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos do diretório atual (index.html, etc.)
app.use(express.static(__dirname));

const ARQ_MUNDO = path.join(__dirname, 'mundo_blocos.json');
let blocos = {};
if (fs.existsSync(ARQ_MUNDO)) {
    try {
        blocos = JSON.parse(fs.readFileSync(ARQ_MUNDO, 'utf8'));
    } catch (e) {
        blocos = {};
    }
}

function salvarMundo() {
    fs.writeFileSync(ARQ_MUNDO, JSON.stringify(blocos));
}

// Lista de jogadores conectados
const jogadores = new Map();

wss.on('connection', (ws) => {
    let nomeAtual = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.tipo === 'entrar' || data.tipo === 'atualizar') {
                nomeAtual = data.nome;
                jogadores.set(nomeAtual, {
                    nome: data.nome,
                    genero: data.genero || 'm',
                    x: data.x || 0,
                    y: data.y || 0,
                    z: data.z || 0,
                    rot: data.rot || 0,
                    emote: data.emote || '',
                    ultimoAcesso: Date.now()
                });

                // Se houver blocos modificados enviados pelo cliente
                if (data.blocos && Array.isArray(data.blocos)) {
                    let mudou = false;
                    data.blocos.forEach(bl => {
                        if (bl.length >= 4) {
                            const [bx, by, bz, bTipo] = bl;
                            if (by >= 0 && by < 48 && Math.abs(bx) < 200 && Math.abs(bz) < 200) {
                                blocos[`${bx},${by},${bz}`] = bTipo;
                                mudou = true;
                            }
                        }
                    });
                    if (mudou) salvarMundo();
                }
            }
        } catch (e) {
            console.error('Erro ao processar mensagem WS:', e);
        }
    });

    ws.on('close', () => {
        if (nomeAtual) jogadores.delete(nomeAtual);
    });
});

// Remove jogadores inativos a cada 3 segundos
setInterval(() => {
    const agora = Date.now();
    for (const [nome, j] of jogadores.entries()) {
        if (agora - j.ultimoAcesso > 10000) {
            jogadores.delete(nome);
        }
    }
}, 3000);

// Loop para transmitir o estado global para todos os clientes conectados via HTTP Polling (substituindo o antigo PHP)
app.post('/salvar_posicao.php', (req, res) => {
    try {
        const dados = JSON.parse(req.body.dados_jogador || '{}');
        const nome = dados.nome ? dados.nome.substring(0, 16) : '';

        if (nome) {
            jogadores.set(nome, {
                nome: nome,
                genero: dados.genero || 'm',
                x: parseFloat(dados.x) || 0,
                y: parseFloat(dados.y) || 0,
                z: parseFloat(dados.z) || 0,
                rot: parseFloat(dados.rot) || 0,
                emote: dados.emote || '',
                ultimoAcesso: Date.now()
            });

            if (dados.blocos && Array.isArray(dados.blocos)) {
                let mudou = false;
                dados.blocos.forEach(bl => {
                    if (bl.length >= 4) {
                        const [bx, by, bz, bTipo] = bl;
                        if (by >= 0 && by < 48 && Math.abs(bx) < 200 && Math.abs(bz) < 200) {
                            blocos[`${bx},${by},${bz}`] = bTipo;
                            mudou = true;
                        }
                    }
                });
                if (mudou) salvarMundo();
            }
        }

        res.json({
            jogadores: Array.from(jogadores.values()),
            seq: Date.now(),
            tempo: Math.floor(Date.now() / 1000),
            completo: true,
            blocos: blocos
        });
    } catch (e) {
        res.status(400).json({ erro: 'Requisição inválida' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
