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
        ['jumpCutBtn', 'insertBrollBtn', 'packageBtn'].forEach(function (id) {
            var btn = document.getElementById(id);
            if (id === 'packageBtn' && pkgTimer) return;  // 作成中は押せないままにする
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

    async function checkHealth() {
        try {
            var data = await fetchJSON('/health', 'GET');
            setDot('serverDot', true);
            document.getElementById('serverText').textContent = '自動化サーバー: 起動中';
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
        var checked = document.querySelector('input[name="jumpCutPreset"]:checked');
        var preset = checked ? checked.value : 'natural';
        btn.disabled = true;
        log('ジャンプカットを実行中… (無音検出 → カット適用)', 'info');
        try {
            var result = await fetchJSON('/jump-cut', 'POST', { preset: preset });
            var detail = result.method === 'reinsert'
                ? '再配置区間 ' + (result.keepRegions || 0)
                : '削除クリップ 映像' + (result.deletedVideoClips || 0) + '・音声' + (result.deletedAudioClips || 0);
            log(
                'ジャンプカット完了: "' + result.sequenceName + '" / カット数 ' + result.cuts +
                ' / 方式: ' + result.method + ' / ' + detail +
                (result.thresholdDb != null ? ' / 無音しきい値 ' + [].concat(result.thresholdDb).join(',') + 'dB(自動)' : ''),
                'ok'
            );
        } catch (e) {
            log('ジャンプカット失敗: ' + e.message, 'error');
        } finally {
            btn.disabled = false;
        }
    };

    window.runInsertBroll = async function () {
        var btn = document.getElementById('insertBrollBtn');
        var fullCoverage = document.getElementById('brollFullCoverage').checked;
        btn.disabled = true;
        log('インサート動画を解析中… (文字起こし → 内容判定 → 挿入)', 'info');
        try {
            var result = await fetchJSON('/insert-broll', 'POST', { fullCoverage: fullCoverage });
            if (result.message) {
                log(result.message, 'info');
            } else {
                log(
                    'インサート挿入完了: "' + result.sequenceName + '" / ' + result.inserted + '箇所' +
                    ' / カバー率 約' + result.coveragePercent + '%' +
                    ' / 判定方法: ' + (result.matchSource === 'gemini' ? 'Gemini' : 'キーワード辞書') +
                    ' / フォルダ: ' + (result.folders || []).join('、'),
                    'ok'
                );
                if (result.geminiError) log('Gemini注意: ' + result.geminiError + ' (キーワード辞書にフォールバックしました)', 'error');
                if (result.errors && result.errors.length > 0) {
                    result.errors.forEach(function (e) { log('注意: ' + e, 'error'); });
                }
            }
        } catch (e) {
            log('インサート動画の挿入に失敗: ' + e.message, 'error');
        } finally {
            btn.disabled = false;
        }
    };

    // ───── ⑥ 編集パッケージ ─────
    var PKG_FIELDS = ['pkgTitle', 'pkgChannel', 'pkgBgm', 'pkgSfx'];
    var pkgTimer = null;

    function restorePackageFields() {
        PKG_FIELDS.forEach(function (id) {
            try {
                var v = localStorage.getItem('editflux.' + id);
                if (v) document.getElementById(id).value = v;
            } catch (e) {}
        });
    }

    function savePackageFields() {
        PKG_FIELDS.forEach(function (id) {
            try { localStorage.setItem('editflux.' + id, document.getElementById(id).value); } catch (e) {}
        });
    }

    function setPackageRunning(running) {
        document.getElementById('packageBtn').disabled = running;
        document.getElementById('packageCancelBtn').style.display = running ? 'block' : 'none';
    }

    function fmtSec(s) {
        return Math.floor(s / 60) + '分' + (s % 60) + '秒';
    }

    async function pollPackage() {
        var st;
        try { st = await fetchJSON('/package/status', 'GET'); } catch (e) { return; }
        var box = document.getElementById('pkgProgress');
        if (st.state === 'running' || st.state === 'importing') {
            setPackageRunning(true);
            var last = (st.log || []).filter(function (l) { return !/^\s*[{}"]/.test(l); }).slice(-3).join('\n');
            box.textContent = '作成中… ' + fmtSec(st.elapsedSec) + '経過\n' + last;
            return;
        }
        clearInterval(pkgTimer);
        pkgTimer = null;
        setPackageRunning(false);
        if (st.state === 'done') {
            var s = st.summary || {}, imp = st.importResult || {};
            box.textContent = '完成しました(' + fmtSec(st.elapsedSec) + ')\n保存先: ' + st.root;
            log('編集パッケージ完成: シーケンス「' + (imp.name || s['シーケンス名']) + '」を読み込みました / カット' + s['V1/A1カット数'] +
                ' / テロップ' + s['V2通常テロップ数'] + '(強調' + s['V3強調テロップ数'] + ') / BGM ' + s['BGM'] +
                ' / 効果音' + (s['効果音'] || []).length + ' / XML検証: ' + s['検証'] +
                ' / Premiereでの数の一致: ' + (imp.countsMatch ? 'OK' : '要確認'), 'ok');
            log('仕上げ: V2・V3のテロップを全選択して、テキストスタイル(背景の帯・中央揃え)を一括で当ててください', 'info');
        } else if (st.state === 'error') {
            box.textContent = '失敗しました: ' + st.error;
            log('編集パッケージの作成に失敗: ' + st.error, 'error');
        } else if (st.state === 'canceled') {
            box.textContent = '中止しました';
        }
    }

    window.runPackage = async function () {
        savePackageFields();
        var mode = document.querySelector('input[name="pkgMode"]:checked');
        var body = {
            title: document.getElementById('pkgTitle').value.trim(),
            channel: document.getElementById('pkgChannel').value.trim(),
            bgm: document.getElementById('pkgBgm').value.trim(),
            sfx: document.getElementById('pkgSfx').value.trim(),
            script: document.getElementById('pkgScript').value,
            mode: mode ? mode.value : 'natural',
            misspeak: document.getElementById('pkgMisspeak').checked
        };
        try {
            var r = await fetchJSON('/package/start', 'POST', body);
            log('編集パッケージの作成を開始しました(20〜30分): ' + r.video, 'info');
            setPackageRunning(true);
            if (!pkgTimer) pkgTimer = setInterval(pollPackage, 3000);
            pollPackage();
        } catch (e) {
            log('開始できませんでした: ' + e.message, 'error');
        }
    };

    window.cancelPackage = async function () {
        try { await fetchJSON('/package/cancel', 'POST', {}); log('編集パッケージの作成を中止しました', 'info'); }
        catch (e) { log('中止に失敗: ' + e.message, 'error'); }
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
        restorePackageFields();
        // パネルを開き直したときに、作成中のジョブがあれば進み具合の表示を再開する
        fetchJSON('/package/status', 'GET').then(function (st) {
            if (st.state === 'running' || st.state === 'importing') {
                pkgTimer = setInterval(pollPackage, 3000);
                pollPackage();
            }
        }).catch(function () {});
    });
})();
