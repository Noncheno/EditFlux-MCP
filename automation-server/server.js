#!/usr/bin/env node
/**
 * EditFlux Automation Server
 *
 * Premiere Pro内の「EditFlux ワンクリック編集」パネルから叩かれるローカルHTTPサーバー。
 * Premiere本体とは cep-plugin / cep-plugin-oneclick が常駐で読んでいる
 * ファイルベースブリッジ (command-NNN.json / response-NNN.json) を介して話す。
 * 重い処理 (ffmpegの無音検出、Whisperの文字起こし) はこのプロセス側でchild_processとして実行する。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = process.env.EDITFLUX_PORT ? parseInt(process.env.EDITFLUX_PORT, 10) : 4747;
const TEMP_DIR = process.env.PREMIERE_TEMP_DIR || path.join(os.tmpdir(), 'premiere-mcp-bridge');
const POLL_MS = 150;
const BRIDGE_TIMEOUT_MS = 45000;
const WORK_DIR = path.join(os.tmpdir(), 'editflux-work');
const GENERATE_CAPTIONS_PY = path.join(__dirname, 'generate_captions.py');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
ensureDir(TEMP_DIR);
ensureDir(WORK_DIR);

// ───────────────────────── ファイルブリッジ (Premiere側のCEPパネルと通信) ─────────────────────────

let _cmdNum = null;
function nextCmdNum() {
  if (_cmdNum === null) {
    let max = 0;
    try {
      for (const f of fs.readdirSync(TEMP_DIR)) {
        const m = f.match(/(?:response|command)-(\d+)\.json$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    } catch (_) {}
    _cmdNum = max;
  }
  _cmdNum++;
  return String(_cmdNum).padStart(3, '0');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runScript(script, timeoutMs) {
  const num = nextCmdNum();
  const cmdFile = path.join(TEMP_DIR, `command-${num}.json`);
  const respFile = path.join(TEMP_DIR, `response-${num}.json`);
  try { fs.unlinkSync(respFile); } catch (_) {}
  fs.writeFileSync(cmdFile, JSON.stringify({ id: `command-${num}`, script, timeoutMs }));

  const deadline = Date.now() + (timeoutMs || BRIDGE_TIMEOUT_MS) + 5000;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (fs.existsSync(respFile)) {
      await sleep(50);
      try {
        const raw = fs.readFileSync(respFile, 'utf8');
        return JSON.parse(raw);
      } catch (_) {
        await sleep(100);
        const raw = fs.readFileSync(respFile, 'utf8');
        return JSON.parse(raw);
      }
    }
  }
  try { fs.unlinkSync(cmdFile); } catch (_) {}
  throw new Error(
    'Premiere Proからの応答がタイムアウトしました。MCP Bridge (CEP)パネルで "Start Bridge" が押されているか確認してください。'
  );
}

// runScriptの結果はExtendScript側でJSON.stringifyされた文字列(result.result)として返ってくる。
async function evalJSON(script, timeoutMs) {
  const res = await runScript(script, timeoutMs);
  if (!res || res.success === false) {
    throw new Error((res && res.error) || 'ExtendScript execution failed');
  }
  const payload = res.result;
  if (typeof payload === 'string') {
    try { return JSON.parse(payload); } catch (_) { return payload; }
  }
  return payload;
}

// ───────────────────────── ExtendScript スニペット ─────────────────────────

function esc(value) { return JSON.stringify(String(value)); }

const SCRIPT_GET_ACTIVE_SEQ_INFO = `(function(){
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: 'アクティブなシーケンスがありません。Premiereでシーケンスを開いてください。' });
    function trackInfo(track) {
      var clips = [];
      for (var i = 0; i < track.clips.numItems; i++) {
        var c = track.clips[i];
        var mediaPath = '';
        try { if (c.projectItem) mediaPath = c.projectItem.getMediaPath() || ''; } catch (e) {}
        clips.push({
          name: c.name,
          start: c.start.seconds,
          end: c.end.seconds,
          inPoint: c.inPoint.seconds,
          outPoint: c.outPoint.seconds,
          mediaPath: mediaPath
        });
      }
      return clips;
    }
    var video = [];
    for (var vi = 0; vi < seq.videoTracks.numTracks; vi++) {
      video.push({ index: vi, clips: trackInfo(seq.videoTracks[vi]) });
    }
    var audio = [];
    for (var ai = 0; ai < seq.audioTracks.numTracks; ai++) {
      audio.push({ index: ai, clips: trackInfo(seq.audioTracks[ai]) });
    }
    return JSON.stringify({
      success: true,
      sequenceId: seq.sequenceID,
      name: seq.name.replace(/\\n/g, ''),
      durationSec: seq.end.seconds,
      numVideoTracks: seq.videoTracks.numTracks,
      numAudioTracks: seq.audioTracks.numTracks,
      video: video,
      audio: audio
    });
  } catch (e) { return JSON.stringify({ success: false, error: String(e) }); }
})();`;

function scriptDuplicateAndActivate(newName) {
  return `(function(){
    try {
      var originalSeq = app.project.activeSequence;
      if (!originalSeq) return JSON.stringify({ success: false, error: 'アクティブなシーケンスがありません' });
      var priorId = String(originalSeq.sequenceID);
      var cloneResult = originalSeq.clone();
      var newSeq = null;
      if (cloneResult) {
        if (cloneResult.videoTracks) {
          newSeq = cloneResult;
        } else if (typeof cloneResult.getSequence === 'function') {
          try { newSeq = cloneResult.getSequence(); } catch (e) {}
        }
      }
      if (!newSeq) {
        try {
          var cand = app.project.activeSequence;
          if (cand && String(cand.sequenceID) !== priorId) newSeq = cand;
        } catch (e) {}
      }
      if (!newSeq) return JSON.stringify({ success: false, error: 'シーケンスの複製に失敗しました' });
      newSeq.name = ${esc(newName)};
      try { app.project.activeSequence = newSeq; } catch (e) {}
      var active = app.project.activeSequence;
      var activated = active && String(active.sequenceID) === String(newSeq.sequenceID);
      return JSON.stringify({
        success: true,
        sequenceId: newSeq.sequenceID,
        name: newSeq.name.replace(/\\n/g, ''),
        activated: !!activated
      });
    } catch (e) { return JSON.stringify({ success: false, error: String(e) }); }
  })();`;
}

const SCRIPT_SAVE = `(function(){
  try { app.project.save(); return JSON.stringify({ success: true }); }
  catch (e) { return JSON.stringify({ success: false, error: String(e) }); }
})();`;

function scriptApplyJumpCuts(silenceRanges) {
  const silencesJSON = JSON.stringify(silenceRanges);
  return `(function(){
    try {
      var silences = ${silencesJSON};
      var seq = app.project.activeSequence;
      if (!seq) return JSON.stringify({ success: false, error: 'アクティブなシーケンスがありません' });

      var durSecs = seq.end.seconds;
      var tps = 0;
      if (durSecs > 0) {
        var durTicks = parseFloat(String(seq.end.ticks));
        if (!isNaN(durTicks) && durTicks > 0) tps = durTicks / durSecs;
      }
      var allTracks = [];
      for (var ti = 0; ti < seq.videoTracks.numTracks; ti++) allTracks.push(seq.videoTracks[ti]);
      for (var ti = 0; ti < seq.audioTracks.numTracks; ti++) allTracks.push(seq.audioTracks[ti]);
      if (tps <= 0) {
        for (var ti = 0; ti < allTracks.length && tps <= 0; ti++) {
          var track = allTracks[ti];
          for (var ci = 0; ci < track.clips.numItems && tps <= 0; ci++) {
            var c = track.clips[ci];
            var cSec = c.duration.seconds;
            var cTicks = parseFloat(String(c.duration.ticks));
            if (cSec > 0 && !isNaN(cTicks) && cTicks > 0) tps = cTicks / cSec;
          }
        }
      }
      if (tps <= 0) return JSON.stringify({ success: false, error: 'シーケンスのticks-per-secondを特定できませんでした' });
      if (!durSecs || durSecs <= 0) {
        for (var ti = 0; ti < allTracks.length; ti++) {
          var track = allTracks[ti];
          for (var ci = 0; ci < track.clips.numItems; ci++) {
            var cEnd = track.clips[ci].end.seconds;
            if (cEnd > durSecs) durSecs = cEnd;
          }
        }
      }
      if (!durSecs || durSecs <= 0) return JSON.stringify({ success: false, error: 'シーケンスの長さを特定できませんでした' });

      var cutSet = {};
      var cuts = [];
      for (var i = 0; i < silences.length; i++) {
        var s = silences[i].start, e = silences[i].end;
        if (s > 0.01 && s < durSecs - 0.01 && !cutSet[s]) { cuts.push(s); cutSet[s] = 1; }
        if (e > 0.01 && e < durSecs - 0.01 && !cutSet[e]) { cuts.push(e); cutSet[e] = 1; }
      }
      cuts.sort(function(a, b) { return a - b; });

      var qeSeq = null;
      try { qeSeq = qe.project.getActiveSequence(); } catch (_) {}
      var razored = 0, razorErrors = 0;
      if (qeSeq) {
        for (var i = 0; i < cuts.length; i++) {
          var ticks = String(Math.round(cuts[i] * tps));
          try { qeSeq.razor(ticks); razored++; } catch (e2) { razorErrors++; }
        }
      } else {
        return JSON.stringify({ success: false, error: 'qe DOMが利用できません(app.enableQE()が必要)' });
      }

      function isSilent(startSec, endSec) {
        var tol = 0.08;
        for (var k = 0; k < silences.length; k++) {
          if (startSec >= silences[k].start - tol && endSec <= silences[k].end + tol) return true;
        }
        return false;
      }

      var delV = 0, delA = 0;
      for (var ti = seq.videoTracks.numTracks - 1; ti >= 0; ti--) {
        var track = seq.videoTracks[ti];
        for (var ci = track.clips.numItems - 1; ci >= 0; ci--) {
          var clip = track.clips[ci];
          if (isSilent(clip.start.seconds, clip.end.seconds)) {
            try { clip.remove(false, true); delV++; } catch (_) {}
          }
        }
      }
      for (var ti = seq.audioTracks.numTracks - 1; ti >= 0; ti--) {
        var track = seq.audioTracks[ti];
        for (var ci = track.clips.numItems - 1; ci >= 0; ci--) {
          var clip = track.clips[ci];
          if (isSilent(clip.start.seconds, clip.end.seconds)) {
            try { clip.remove(false, true); delA++; } catch (_) {}
          }
        }
      }

      var remaining = 0;
      if (seq.videoTracks.numTracks > 0) remaining = seq.videoTracks[0].clips.numItems;
      else if (seq.audioTracks.numTracks > 0) remaining = seq.audioTracks[0].clips.numItems;

      return JSON.stringify({
        success: true,
        razored: razored,
        razorErrors: razorErrors,
        deletedVideo: delV,
        deletedAudio: delA,
        remainingClips: remaining,
        finalDurationSec: seq.end.seconds
      });
    } catch (e) { return JSON.stringify({ success: false, error: String(e) }); }
  })();`;
}

function scriptImportAndCreateCaptionTrack(srtPath) {
  return `(function(){
    try {
      var seq = app.project.activeSequence;
      if (!seq) return JSON.stringify({ success: false, error: 'アクティブなシーケンスがありません' });
      var f = new File(${esc(srtPath)});
      if (!f.exists) return JSON.stringify({ success: false, error: 'SRTファイルが見つかりません: ' + ${esc(srtPath)} });

      function walk(parent, out) {
        for (var i = 0; i < parent.children.numItems; i++) {
          var c = parent.children[i];
          out.push(c);
          if (c.type === ProjectItemType.BIN) walk(c, out);
        }
      }
      var before = []; walk(app.project.rootItem, before);
      var ok = app.project.importFiles([${esc(srtPath)}], true, app.project.rootItem, false);
      if (!ok) return JSON.stringify({ success: false, error: 'PremiereがSRTのインポートを拒否しました' });
      var after = []; walk(app.project.rootItem, after);

      var newItem = null;
      for (var i = 0; i < after.length; i++) {
        var isNew = true;
        for (var j = 0; j < before.length; j++) {
          if (String(before[j].nodeId) === String(after[i].nodeId)) { isNew = false; break; }
        }
        if (isNew) { newItem = after[i]; break; }
      }
      if (!newItem) {
        for (var i = 0; i < after.length; i++) {
          if (after[i].name === f.name) { newItem = after[i]; break; }
        }
      }
      if (!newItem) return JSON.stringify({ success: false, error: 'インポートされたSRTのプロジェクト項目が見つかりません' });

      var created = seq.createCaptionTrack(newItem, 0);
      app.project.save();
      return JSON.stringify({ success: true, created: !!created, itemId: newItem.nodeId, itemName: newItem.name });
    } catch (e) { return JSON.stringify({ success: false, error: String(e) }); }
  })();`;
}

function scriptInsertMediaAtPlayhead(filePath, trackIndex) {
  return `(function(){
    try {
      var seq = app.project.activeSequence;
      if (!seq) return JSON.stringify({ success: false, error: 'アクティブなシーケンスがありません' });
      var f = new File(${esc(filePath)});
      if (!f.exists) return JSON.stringify({ success: false, error: 'ファイルが見つかりません: ' + ${esc(filePath)} });

      function walk(parent, out) {
        for (var i = 0; i < parent.children.numItems; i++) {
          var c = parent.children[i];
          out.push(c);
          if (c.type === ProjectItemType.BIN) walk(c, out);
        }
      }
      var before = []; walk(app.project.rootItem, before);
      var ok = app.project.importFiles([${esc(filePath)}], true, app.project.rootItem, false);
      if (!ok) return JSON.stringify({ success: false, error: 'Premiereがインポートを拒否しました' });
      var after = []; walk(app.project.rootItem, after);
      var newItem = null;
      for (var i = 0; i < after.length; i++) {
        var isNew = true;
        for (var j = 0; j < before.length; j++) {
          if (String(before[j].nodeId) === String(after[i].nodeId)) { isNew = false; break; }
        }
        if (isNew) { newItem = after[i]; break; }
      }
      if (!newItem) {
        for (var i = 0; i < after.length; i++) {
          if (after[i].name === f.name) { newItem = after[i]; break; }
        }
      }
      if (!newItem) return JSON.stringify({ success: false, error: 'インポートされた項目が見つかりません' });

      var trackIdx = ${trackIndex};
      if (trackIdx < 0 || trackIdx >= seq.videoTracks.numTracks) trackIdx = seq.videoTracks.numTracks - 1;
      var track = seq.videoTracks[trackIdx];
      var atTime = seq.getPlayerPosition();

      var inserted = false, method = '';
      try { inserted = track.insertClip(newItem, atTime); method = 'insertClip(Time)'; } catch (e1) {}
      if (!inserted) {
        try { inserted = track.insertClip(newItem, String(atTime.ticks)); method = 'insertClip(ticks)'; } catch (e2) {}
      }
      if (!inserted) {
        try { inserted = track.overwriteClip(newItem, atTime); method = 'overwriteClip(Time)'; } catch (e3) {}
      }
      app.project.save();
      return JSON.stringify({ success: !!inserted, inserted: !!inserted, method: method, itemName: newItem.name, trackIndex: trackIdx, atSeconds: atTime.seconds });
    } catch (e) { return JSON.stringify({ success: false, error: String(e) }); }
  })();`;
}

// ───────────────────────── ffmpeg / whisper ─────────────────────────

function runProcess(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, opts || {});
    let stdout = '', stderr = '';
    proc.stdout && proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr && proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(new Error(`${cmd} の起動に失敗: ${err.message}（PATHにインストールされていますか?）`)));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function detectSilenceInFile(mediaPath, thresholdDb, minDurSec) {
  const { code, stderr } = await runProcess('ffmpeg', [
    '-i', mediaPath,
    '-af', `silencedetect=noise=${thresholdDb}dB:d=${minDurSec}`,
    '-f', 'null', '-'
  ]);
  if (code === null) throw new Error('ffmpegの実行に失敗しました');
  const intervals = [];
  let pendingStart = null;
  const startRe = /silence_start:\s*([0-9.]+)/g;
  const endRe = /silence_end:\s*([0-9.]+)/g;
  const lines = stderr.split('\n');
  for (const line of lines) {
    const sm = /silence_start:\s*([0-9.]+)/.exec(line);
    if (sm) { pendingStart = parseFloat(sm[1]); continue; }
    const em = /silence_end:\s*([0-9.]+)/.exec(line);
    if (em && pendingStart !== null) {
      intervals.push({ start: pendingStart, end: parseFloat(em[1]) });
      pendingStart = null;
    }
  }
  return intervals;
}

async function transcribeFile(mediaPath, language, model, outDir) {
  ensureDir(outDir);
  const { code, stdout, stderr } = await runProcess('python3', [
    GENERATE_CAPTIONS_PY,
    '--input', mediaPath,
    '--output-dir', outDir,
    '--language', language || 'ja',
    '--model', model || 'small'
  ]);
  if (code !== 0) {
    throw new Error(`Whisperでの文字起こしに失敗しました: ${stderr || stdout}`);
  }
  const jsonPath = path.join(outDir, 'captions.json');
  if (!fs.existsSync(jsonPath)) throw new Error('captions.jsonが生成されませんでした');
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

// ───────────────────────── タイムライン時間へのマッピング ─────────────────────────

// track0の各クリップについて、そのソースメディアに対する区間リスト(sourceIntervals, {start,end,...})を
// クリップの [inPoint, outPoint] でトリミングし、シーケンス上の時間 (start + (t - inPoint)) に変換する。
function mapIntervalsToTimeline(clips, intervalsByPath, extraFields) {
  const out = [];
  for (const clip of clips) {
    if (!clip.mediaPath) continue;
    const list = intervalsByPath[clip.mediaPath];
    if (!list) continue;
    const offset = clip.start - clip.inPoint;
    for (const iv of list) {
      const s = Math.max(iv.start, clip.inPoint);
      const e = Math.min(iv.end, clip.outPoint);
      if (e <= s) continue;
      const entry = { start: s + offset, end: e + offset };
      if (extraFields) Object.assign(entry, extraFields(iv));
      out.push(entry);
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function mergeNearbyIntervals(intervals, mergeGapSec) {
  if (!intervals.length) return [];
  const sorted = intervals.slice().sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start - last.end <= mergeGapSec) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push(Object.assign({}, sorted[i]));
    }
  }
  return merged;
}

function uniqueMediaPaths(clips) {
  const set = new Set();
  for (const c of clips) if (c.mediaPath) set.add(c.mediaPath);
  return Array.from(set);
}

// ジャンプカットの3プリセット。
// minDurationSec: これ以上長い無音だけをカット対象にする(ffmpegのsilencedetect d=)
// residualSec: カット後にその無音区間から残す長さ(自然さ優先か、テンポ優先かの差)
const JUMP_CUT_PRESETS = {
  interview: { label: 'インタビュー・対談動画', minDurationSec: 0.5, residualSec: 0.2 },
  presentation: { label: 'プレゼンテーション・解説動画', minDurationSec: 0.3, residualSec: 0.1 },
  vlog: { label: 'Vlog・日常系動画', minDurationSec: 1.0, residualSec: 0.3 }
};

// ───────────────────────── ワークフロー ─────────────────────────

async function workflowJumpCut(opts) {
  const preset = opts.preset && JUMP_CUT_PRESETS[opts.preset] ? JUMP_CUT_PRESETS[opts.preset] : null;
  const thresholdDb = opts.thresholdDb != null ? opts.thresholdDb : -35;
  const minDurSec = opts.minDurationSec != null ? opts.minDurationSec : (preset ? preset.minDurationSec : 0.4);
  // 無音区間のうち、カットせず残す長さ(末尾側)。呼吸や次の発話前のタメを完全には消さない。
  const residualSec = opts.residualSec != null ? opts.residualSec : (preset ? preset.residualSec : 0.1);
  // 無音の先頭側に残す極小ハンドル。直前の発話の尻を切らないための保険(残す長さには含めない)。
  const leadHandleSec = opts.leadHandleSec != null ? opts.leadHandleSec : 0.03;
  const mergeGapSec = opts.mergeGapSec != null ? opts.mergeGapSec : 0.15;

  const info = await evalJSON(SCRIPT_GET_ACTIVE_SEQ_INFO);
  const audioTrack0 = (info.audio && info.audio[0] && info.audio[0].clips) || [];
  if (audioTrack0.length === 0) {
    throw new Error('オーディオトラック0(A1)にクリップがありません。無音検出の対象がありません。');
  }

  const dup = await evalJSON(scriptDuplicateAndActivate(`${info.name} - Jump Cuts`));
  if (!dup.activated) {
    throw new Error('シーケンスの複製には成功しましたが、複製側へ切り替えられませんでした。Premiere上で手動でタブを切り替えてから再実行してください。');
  }

  const dupInfo = await evalJSON(SCRIPT_GET_ACTIVE_SEQ_INFO);
  const clips = (dupInfo.audio && dupInfo.audio[0] && dupInfo.audio[0].clips) || [];

  const paths = uniqueMediaPaths(clips);
  if (paths.length === 0) throw new Error('A1クリップのメディアパスを取得できませんでした。');

  const intervalsByPath = {};
  for (const p of paths) {
    intervalsByPath[p] = await detectSilenceInFile(p, thresholdDb, minDurSec);
  }

  let timelineSilences = mapIntervalsToTimeline(clips, intervalsByPath);
  // 無音区間の末尾側に residualSec を残し、先頭側は leadHandleSec だけ避けてカットする。
  // 例: 0.5秒以上の無音を検出し、0.2秒だけ残す → カットするのは [start+0.03, end-0.2] の区間。
  timelineSilences = timelineSilences
    .map((iv) => ({ start: iv.start + leadHandleSec, end: iv.end - residualSec }))
    .filter((iv) => iv.end > iv.start);
  timelineSilences = mergeNearbyIntervals(timelineSilences, mergeGapSec);

  if (timelineSilences.length === 0) {
    return {
      success: true,
      message: '無音区間が見つかりませんでした(しきい値を調整すると検出できる場合があります)。',
      sequenceName: dupInfo.name,
      cuts: 0
    };
  }

  const result = await evalJSON(scriptApplyJumpCuts(timelineSilences));
  await evalJSON(SCRIPT_SAVE);

  return {
    success: true,
    sequenceName: dupInfo.name,
    preset: opts.preset || null,
    minDurationSec: minDurSec,
    residualSec: residualSec,
    cuts: timelineSilences.length,
    deletedVideoClips: result.deletedVideo,
    deletedAudioClips: result.deletedAudio,
    finalDurationSec: result.finalDurationSec
  };
}

function formatSrtTime(seconds) {
  let s = Math.max(0, seconds);
  let millis = Math.round((s - Math.floor(s)) * 1000);
  let total = Math.floor(s);
  if (millis === 1000) { total += 1; millis = 0; }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n, len) => String(n).padStart(len, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)},${pad(millis, 3)}`;
}

function stripPunctuation(text) {
  return text.replace(/[。、！？]/g, '');
}

function writeSrt(captions, outPath) {
  const lines = [];
  captions.forEach((c, i) => {
    lines.push(String(i + 1));
    lines.push(`${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}`);
    lines.push(stripPunctuation(c.text));
    lines.push('');
  });
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
}

async function workflowTelop(opts) {
  const language = opts.language || 'ja';
  const model = opts.model || 'small';

  const info = await evalJSON(SCRIPT_GET_ACTIVE_SEQ_INFO);
  const audioTrack0 = (info.audio && info.audio[0] && info.audio[0].clips) || [];
  if (audioTrack0.length === 0) {
    throw new Error('オーディオトラック0(A1)にクリップがありません。');
  }

  const dup = await evalJSON(scriptDuplicateAndActivate(`${info.name} - Telop`));
  if (!dup.activated) {
    throw new Error('シーケンスの複製には成功しましたが、複製側へ切り替えられませんでした。Premiere上で手動でタブを切り替えてから再実行してください。');
  }
  const dupInfo = await evalJSON(SCRIPT_GET_ACTIVE_SEQ_INFO);
  const clips = (dupInfo.audio && dupInfo.audio[0] && dupInfo.audio[0].clips) || [];

  const paths = uniqueMediaPaths(clips);
  if (paths.length === 0) throw new Error('A1クリップのメディアパスを取得できませんでした。');

  const jobDir = ensureDir(path.join(WORK_DIR, `telop-${Date.now()}`));
  const captionsByPath = {};
  for (const p of paths) {
    const outDir = ensureDir(path.join(jobDir, Buffer.from(p).toString('hex').slice(0, 24)));
    captionsByPath[p] = await transcribeFile(p, language, model, outDir);
  }

  const timelineCaptions = mapIntervalsToTimeline(clips, captionsByPath, (iv) => ({ text: iv.text }));
  if (timelineCaptions.length === 0) {
    return { success: true, message: '音声から文字を検出できませんでした。', sequenceName: dupInfo.name, captions: 0 };
  }

  const srtPath = path.join(jobDir, 'captions.srt');
  writeSrt(timelineCaptions, srtPath);

  const result = await evalJSON(scriptImportAndCreateCaptionTrack(srtPath));

  return {
    success: true,
    sequenceName: dupInfo.name,
    captions: timelineCaptions.length,
    srtPath: srtPath,
    captionTrackCreated: result.created,
    note: 'キャプションは既定スタイルで作成されました。文字色・縁取り・位置はPremiereの「キャプション」パネルで調整してください。'
  };
}

async function workflowInsertMedia(opts) {
  if (!opts.filePath) throw new Error('filePathが指定されていません');
  if (!fs.existsSync(opts.filePath)) throw new Error(`ファイルが見つかりません: ${opts.filePath}`);
  const trackIndex = opts.trackIndex != null ? opts.trackIndex : -1; // -1 = 最上段トラック
  const result = await evalJSON(scriptInsertMediaAtPlayhead(opts.filePath, trackIndex));
  return result;
}

async function checkHealth() {
  try {
    const info = await evalJSON(SCRIPT_GET_ACTIVE_SEQ_INFO, 8000);
    return { bridgeConnected: true, activeSequence: info.name || null };
  } catch (e) {
    return { bridgeConnected: false, error: e.message };
  }
}

// ───────────────────────── HTTP サーバー ─────────────────────────

function sendJSON(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('不正なJSONボディです')); }
    });
    req.on('error', reject);
  });
}

const ROUTES = {
  '/health': { method: 'GET', handler: async () => ({ ok: true, ...(await checkHealth()) }) },
  '/jump-cut': { method: 'POST', handler: (body) => workflowJumpCut(body || {}) },
  '/telop': { method: 'POST', handler: (body) => workflowTelop(body || {}) },
  '/insert-media': { method: 'POST', handler: (body) => workflowInsertMedia(body || {}) }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') { sendJSON(res, 204, {}); return; }

  const route = ROUTES[url.pathname];
  if (!route || route.method !== req.method) {
    sendJSON(res, 404, { error: 'Not found' });
    return;
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : null;
    const result = await route.handler(body);
    sendJSON(res, 200, result);
  } catch (e) {
    console.error(`[EditFlux] ${url.pathname} error:`, e.message);
    sendJSON(res, 500, { success: false, error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[EditFlux] automation-server listening on http://127.0.0.1:${PORT}`);
  console.log(`[EditFlux] bridge temp dir: ${TEMP_DIR}`);
});
