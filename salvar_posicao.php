<?php
// salvar_posicao.php - Servidor de sincronização com persistência de blocos e emotes
header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

const W = 96, D = 96, H = 48;
const TIPOS = 10;
const TIMEOUT = 10;
const MAX_LOG = 300;

$fp = fopen(__DIR__ . '/estado_vivo.json', 'c+');
if (!$fp) {
    http_response_code(500);
    echo json_encode(['erro' => 'Sem permissão de escrita']);
    exit;
}
flock($fp, LOCK_EX);

$e = json_decode(stream_get_contents($fp), true);
if (!is_array($e)) $e = [];$e += ['jogadores' => [], 'log' => [], 'seq' => 0];

$arqBlocos = __DIR__ . '/mundo_blocos.json';$blocos = null;
$blocosMudou = false;

function carregarBlocos() {
    global $blocos,$arqBlocos;
    if ($blocos === null) {$blocos = file_exists($arqBlocos) ? (json_decode(file_get_contents($arqBlocos), true) ?: []) : [];
    }
}

function mudarBloco($x,$y, $z,$b) {
    global $blocos, $blocosMudou,$e;
    $blocos["$x,$y,$z"] = $b;
    $blocosMudou = true;
    $e['seq']++;
    $e['log'][] = ['s' =>$e['seq'], 'x' => $x, 'y' =>$y, 'z' => $z, 'b' =>$b];
    if (count($e['log']) > MAX_LOG) {
        $e['log'] = array_slice($e['log'], -MAX_LOG);
    }
}

$agora = time();$desde = isset($_POST['desde']) ? intval($_POST['desde']) : -1;

if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['dados_jogador'])) {$d = json_decode($_POST['dados_jogador'], true);$nome = is_array($d) ? mb_substr(preg_replace('/[^\p{L}\p{N}_ -]/u', '', (string)($d['nome'] ?? '')), 0, 16) : '';

    if ($nome !== '') {
        $k =$d['keys'] ?? [];
        $e['jogadores'][$nome] = [
            'nome'    => $nome,
            'genero'  => in_array($d['genero'] ?? 'm', ['m', 'f']) ?$d['genero'] : 'm',
            'x'       => floatval($d['x'] ?? 0), 'y'       => floatval($d['y'] ?? 0),
            'z'       => floatval($d['z'] ?? 0), 'rot'     => floatval($d['rot'] ?? 0),
            'emote'   => mb_substr(preg_replace('/[^a-z0-9_-]/i', '', (string)($d['emote'] ?? '')), 0, 16), 'keys'    =>$k,
            'ultimo_acesso' => $agora,
        ];

        // Processa edições de blocos vindas do jogador
        if (!empty($d['blocos']) && is_array($d['blocos'])) {
            carregarBlocos();
            foreach ($d['blocos'] as$bl) {
                if (count($bl) >= 4) { [$bx, $by,$bz, $bTipo] =$bl;
                    $bx = intval($bx); $by = intval($by); $bz = intval($bz); $bTipo = intval($bTipo);
                    if ($by >= 0 &&$by < H && abs($bx) < 200 && abs($bz) < 200) {
                        mudarBloco($bx,$by, $bz,$bTipo);
                    }
                }
            }
        }
    }
}

// Remove inativos
foreach ($e['jogadores'] as $k =>$j) {
    if ($agora -$j['ultimo_acesso'] > TIMEOUT) {
        unset($e['jogadores'][$k]);
    }
}

$seq =$e['seq'];
$minSeq =$e['log'] ? $e['log'][0]['s'] :$seq + 1;
$completo =$desde < 0 || $desde >$seq || $desde + 1 <$minSeq;

$saida = [
    'jogadores' => array_values($e['jogadores']),
    'seq'       => $seq,
    'tempo'     => $agora,
    'completo'  => $completo
];

if ($completo) {
    carregarBlocos();
    $saida['blocos'] =$blocos;
} else {
    $saida['eventos'] = array_values(array_filter($e['log'], fn($l) => $l['s'] >$desde));
}

if ($blocosMudou) {
    file_put_contents($arqBlocos, json_encode($blocos));
}

ftruncate($fp, 0);
rewind($fp);
fwrite($fp, json_encode($e));
fflush($fp);
flock($fp, LOCK_UN);
fclose($fp);

echo json_encode($saida);