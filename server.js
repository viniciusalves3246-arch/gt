const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(express.json());

// Rota Principal - Interface do Site (Mantida integralmente conforme solicitado)
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-br">
        <head>
            <meta charset="UTF-8">
            <title>YouTube Downloader Pro</title>
            <style>
                body { font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; padding: 50px; background: #f4f4f4; }
                .container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                input[type="text"] { width: 300px; padding: 10px; margin-bottom: 10px; }
                select { padding: 10px; margin-bottom: 10px; }
                button { padding: 10px 20px; cursor: pointer; background: #ff0000; color: white; border: none; border-radius: 4px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>YouTube Downloader (yt-dlp Engine)</h2>
                <input type="text" id="url" placeholder="Insira a URL do YouTube" required>
                <br>
                <select id="format">
                    <option value="mp4">MP4 (Vídeo)</option>
                    <option value="mp3">MP3 (Áudio)</option>
                </select>
                <br>
                <button onclick="download()">Baixar Agora</button>
            </div>

            <script>
                function download() {
                    const url = document.getElementById('url').value;
                    const format = document.getElementById('format').value;
                    if(!url) return alert('Insira uma URL');
                    
                    window.location.href = \`/download?url=\${encodeURIComponent(url)}&format=\${format}\`;
                }
            </script>
        </body>
        </html>
    `);
});

// Rota de Processamento do Download (Ajustada para Windows e tratamento de erro spawn)
app.get('/download', (req, res) => {
    const videoURL = req.query.url;
    const format = req.query.format;

    if (!videoURL) {
        return res.status(400).send('URL ausente');
    }

    let args = [];
    let filename = `download_${Date.now()}`;

    if (format === 'mp3') {
        res.header('Content-Disposition', `attachment; filename="${filename}.mp3"`);
        res.header('Content-Type', 'audio/mpeg');
        args = [
            '--quiet',
            '--no-warnings',
            '-x', 
            '--audio-format', 'mp3',
            '--audio-quality', '0', 
            '-o', '-', 
            videoURL
        ];
    } else {
        res.header('Content-Disposition', `attachment; filename="${filename}.mp4"`);
        res.header('Content-Type', 'video/mp4');
        args = [
            '--quiet',
            '--no-warnings',
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '-o', '-', 
            videoURL
        ];
    }

    // No Windows, é recomendável usar o nome completo do executável ou shell: true
    // Aqui alteramos para procurar o .exe na pasta atual ou PATH
    const ytDlp = spawn('yt-dlp.exe', args);

    // TRATAMENTO DE ERRO CRÍTICO: Captura o erro de spawn (ex: arquivo não encontrado)
    // Isso evita o erro "Unhandled 'error' event" que derruba o node
    ytDlp.on('error', (err) => {
        console.error('ERRO AO INICIAR YT-DLP:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Erro interno: O executável yt-dlp.exe não foi encontrado na pasta do projeto.');
        }
    });

    ytDlp.stdout.pipe(res);

    ytDlp.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
    });

    ytDlp.on('close', (code) => {
        if (code !== 0 && code !== null) {
            console.error(`yt-dlp finalizou com código ${code}`);
        }
    });

    req.on('close', () => {
        ytDlp.kill();
    });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});