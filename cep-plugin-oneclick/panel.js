/**
 * EditFlux ワンクリック編集パネル
 * ボタンのクリックをローカルの automation-server (HTTP) に橋渡しする。
 * CEPのNode統合を使い、サーバー未起動時はこのパネルから子プロセスとして起動できる。
 */
(function () {
    var cp = require('child_process');
    var path = require('path');
    var fs = require('fs');

    var PORT = 4747;
    var BASE = 'http://127.0.0.1:' + PORT;
    var SERVER_SCRIPT = path.join(__dirname, 'automation-server', 'server.js');
    var csInterface = new CSInterface();
    var serverProc = null;

    // GUIアプリ(Premiere)から起動されるとPATHが最小構成になり、nvm等でインストールしたnodeが
    // 見つからないことが多い。よくある場所を探し、見つかればフルパスを使う。
    function resolveNodeBinary() {
        var os = require('os');
        var home = os.homedir();
        var candidates = ['/usr/local/bin/node', '/opt/homebrew/bin/node'];
        try {
            var nvmDir = path.join(home, '.nvm', 'versions', 'node');
            if (fs.existsSync(nvmDir)) {
                var versions = fs.readdirSync(nvmDir).sort().reverse();
                versions.forEach(function (v) {
                    candidates.push(path.join(nvmDir, v, 'bin', 'node'));
                });
            }
        } catch (e) {}
        for (var i = 0; i < candidates.length; i++) {
            if (fs.existsSync(candidates[i])) return candidates[i];
        }
        return 'node'; // PATHに期待してフォールバック
    }
    var NODE_BIN = resolveNodeBinary();

    function log(message, level) {
        level = level || 'info';
        var container = document.getElementById('logContainer');
        var el = document.createElement('div');
        el.className = 'entry ' + level;
        el.textContent = message;
        container.insertBefore(el, container.firstChild);
        console.log('[EditFlux] ' + message);
    }

    function setDot(id, ok) {
        var dot = document.getElementById(id);
        if (dot) dot.className = 'dot' + (ok ? ' ok' : '');
    }

    function setButtonsEnabled(enabled) {
        ['jumpCutBtn'].forEach(function (id) {
            var btn = document.getElementById(id);
            if (btn) btn.disabled = !enabled;
        });
    }

    async function fetchJSON(urlPath, method, body) {
        var res = await fetch(BASE + urlPath, {
            method: method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined
        });
        var data = await res.json();
        if (!res.ok || data.success === false) {
            throw new Error(data.error || ('HTTP ' + res.status));
        }
        return data;
    }

    var telopPresetsLoaded = false;
    async function loadTelopPresets() {
        var grid = document.getElementById('styleGrid');
        try {
            var data = await fetchJSON('/telop-presets', 'GET');
            var presets = data.presets || [];
            if (presets.length === 0) {
                grid.innerHTML = '<div class="style-empty">まだ登録がありません。ONECLICK.md参照。</div>';
                return;
            }
            grid.innerHTML = presets.map(function (p) {
                return '<div class="style-tile"><img src="' + BASE + p.thumbUrl + '" alt="' + p.label + '">' +
                    '<div class="style-label">' + p.label + '</div></div>';
            }).join('');
            telopPresetsLoaded = true;
        } catch (e) {
            grid.innerHTML = '<div class="style-empty">取得に失敗しました</div>';
        }
    }

    async function checkHealth() {
        try {
            var data = await fetchJSON('/health', 'GET');
            setDot('serverDot', true);
            document.getElementById('serverText').textContent = '自動化サーバー: 起動中';
            if (!telopPresetsLoaded) loadTelopPresets();
            if (data.bridgeConnected) {
                setDot('bridgeDot', true);
                document.getElementById('bridgeText').textContent =
                    'Premiere Bridge: 接続OK (' + (data.activeSequence || '—') + ')';
                setButtonsEnabled(true);
            } else {
                setDot('bridgeDot', false);
                document.getElementById('bridgeText').textContent = 'Premiere Bridge: 未接続 (MCP Bridgeパネルを起動してください)';
                setButtonsEnabled(false);
            }
            return true;
        } catch (e) {
            setDot('serverDot', false);
            document.getElementById('serverText').textContent = '自動化サーバー: 停止中';
            setDot('bridgeDot', false);
            document.getElementById('bridgeText').textContent = 'Premiere Bridge: —';
            setButtonsEnabled(false);
            return false;
        }
    }

    window.startServer = async function () {
        if (!fs.existsSync(SERVER_SCRIPT)) {
            log('automation-server/server.js が見つかりません: ' + SERVER_SCRIPT, 'error');
            return;
        }
        // 既に(別プロセスとして)起動済みなら二重起動しない。ポート競合で新しい方が
        // 黙って落ち、「ボタンを押したのにコードが更新されない」状態になるのを防ぐ。
        var alreadyRunning = await checkHealth();
        if (alreadyRunning) {
            log('自動化サーバーは既に起動中です。コードを更新した後は、一度ターミナルで `lsof -i :4747` 等で古いプロセスを終了するか、Premiereを再起動してから押し直してください。', 'info');
            return;
        }
        log('自動化サーバーを起動しています…', 'info');
        try {
            serverProc = cp.spawn(NODE_BIN, [SERVER_SCRIPT], {
                detached: false,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            serverProc.stdout.on('data', function (d) { console.log('[server] ' + d.toString()); });
            serverProc.stderr.on('data', function (d) { console.log('[server:err] ' + d.toString()); });
            serverProc.on('exit', function (code) {
                log('自動化サーバーが終了しました (code ' + code + ')', 'error');
                setDot('serverDot', false);
            });
            setTimeout(function () {
                checkHealth().then(function (ok) {
                    log(ok ? '自動化サーバーの起動を確認しました' : 'サーバー起動後も応答がありません。ログを確認してください', ok ? 'ok' : 'error');
                });
            }, 1500);
        } catch (e) {
            log('起動に失敗しました: ' + e.message, 'error');
        }
    };

    window.runJumpCut = async function () {
        var btn = document.getElementById('jumpCutBtn');
        var preset = document.getElementById('jumpCutPreset').value;
        btn.disabled = true;
        log('ジャンプカットを実行中… (無音検出 → カット適用)', 'info');
        try {
            var result = await fetchJSON('/jump-cut', 'POST', { preset: preset });
            var detail = result.method === 'reinsert'
                ? '再配置区間 ' + (result.keepRegions || 0)
                : '削除クリップ 映像' + (result.deletedVideoClips || 0) + '・音声' + (result.deletedAudioClips || 0);
            log(
                'ジャンプカット完了: "' + result.sequenceName + '" / カット数 ' + result.cuts +
                ' / 方式: ' + result.method + ' / ' + detail,
                'ok'
            );
        } catch (e) {
            log('ジャンプカット失敗: ' + e.message, 'error');
        } finally {
            btn.disabled = false;
        }
    };

    window.onFileChosen = async function () {
        var input = document.getElementById('mediaFile');
        var file = input.files && input.files[0];
        if (!file) return;
        var filePath = file.path;
        document.getElementById('fileLabel').textContent = filePath;
        log('メディアを挿入中: ' + filePath, 'info');
        try {
            var result = await fetchJSON('/insert-media', 'POST', { filePath: filePath });
            log('挿入完了: "' + result.itemName + '" (' + result.method + ')', 'ok');
        } catch (e) {
            log('挿入失敗: ' + e.message, 'error');
        }
    };

    window.showStep = function (n) {
        document.querySelectorAll('.step-tab').forEach(function (el) {
            el.classList.toggle('active', Number(el.dataset.step) === n);
        });
        document.querySelectorAll('.step-content').forEach(function (el) {
            el.classList.toggle('active', Number(el.dataset.step) === n);
        });
    };

    document.addEventListener('DOMContentLoaded', function () {
        checkHealth();
        setInterval(checkHealth, 4000);
    });
})();
