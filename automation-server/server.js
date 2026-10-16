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

// CEPパネル(panel.js)がこのサーバーをchild_processとして起動する際、環境変数は
// 渡していないため、APIキー等は同じディレクトリの.env(.gitignore対象)から読む。
// 依存を増やさないよう、npmのdotenvは使わず自前で簡易パースする。
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
})();

const PORT = process.env.EDITFLUX_PORT ? parseInt(process.env.EDITFLUX_PORT, 10) : 4747;
// os.tmpdir()はmacOSでは/var/folders/.../T(ユーザーごとのTMPDIR)を返し、/tmpとは別物。
// MCP Bridge (CEP)パネル側(bridge-cep.js)はWindows以外では常に素の'/tmp'を既定値として
// 監視しているため、ここも同じく固定の/tmpを使う(Windowsだけ%TEMP%に従う)。
const DEFAULT_TEMP_DIR = process.platform === 'win32'
  ? path.join(process.env.TEMP || process.env.TMP || 'C:\\Temp', 'premiere-mcp-bridge')
  : '/tmp/premiere-mcp-bridge';
const TEMP_DIR = process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR;
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

// QEシーケンス/トラックの取得は、見つかったように見えて実は違うシーケンス/トラックを
// 掴んでいることがある(qe.project.getActiveSequence()がDOM側のactiveSequenceと
// 食い違う等)、既知の難所。ここはadobe-premiere-pro-mcp本家(src/bridge/index.ts)が
// 実機(Premiere 26.0.2)で検証済みのロジックをそのまま流用する。
const QE_HELPERS = `
function __qeSequenceLookup(seq) {
  if (!seq) return null;
  var count = 0;
  try { count = qe.project.numSequences; } catch (eCount) { return null; }
  for (var qi = 0; qi < count; qi++) {
    try {
      var candidate = qe.project.getSequenceAt(qi);
      if (candidate && String(candidate.guid) === String(seq.sequenceID)) return candidate;
    } catch (eAt) {}
  }
  try {
    var activeCandidate = qe.project.getActiveSequence();
    if (activeCandidate && String(activeCandidate.guid) === String(seq.sequenceID)) return activeCandidate;
  } catch (eActive) {}
  return null;
}
function __activateSequenceForQE(seq) {
  if (!seq) return;
  try {
    if (typeof app.project.openSequence === "function") app.project.openSequence(seq.sequenceID);
  } catch (eOpen) {}
  try { app.project.activeSequence = seq; } catch (eSet) {}
  try { if (seq.openInTimeline) seq.openInTimeline(); } catch (eTL) {}
  try { if (typeof $ !== "undefined" && $.sleep) $.sleep(250); } catch (eSleep) {}
}
function __qeSequenceFor(seq) {
  if (!seq) return null;
  try { app.enableQE(); } catch (eEnable) { return null; }
  var found = __qeSequenceLookup(seq);
  if (found) return found;
  __activateSequenceForQE(seq);
  try { app.enableQE(); } catch (eEnable2) {}
  return __qeSequenceLookup(seq);
}
function __secondsToTimecode(seq, seconds) {
  var fps = seq.timebase ? (254016000000 / parseInt(seq.timebase, 10)) : 30;
  var totalFrames = Math.round(seconds * fps);
  var hours = Math.floor(totalFrames / (fps * 3600));
  var mins = Math.floor((totalFrames % (fps * 3600)) / (fps * 60));
  var secs = Math.floor((totalFrames % (fps * 60)) / fps);
  var frames = Math.round(totalFrames % fps);
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  return pad(hours) + ":" + pad(mins) + ":" + pad(secs) + ":" + pad(frames);
}
`;

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
  return `${QE_HELPERS}
  (function(){
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

      var qeSeq = __qeSequenceFor(seq);
      var razored = 0, razorErrors = 0;
      if (qeSeq) {
        for (var i = 0; i < cuts.length; i++) {
          var tc = __secondsToTimecode(seq, cuts[i]);
          for (var vti = 0; vti < seq.videoTracks.numTracks; vti++) {
            try {
              var qeVTrack = qeSeq.getVideoTrackAt(vti);
              if (qeVTrack) { qeVTrack.razor(tc); razored++; }
            } catch (e2) { razorErrors++; }
          }
          for (var ati = 0; ati < seq.audioTracks.numTracks; ati++) {
            try {
              var qeATrack = qeSeq.getAudioTrackAt(ati);
              if (qeATrack) { qeATrack.razor(tc); razored++; }
            } catch (e3) { razorErrors++; }
          }
        }
      } else {
        return JSON.stringify({ success: false, error: 'QEシーケンスを取得できませんでした(app.enableQEが使えない環境の可能性)' });
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
            try { clip.remove(true, true); delV++; } catch (_) {}
          }
        }
      }
      for (var ti = seq.audioTracks.numTracks - 1; ti >= 0; ti--) {
        var track = seq.audioTracks[ti];
        for (var ci = track.clips.numItems - 1; ci >= 0; ci--) {
          var clip = track.clips[ci];
          if (isSilent(clip.start.seconds, clip.end.seconds)) {
            try { clip.remove(true, true); delA++; } catch (_) {}
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

// qe.razor()は見た目上エラーを出さずに終わっても、実際にはクリップを分割しないことがある
// (環境依存の既知の問題)。その場合のフォールバック: 各トラックの元クリップを一旦すべて削除し、
// 無音を除いた「残す区間」だけをoverwriteClipで先頭から詰めて敷き直す。
// 前提: 各トラックに元のソースクリップが1本だけ乗っている状態(カット前の生素材)であること。
// 既に複数クリップに分かれているトラックでは、そのトラックの最初のクリップのメディアだけで
// 埋め直してしまうため正しく動作しない。
// テロップ用に、既存の映像トラックの上に専用トラックを1本追加する。既存の映像を
// 上書きしないため。
const SCRIPT_ADD_TOP_VIDEO_TRACK = `${QE_HELPERS}
(function(){
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: 'アクティブなシーケンスがありません' });
    var qeSeq = __qeSequenceFor(seq);
    if (!qeSeq) return JSON.stringify({ success: false, error: 'QEシーケンスを取得できませんでした' });
    var before = seq.videoTracks.numTracks;
    qeSeq.addTracks(1, before, 0, 1, 0, 0, 0);
    var after = seq.videoTracks.numTracks;
    if (after <= before) return JSON.stringify({ success: false, error: 'トラックの追加に失敗しました' });
    return JSON.stringify({ success: true, trackIndex: after - 1 });
  } catch (e) { return JSON.stringify({ success: false, error: String(e) }); }
})();`;

function scriptApplyJumpCutsReinsert(silenceRanges) {
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
      var allTracksForTps = [];
      for (var ti = 0; ti < seq.videoTracks.numTracks; ti++) allTracksForTps.push(seq.videoTracks[ti]);
      for (var ti = 0; ti < seq.audioTracks.numTracks; ti++) allTracksForTps.push(seq.audioTracks[ti]);
      if (tps <= 0) {
        for (var ti = 0; ti < allTracksForTps.length && tps <= 0; ti++) {
          var track = allTracksForTps[ti];
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
        for (var ti = 0; ti < allTracksForTps.length; ti++) {
          var track = allTracksForTps[ti];
          for (var ci = 0; ci < track.clips.numItems; ci++) {
            var cEnd = track.clips[ci].end.seconds;
            if (cEnd > durSecs) durSecs = cEnd;
          }
        }
      }
      if (!durSecs || durSecs <= 0) return JSON.stringify({ success: false, error: 'シーケンスの長さを特定できませんでした' });

      var silList = silences.slice().sort(function(a, b) { return a.start - b.start; });
      var merged = [];
      for (var i = 0; i < silList.length; i++) {
        var s = silList[i];
        if (merged.length && s.start <= merged[merged.length - 1].end) {
          if (s.end > merged[merged.length - 1].end) merged[merged.length - 1].end = s.end;
        } else {
          merged.push({ start: s.start, end: s.end });
        }
      }
      var keep = [];
      var cursor = 0;
      for (var i = 0; i < merged.length; i++) {
        if (merged[i].start > cursor) keep.push({ start: cursor, end: merged[i].start });
        cursor = Math.max(cursor, merged[i].end);
      }
      if (cursor < durSecs) keep.push({ start: cursor, end: durSecs });
      var keepFiltered = [];
      for (var i = 0; i < keep.length; i++) {
        if ((keep[i].end - keep[i].start) > 0.02) keepFiltered.push(keep[i]);
      }
      keep = keepFiltered;

      var origVideo = [];
      for (var ti = 0; ti < seq.videoTracks.numTracks; ti++) {
        var tV = seq.videoTracks[ti];
        origVideo.push(tV.clips.numItems > 0 ? { pi: tV.clips[0].projectItem, srcOffset: tV.clips[0].inPoint.seconds } : null);
      }
      var origAudio = [];
      for (var ti = 0; ti < seq.audioTracks.numTracks; ti++) {
        var tA = seq.audioTracks[ti];
        origAudio.push(tA.clips.numItems > 0 ? { pi: tA.clips[0].projectItem, srcOffset: tA.clips[0].inPoint.seconds } : null);
      }

      function insertKeepClips(track, pi, srcOffset) {
        var placed = 0, failed = 0;
        var posSec = 0;
        for (var i = 0; i < keep.length; i++) {
          var k = keep[i];
          var srcStart = srcOffset + k.start;
          var srcEnd = srcOffset + k.end;
          try {
            pi.setInPoint(srcStart, 4);
            pi.setOutPoint(srcEnd, 4);
            var posTicks = String(Math.round(posSec * tps));
            track.overwriteClip(pi, posTicks);
            placed++;
          } catch (e) { failed++; }
          posSec += (k.end - k.start);
        }
        return { placed: placed, failed: failed, total: keep.length };
      }

      function clearTrack(track) {
        var removed = 0;
        for (var ci = track.clips.numItems - 1; ci >= 0; ci--) {
          try { track.clips[ci].remove(false, true); removed++; } catch (_) {}
        }
        return removed;
      }

      for (var ti = 0; ti < seq.videoTracks.numTracks; ti++) clearTrack(seq.videoTracks[ti]);
      for (var ti = 0; ti < seq.audioTracks.numTracks; ti++) clearTrack(seq.audioTracks[ti]);

      var results = { video: [], audio: [] };
      for (var ti = 0; ti < seq.videoTracks.numTracks; ti++) {
        var oV = origVideo[ti];
        results.video.push(oV ? insertKeepClips(seq.videoTracks[ti], oV.pi, oV.srcOffset) : { skipped: true });
      }
      for (var ti = 0; ti < seq.audioTracks.numTracks; ti++) {
        var oA = origAudio[ti];
        results.audio.push(oA ? insertKeepClips(seq.audioTracks[ti], oA.pi, oA.srcOffset) : { skipped: true });
      }

      var strayRemoved = 0;
      for (var ti = 0; ti < seq.videoTracks.numTracks; ti++) {
        if (!origVideo[ti]) strayRemoved += clearTrack(seq.videoTracks[ti]);
      }
      for (var ti = 0; ti < seq.audioTracks.numTracks; ti++) {
        if (!origAudio[ti]) strayRemoved += clearTrack(seq.audioTracks[ti]);
      }

      return JSON.stringify({
        success: true,
        keepRegionCount: keep.length,
        results: results,
        strayRemoved: strayRemoved,
        finalDurationSec: seq.end.seconds
      });
    } catch (e) { return JSON.stringify({ success: false, error: String(e) }); }
  })();`;
}

// Premiereのスクリプトdomには「キャプションの中身を読む」公式APIが無い(read_sequence_captions
// 相当の機能がドキュメント化されていない)。そのため、.mogrtのテキスト読み書きで実績のある
// 「clip.components配下のテキストらしいプロパティを総当たりで探す」手法や、clip.name/
// clip.textなど可能性のあるプロパティを順番に試す、という防御的な方法しかない。
// 失敗してもエラーにはせず、読めたクリップ数と読めなかったクリップ数を返すので、
// 呼び出し側で「読めなかったので手動エクスポートに切り替えてください」と案内できるようにする。
function scriptReadNativeCaptions() {
  return `(function(){
    try {
      var seq = app.project.activeSequence;
      if (!seq) return JSON.stringify({ success: false, error: 'アクティブなシーケンスがありません' });
      if (!seq.captionTracks || seq.captionTracks.numTracks === 0) {
        return JSON.stringify({ success: false, error: 'キャプショントラックが見つかりません。先にPremiereの「文字起こし」でシーケンスを文字起こししてください。' });
      }
      var track = seq.captionTracks[0];
      var clips = [];
      var readableCount = 0;
      for (var i = 0; i < track.clips.numItems; i++) {
        var c = track.clips[i];
        var startSec = 0, endSec = 0;
        try { startSec = c.start.seconds; } catch (eS) {}
        try { endSec = c.end.seconds; } catch (eE) {}
        var text = null;
        try { if (typeof c.getText === 'function') { var t0 = c.getText(); if (t0) text = String(t0); } } catch (e1) {}
        if (!text) { try { if (c.text) text = String(c.text); } catch (e2) {} }
        if (!text) { try { if (c.name && String(c.name).length > 0) text = String(c.name); } catch (e3) {} }
        if (!text) {
          try {
            for (var ci = 0; ci < c.components.numItems; ci++) {
              var comp = c.components[ci];
              if (!comp.properties) continue;
              for (var pi = 0; pi < comp.properties.numItems; pi++) {
                var p = comp.properties[pi];
                var pv = null;
                try { pv = p.getValue(); } catch (ePv) {}
                var dn = String(p.displayName || '').toLowerCase();
                if (typeof pv === 'string' && pv.length > 0 && (dn.indexOf('text') >= 0 || dn.indexOf('source text') >= 0)) {
                  text = pv; break;
                }
              }
              if (text) break;
            }
          } catch (eComp) {}
        }
        if (text) readableCount++;
        clips.push({ start: startSec, end: endSec, text: text });
      }
      return JSON.stringify({
        success: true,
        trackCount: seq.captionTracks.numTracks,
        clipCount: clips.length,
        readableCount: readableCount,
        clips: clips
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

      // テロップ生成を複数回実行すると、既存のキャプショントラックを消さずに毎回新しく
      // 追加されてしまい、古い生成結果と新しい生成結果が画面上に同時に重なって表示される
      // (何行にも見える不具合の主因)。削除用のAPIはPremiereのスクリプトDOM上に正式公開
      // されていないため、存在し得るいくつかの方法を順にtry/catchで試す(どれも失敗しても
      // 処理自体は続行する。その場合は呼び出し元に警告を返す)。
      var removedOldTracks = 0;
      try {
        if (seq.captionTracks && seq.captionTracks.numTracks > 0) {
          for (var ci = seq.captionTracks.numTracks - 1; ci >= 0; ci--) {
            try {
              var ct = seq.captionTracks[ci];
              if (ct && typeof ct.deleteTrack === 'function') { ct.deleteTrack(); removedOldTracks++; }
              else if (ct && typeof ct.remove === 'function') { ct.remove(); removedOldTracks++; }
            } catch (eCt) {}
          }
        }
      } catch (eCaps) {}

      // フォーマット省略時(2引数呼び出し)はPremiereが608/708などの放送用キャプション形式を
      // 既定にすることがあり、その場合は固定文字グリッドでこちら側の改行を無視して
      // 再折り返しされてしまう(例: 2行のつもりが3行になる)。字幕用の自由形式を明示する。
      var created = seq.createCaptionTrack(newItem, 0, Sequence.CAPTION_FORMAT_SUBTITLE);
      app.project.save();
      var stillHasOldTracks = false;
      try { stillHasOldTracks = !!(seq.captionTracks && seq.captionTracks.numTracks > 1); } catch (eCheck) {}
      return JSON.stringify({
        success: true,
        created: !!created,
        itemId: newItem.nodeId,
        itemName: newItem.name,
        removedOldTracks: removedOldTracks,
        possibleDuplicateCaptionTracks: stillHasOldTracks
      });
    } catch (e) { return JSON.stringify({ success: false, error: String(e) }); }
  })();`;
}

// PremiereのExtendScriptには「文字からタイトルを作る」API自体が無いため、.mogrt(モーション
// グラフィックステンプレート)に文字を流し込む方式しか手段がない。MOGRTのテキストは
// 「4バイトのヘッダー + mTextParam構造のJSON」というPremiere内部フォーマットで保存されており、
// 単純にsetValue(文字列)しても描画に反映されない。このパース/書き換え戦略は
// adobe-premiere-pro-mcp本家のsrc/tools/domains/graphics.ts(add_text_overlay)が実機検証済みの
// もので、ここではそのロジックをテロップ用に簡略化して流用する。
function scriptImportMogrtWithText(mogrtPath, trackIndex, startSec, endSec, text) {
  return `(function(){
    try {
      var seq = app.project.activeSequence;
      if (!seq) return JSON.stringify({ success: false, error: 'アクティブなシーケンスがありません' });
      var timeTicks = String(Math.round(${startSec} * 254016000000));
      var trackItem = seq.importMGT(${esc(mogrtPath)}, timeTicks, ${trackIndex}, 0);
      if (!trackItem) return JSON.stringify({ success: false, error: 'MOGRTのインポートに失敗しました: ' + ${esc(mogrtPath)} });

      function looksLikeTextProperty(displayName, mpVal) {
        var dn = String(displayName || '').toLowerCase();
        if (dn.indexOf('source text') >= 0 || dn.indexOf('texto de origen') >= 0 || dn.indexOf('texte source') >= 0) return true;
        if (dn === 'text' || dn === 'title' || dn === 'subtitle' || dn === 'headline') return true;
        if (typeof mpVal === 'string' && (
            mpVal.indexOf('mTextString') >= 0 ||
            mpVal.indexOf('textEditValue') >= 0 ||
            mpVal.indexOf('mTextParam') >= 0)) return true;
        return false;
      }

      var textComps = [];
      try {
        var mgtComp = trackItem.getMGTComponent();
        if (mgtComp && mgtComp.properties) {
          for (var mi = 0; mi < mgtComp.properties.numItems; mi++) {
            var mp = mgtComp.properties[mi];
            var mpVal = null;
            try { mpVal = mp.getValue(); } catch (eMPv) {}
            if (looksLikeTextProperty(mp.displayName, mpVal)) {
              textComps.push({ prop: mp });
            }
          }
        }
      } catch (eMGTC) {}
      if (textComps.length === 0) {
        for (var ci = 0; ci < trackItem.components.numItems; ci++) {
          var c = trackItem.components[ci];
          var mn = (c.matchName !== undefined) ? String(c.matchName) : '';
          if (mn === 'AE.ADBE Text') {
            textComps.push({ prop: c.properties[0] });
          } else if (c.properties) {
            for (var pi = 0; pi < c.properties.numItems; pi++) {
              var p = c.properties[pi];
              var pVal = null;
              try { pVal = p.getValue(); } catch (ePv) {}
              if (looksLikeTextProperty(p.displayName, pVal)) textComps.push({ prop: p });
            }
          }
        }
      }
      if (textComps.length === 0) {
        return JSON.stringify({ success: false, error: 'MOGRT内にテキストプロパティが見つかりませんでした', clipId: trackItem.nodeId });
      }

      var sourceTextProp = textComps[0].prop;
      var newText = ${esc(text)};
      var ok = false, errorDetail = '';
      try {
        var rawValStr = String(sourceTextProp.getValue());
        var headerBytes = '', textObj = null;
        try {
          headerBytes = rawValStr.substring(0, 4);
          textObj = JSON.parse(rawValStr.substring(4));
        } catch (eP1) {
          try { textObj = JSON.parse(rawValStr); headerBytes = ''; } catch (eP2) {
            var brace = rawValStr.indexOf('{');
            if (brace >= 0) {
              try { headerBytes = rawValStr.substring(0, brace); textObj = JSON.parse(rawValStr.substring(brace)); } catch (eP3) { textObj = null; }
            }
          }
        }
        if (!textObj) {
          sourceTextProp.setValue(newText, true);
          var afterRaw = String(sourceTextProp.getValue());
          ok = afterRaw.indexOf(newText) >= 0;
          if (!ok) errorDetail = 'JSON解析に失敗し、文字列そのままの書き込みも反映されませんでした';
        } else {
          var mutated = false;
          if (textObj.mTextParam && textObj.mTextParam.mStyleSheet) { textObj.mTextParam.mStyleSheet.mText = newText; mutated = true; }
          if (textObj.textEditValue !== undefined) { textObj.textEditValue = newText; textObj.fontTextRunLength = [newText.length]; mutated = true; }
          if (textObj.mTextString !== undefined) { textObj.mTextString = newText; mutated = true; }
          if (!mutated) {
            errorDetail = 'JSONは解析できましたが、既知のテキストフィールドが見つかりませんでした';
          } else {
            var newRawVal = headerBytes + JSON.stringify(textObj);
            sourceTextProp.setValue(newRawVal, true);
            ok = true;
          }
        }
      } catch (eSet) { errorDetail = String(eSet); }

      // 尺をキャプションの長さに合わせてトリムする(MOGRTの既定の長さのままだと
      // 発話タイミングとズレるため)。失敗しても致命的ではないので握りつぶす。
      try {
        var endTime = new Time();
        endTime.seconds = ${endSec};
        trackItem.end = endTime;
      } catch (eTrim) {}

      return JSON.stringify({ success: ok, clipId: trackItem.nodeId, error: ok ? undefined : errorDetail });
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

// Premiere(GUIアプリ)経由で起動されるとPATHが最小構成(/usr/bin:/bin等)になり、
// Homebrewでインストールしたffmpeg/python3が見つからないことが多い。
// よくあるインストール先を直接探し、見つかればフルパスを使う。
const BINARY_SEARCH_PATHS = {
  ffmpeg: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
  python3: ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']
};
const _resolvedBinaryCache = {};
function resolveBinary(name) {
  if (_resolvedBinaryCache[name]) return _resolvedBinaryCache[name];
  const candidates = BINARY_SEARCH_PATHS[name] || [];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      _resolvedBinaryCache[name] = candidate;
      return candidate;
    }
  }
  _resolvedBinaryCache[name] = name; // PATHに期待してフォールバック
  return name;
}

// PremiereのGUI PATHで起動したこのプロセス自身はffmpeg/python3を絶対パスで解決できても、
// Whisperのように「内部でさらにffmpegをサブプロセスとして呼ぶ」ライブラリには効果がない
// (呼び出し元のPATH環境変数しか見ないため)。よくあるインストール先を明示的にPATHへ
// 前置きし、すべての子プロセス(とその孫プロセス)から見つかるようにする。
const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
const AUGMENTED_ENV = Object.assign({}, process.env, {
  PATH: EXTRA_PATH_DIRS.concat((process.env.PATH || '').split(path.delimiter)).join(path.delimiter)
});

function runProcess(cmd, args, opts) {
  const resolvedCmd = resolveBinary(cmd);
  const mergedOpts = Object.assign({}, opts, { env: Object.assign({}, AUGMENTED_ENV, opts && opts.env) });
  return new Promise((resolve, reject) => {
    const proc = spawn(resolvedCmd, args, mergedOpts);
    let stdout = '', stderr = '';
    proc.stdout && proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr && proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(new Error(`${resolvedCmd} の起動に失敗: ${err.message}（PATHにインストールされていますか?）`)));
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

async function transcribeFile(mediaPath, language, model, outDir, initialPrompt) {
  ensureDir(outDir);
  const args = [
    GENERATE_CAPTIONS_PY,
    '--input', mediaPath,
    '--output-dir', outDir,
    '--language', language || 'ja',
    '--model', model || 'small'
  ];
  // Whisperのinitial_promptに台本の冒頭を渡すと、固有名詞や専門用語の認識精度が上がりやすい
  // (トークンに上限があるため、長すぎる場合は冒頭だけを使う)。
  if (initialPrompt) args.push('--initial-prompt', initialPrompt.slice(0, 400));
  const { code, stdout, stderr } = await runProcess('python3', args);
  if (code !== 0) {
    const detail = (stderr || stdout || '').trim();
    throw new Error(`Whisperでの文字起こしに失敗しました (exit code ${code})${detail ? ': ' + detail : ' (出力なし)'}`);
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

// テロップ用フォントプリセットは、このフォルダに保存した.mogrtファイルを自動的に一覧化する。
// Premiereのエッセンシャルグラフィックスパネルで文字レイヤーに「マイスタイル」を適用して
// 書き出すとき、保存先をこのフォルダにするだけで(コードの変更なしに)パネルの選択肢に増える。
const TELOP_PRESETS_DIR = path.join(
  os.homedir(),
  'Library/Application Support/Adobe/Common/Motion Graphics Templates/EditFlux Telop'
);
ensureDir(TELOP_PRESETS_DIR);

function listTelopPresets() {
  let files = [];
  try {
    files = fs.readdirSync(TELOP_PRESETS_DIR).filter((f) => f.toLowerCase().endsWith('.mogrt'));
  } catch (_) {}
  return files.map((f) => {
    const label = f.replace(/\.mogrt$/i, '');
    return {
      key: label,
      label: label,
      mogrtPath: path.join(TELOP_PRESETS_DIR, f),
      thumbUrl: '/telop-presets/thumb?key=' + encodeURIComponent(label)
    };
  }).sort((a, b) => a.label.localeCompare(b.label, 'ja'));
}

// .mogrtファイルはZIPアーカイブで、Premiereのエッセンシャルグラフィックスが表示している
// のと同じプレビュー画像が thumb.png として同梱されている。unzip -p でそのまま取り出し、
// WORK_DIR内にキャッシュする(.mogrt自体が更新されたら再抽出)。
const THUMB_CACHE_DIR = ensureDir(path.join(WORK_DIR, 'telop-thumb-cache'));
async function extractThumbnail(mogrtPath) {
  const cacheKey = Buffer.from(mogrtPath).toString('hex').slice(0, 40) + '.png';
  const cachePath = path.join(THUMB_CACHE_DIR, cacheKey);
  const mogrtStat = fs.statSync(mogrtPath);
  if (fs.existsSync(cachePath)) {
    const cacheStat = fs.statSync(cachePath);
    if (cacheStat.mtimeMs >= mogrtStat.mtimeMs) return cachePath;
  }
  const { code, stdout } = await new Promise((resolve) => {
    const proc = spawn(resolveBinary('unzip'), ['-p', mogrtPath, 'thumb.png'], { env: AUGMENTED_ENV });
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('close', (c) => resolve({ code: c, stdout: Buffer.concat(chunks) }));
    proc.on('error', () => resolve({ code: 1, stdout: Buffer.alloc(0) }));
  });
  if (code !== 0 || stdout.length === 0) return null;
  fs.writeFileSync(cachePath, stdout);
  return cachePath;
}

function resolveTelopPreset(presetKey) {
  const presets = listTelopPresets();
  if (presets.length === 0) {
    throw new Error(
      `テロップ用の.mogrtが見つかりません。"${TELOP_PRESETS_DIR}" にエッセンシャルグラフィックスから書き出した.mogrtを保存してください。`
    );
  }
  const found = presetKey ? presets.find((p) => p.key === presetKey) : null;
  return found || presets[0];
}

const TELOP_MAX_CHARS_PER_LINE = 16;
const TELOP_MAX_LINES = 2;

// 句読点の直後、および助詞(は/が/を/に/で/と/も/の 等)の直後は文節の切れ目になりやすいため
// 改行候補として優先する。文字数だけで機械的に切るより読みやすい位置で折り返す。
const TELOP_PUNCT_BREAK = '。、！？,.!?　 ';
const TELOP_PARTICLE_BREAK = ['という', 'ので', 'けど', 'から', 'まで', 'より', 'だけ', 'など', 'って',
  'は', 'が', 'を', 'に', 'で', 'と', 'も', 'の', 'へ'];

// 文字列中の「ここで改行してよい」位置(その文字の直後)を、出現位置の昇順で返す。
// 句読点・助詞の直後を候補にする。
function findBreakPoints(s) {
  const points = new Set();
  for (let i = 0; i < s.length; i++) {
    if (TELOP_PUNCT_BREAK.indexOf(s[i]) >= 0) points.add(i + 1);
  }
  for (const particle of TELOP_PARTICLE_BREAK) {
    let from = 0;
    let idx;
    while ((idx = s.indexOf(particle, from)) >= 0) {
      points.add(idx + particle.length);
      from = idx + particle.length;
    }
  }
  return Array.from(points).sort((a, b) => a - b);
}

// 漢字はひらがな・カタカナより実際の描画幅が広いため、同じ文字数でも漢字が多い行ほど
// Premiere側で画面幅をはみ出しやすい(「2行で収まる時と3行になる時がある」というブレの主因)。
// 単純な文字数ではなく、漢字を少し重く数えた「見た目の幅」で折り返し位置を決める。
function charWeight(ch) {
  return /[一-鿿㐀-䶿]/.test(ch) ? 1.2 : 1;
}

// 1行maxCharsPerLine相当の幅・最大2行に収める。収まらない場合は複数のテロップカードに
// 分割する(文字を削って情報を失うより、カードを増やして尺を分け合う方を優先する)。
// maxCharsPerLineの実際に安全な値はシーケンスの解像度・キャプションのフォントサイズに
// 依存するため(例: 縦型/狭い解像度だと16文字でもPremiere側がさらに折り返してしまう)、
// 呼び出し側(パネルのUI)から調整できるようにしている。
// 戻り値: [{ text: '1〜2行(\\nで改行)', charCount: number }]
function wrapTelopText(text, maxCharsPerLine) {
  const maxChars = maxCharsPerLine && maxCharsPerLine > 0 ? maxCharsPerLine : TELOP_MAX_CHARS_PER_LINE;
  function wrapLine(s) {
    const lines = [];
    let rest = s;
    while (rest.length > 0) {
      let acc = 0;
      let fitIdx = 0;
      for (let i = 0; i < rest.length; i++) {
        acc += charWeight(rest[i]);
        if (acc <= maxChars) fitIdx = i + 1; else break;
      }
      if (fitIdx >= rest.length) { lines.push(rest); break; }
      if (fitIdx <= 0) fitIdx = 1; // 1文字も入らない極端なケースの保険
      const breakPoints = findBreakPoints(rest).filter((p) => p > 0 && p <= fitIdx);
      // 行の後半(幅の半分以降)にある最も右寄りの切れ目を優先。早すぎる位置で切って
      // 行が不自然に短くなるのを避ける。見つからなければ幅いっぱいで機械的に切る。
      const nearEnd = breakPoints.filter((p) => p >= Math.ceil(fitIdx / 2));
      let cut = nearEnd.length > 0 ? nearEnd[nearEnd.length - 1]
        : (breakPoints.length > 0 ? breakPoints[breakPoints.length - 1] : fitIdx);
      lines.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    return lines;
  }
  const allLines = wrapLine(text.trim());
  const cards = [];
  for (let i = 0; i < allLines.length; i += TELOP_MAX_LINES) {
    const chunk = allLines.slice(i, i + TELOP_MAX_LINES);
    cards.push({ text: chunk.join('\n'), lineCount: chunk.length });
  }
  return cards;
}

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
  const clips = (info.audio && info.audio[0] && info.audio[0].clips) || [];
  if (clips.length === 0) {
    throw new Error('オーディオトラック0(A1)にクリップがありません。無音検出の対象がありません。');
  }

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
      sequenceName: info.name,
      cuts: 0
    };
  }

  const razorResult = await evalJSON(scriptApplyJumpCuts(timelineSilences));
  if (razorResult.error) throw new Error(razorResult.error);

  const razorDeletedTotal = (razorResult.deletedVideo || 0) + (razorResult.deletedAudio || 0);
  let method = 'razor';
  let finalResult = razorResult;

  if (razorDeletedTotal === 0) {
    // qe.razor()が見た目上成功しても実際には分割していない環境向けのフォールバック。
    const reinsertResult = await evalJSON(scriptApplyJumpCutsReinsert(timelineSilences), 300000);
    if (reinsertResult.error) throw new Error(reinsertResult.error);
    method = 'reinsert';
    finalResult = reinsertResult;
  }

  await evalJSON(SCRIPT_SAVE);

  const base = {
    success: true,
    sequenceName: info.name,
    preset: opts.preset || null,
    minDurationSec: minDurSec,
    residualSec: residualSec,
    cuts: timelineSilences.length,
    method: method,
    finalDurationSec: finalResult.finalDurationSec
  };
  if (method === 'razor') {
    base.deletedVideoClips = finalResult.deletedVideo;
    base.deletedAudioClips = finalResult.deletedAudio;
  } else {
    base.keepRegions = finalResult.keepRegionCount;
  }
  return base;
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

// 句読点除去は呼び出し側で必要な場合だけ適用済みのテキストを渡す(手書きカードの場合は
// 原稿の表記をそのまま残したいため、ここでは一切加工しない)。
function writeSrt(captions, outPath) {
  const lines = [];
  captions.forEach((c, i) => {
    lines.push(String(i + 1));
    lines.push(`${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}`);
    lines.push(c.text);
    lines.push('');
  });
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
}

// シナリオ欄が「空行区切りのカード」形式で書かれているかを判定する。
// カード形式の場合、各カードの改行はユーザーが文節を考えて手で入れたものとして扱い、
// 自動改行(wrapTelopText)も句読点除去(stripPunctuation)も行わない。
// (自動改行は語の途中で割れることがあるため、手書きの改行をそのまま尊重する)
function parseScenarioCards(scenarioText) {
  const normalized = String(scenarioText).replace(/\r\n/g, '\n');
  const blocks = normalized.split(/\n\s*\n+/).map((b) => b.trim()).filter((b) => b.length > 0);
  return blocks.map((b) => ({
    text: b,
    lines: b.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  }));
}

// カードごとの重み付き文字数(漢字を1.2倍)の比率で、timelineの実時間(segmentsの合計時間)を
// 配分する。segments間の無音・カット区間はweight空間に含まれないため、字幕がカットの隙間に
// かからないようになる。
function distributeCardsAcrossSegments(cards, segments) {
  if (cards.length === 0 || segments.length === 0) return [];
  const totalDuration = segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  if (totalDuration <= 0) return [];

  function timeAtDuration(targetDuration) {
    let acc = 0;
    for (const seg of segments) {
      const dur = Math.max(0, seg.end - seg.start);
      if (acc + dur >= targetDuration) {
        return seg.start + Math.max(0, Math.min(dur, targetDuration - acc));
      }
      acc += dur;
    }
    return segments[segments.length - 1].end;
  }

  const weights = cards.map((c) => {
    let w = 0;
    for (const ch of c.text.replace(/\n/g, '')) w += charWeight(ch);
    return w || 1;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const result = [];
  let cumWeight = 0;
  let prevTime = segments[0].start;
  for (let i = 0; i < cards.length; i++) {
    cumWeight += weights[i];
    const isLast = i === cards.length - 1;
    const t = isLast ? segments[segments.length - 1].end : timeAtDuration(totalDuration * (cumWeight / totalWeight));
    const start = prevTime;
    const end = Math.max(start + 0.2, t);
    result.push({ start, end, text: cards[i].lines.join('\n') });
    prevTime = end;
  }
  return result;
}

// Whisperの文字起こし結果は脱字・誤認識が出やすいが、タイミング(各セグメントの開始/終了)は
// おおむね信頼できる。ユーザーが正確な台本(シナリオ)を貼り付けた場合は、認識テキストは使わず
// タイミングの枠だけ借りて、台本の文字を文字数×時間比で配分し直す。
// segments: タイムライン時間に変換済みの {start, end} の配列 (start昇順)。
function alignScriptToSegments(scriptText, segments) {
  const text = String(scriptText)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('');
  const totalChars = text.length;
  if (totalChars === 0 || segments.length === 0) return [];

  const totalDuration = segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  if (totalDuration <= 0) return [];

  const breakPoints = findBreakPoints(text);
  const chunks = [];
  let cursorChar = 0;
  let cumDuration = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    cumDuration += Math.max(0, seg.end - seg.start);
    const isLast = i === segments.length - 1;
    let targetChar = isLast ? totalChars : Math.round(totalChars * (cumDuration / totalDuration));
    if (!isLast) {
      let best = targetChar;
      let bestDist = Infinity;
      for (const bp of breakPoints) {
        if (bp <= cursorChar) continue;
        const d = Math.abs(bp - targetChar);
        if (d < bestDist) { bestDist = d; best = bp; }
      }
      targetChar = Math.max(cursorChar + 1, Math.min(best, totalChars - 1));
    }
    const chunkText = text.slice(cursorChar, targetChar).trim();
    if (chunkText.length > 0) chunks.push({ start: seg.start, end: seg.end, text: chunkText });
    cursorChar = targetChar;
  }
  return chunks;
}

// rawCaptions({start,end,text}の配列、タイムライン時間・start昇順)とシナリオ欄の内容から、
// 最終的なtimelineCaptionsを組み立てる。Whisper経由でも、Premiereのネイティブ文字起こし経由でも
// 同じ整形ロジック(自動改行 or 手書きカード)を使い回すための共通処理。
function buildTimelineCaptions(rawCaptions, scenarioText, maxCharsPerLine) {
  const hasManualCards = /\n[ \t]*\n/.test(scenarioText.replace(/\r\n/g, '\n'));
  let usedScenario = false;
  let manualCardMode = false;
  const cardWarnings = [];
  let timelineCaptions = [];
  let effectiveRawCaptions = rawCaptions;

  if (scenarioText.length > 0 && hasManualCards) {
    const cards = parseScenarioCards(scenarioText);
    const segments = rawCaptions.map((c) => ({ start: c.start, end: c.end }));
    const aligned = distributeCardsAcrossSegments(cards, segments);
    if (aligned.length > 0) {
      usedScenario = true;
      manualCardMode = true;
      timelineCaptions = aligned;
      cards.forEach((c, i) => {
        if (c.lines.length > 2) cardWarnings.push(`カード${i + 1}: 3行以上になっています`);
        c.lines.forEach((line) => {
          let w = 0;
          for (const ch of line) w += charWeight(ch);
          if (w > maxCharsPerLine) cardWarnings.push(`カード${i + 1}: 「${line}」が1行の目安(${maxCharsPerLine}文字相当)を超えています`);
        });
      });
    }
  } else if (scenarioText.length > 0) {
    const aligned = alignScriptToSegments(scenarioText, rawCaptions.map((c) => ({ start: c.start, end: c.end })));
    if (aligned.length > 0) {
      effectiveRawCaptions = aligned;
      usedScenario = true;
    }
  }

  if (!manualCardMode) {
    // キャプショントラックはMOGRTインポートより大幅に軽く、ユーザーが後で手動で
    // 「キャプションをグラフィックに変換」する前提の軽量出力として使う。
    // 1行maxCharsPerLine文字・最大2行に収まらないセグメントは、文字数に応じて尺を分け合う
    // 複数キャプションに展開する(句読点は除去)。
    for (const cap of effectiveRawCaptions) {
      const text = stripPunctuation(cap.text);
      const wrapped = wrapTelopText(text, maxCharsPerLine);
      if (wrapped.length === 0) continue;
      const totalChars = wrapped.reduce((sum, w) => sum + w.text.replace(/\n/g, '').length, 0) || 1;
      const duration = cap.end - cap.start;
      let cursor = cap.start;
      for (const w of wrapped) {
        const chars = w.text.replace(/\n/g, '').length;
        const share = duration * (chars / totalChars);
        const cardEnd = Math.min(cap.end, cursor + share);
        timelineCaptions.push({ text: w.text, start: cursor, end: Math.max(cardEnd, cursor + 0.2) });
        cursor = cardEnd;
      }
    }
  }

  return { timelineCaptions, usedScenario, manualCardMode, cardWarnings };
}

// 整形済みのtimelineCaptionsをSRTに書き出し、キャプショントラックとして再インポートする
// 最終ステップ。Whisper経由・ネイティブ文字起こし経由どちらの結果にも共通して使う。
async function finalizeCaptionImport(info, jobDir, built, maxCharsPerLine, extraNote) {
  const { timelineCaptions, usedScenario, manualCardMode, cardWarnings } = built;
  const srtPath = path.join(jobDir, 'captions.srt');
  writeSrt(timelineCaptions, srtPath);

  const result = await evalJSON(scriptImportAndCreateCaptionTrack(srtPath));
  await evalJSON(SCRIPT_SAVE);

  if (result.possibleDuplicateCaptionTracks) {
    cardWarnings.push(
      '古いキャプショントラックが残っている可能性があります。画面上に文字が何行も重なって見える場合は、' +
      'Premiereのタイムラインで古いキャプショントラックを手動で削除してから、もう一度生成し直してください。'
    );
  }

  return {
    success: true,
    sequenceName: info.name,
    captions: timelineCaptions.length,
    srtPath: srtPath,
    captionTrackCreated: result.created,
    removedOldTracks: result.removedOldTracks || 0,
    usedScenario: usedScenario,
    manualCardMode: manualCardMode,
    maxCharsPerLine: maxCharsPerLine,
    warnings: cardWarnings,
    note: manualCardMode
      ? 'カードごとの改行・表記をそのまま使い、音声のタイミングにだけ合わせました(自動改行・句読点除去なし)。'
      : usedScenario
        ? 'シナリオ本文を音声のタイミングに合わせて配置しました(認識テキストは使用していません)。必要ならPremiereの「キャプションをグラフィックに変換」でお好みのスタイルに変えてください。'
        : (extraNote || '既定のキャプションスタイルで追加されました。必要ならPremiereの「キャプションをグラフィックに変換」でお好みのスタイルに変えてください。')
  };
}

async function workflowTelop(opts) {
  const language = opts.language || 'ja';
  const model = opts.model || 'small';
  const scenarioText = opts.script ? String(opts.script).trim() : '';
  const maxCharsPerLine = opts.maxCharsPerLine && opts.maxCharsPerLine > 0 ? opts.maxCharsPerLine : TELOP_MAX_CHARS_PER_LINE;

  const info = await evalJSON(SCRIPT_GET_ACTIVE_SEQ_INFO);
  const clips = (info.audio && info.audio[0] && info.audio[0].clips) || [];
  if (clips.length === 0) {
    throw new Error('オーディオトラック0(A1)にクリップがありません。');
  }

  const paths = uniqueMediaPaths(clips);
  if (paths.length === 0) throw new Error('A1クリップのメディアパスを取得できませんでした。');

  const jobDir = ensureDir(path.join(WORK_DIR, `telop-${Date.now()}`));
  const captionsByPath = {};
  for (const p of paths) {
    const outDir = ensureDir(path.join(jobDir, Buffer.from(p).toString('hex').slice(0, 24)));
    captionsByPath[p] = await transcribeFile(p, language, model, outDir, scenarioText);
  }

  const rawCaptions = mapIntervalsToTimeline(clips, captionsByPath, (iv) => ({ text: iv.text }));
  if (rawCaptions.length === 0) {
    return { success: true, message: '音声から文字を検出できませんでした。', sequenceName: info.name, captions: 0 };
  }
  rawCaptions.sort((a, b) => a.start - b.start);

  const built = buildTimelineCaptions(rawCaptions, scenarioText, maxCharsPerLine);
  return finalizeCaptionImport(info, jobDir, built, maxCharsPerLine);
}

// Premiereの「文字起こし」(Transcribe Sequence)で作ったネイティブキャプションを読み取り、
// こちら側の改行ルール(自動 or 手書きカード)で整形し直して再インポートする。
// Whisper/ffmpegを使わず、SRTの手動書き出しも不要にするための経路。
// ただしPremiereにキャプションを読む公式APIが無いため、読み取りに失敗することがある
// (その場合はSRTを手動エクスポートしてもらうようエラーメッセージで案内する)。
async function workflowRefineNativeCaptions(opts) {
  const scenarioText = opts.script ? String(opts.script).trim() : '';
  const maxCharsPerLine = opts.maxCharsPerLine && opts.maxCharsPerLine > 0 ? opts.maxCharsPerLine : TELOP_MAX_CHARS_PER_LINE;

  const info = await evalJSON(SCRIPT_GET_ACTIVE_SEQ_INFO);
  const read = await evalJSON(scriptReadNativeCaptions());
  if (!read.success) {
    throw new Error(read.error || 'ネイティブキャプションの読み取りに失敗しました');
  }
  const rawCaptions = (read.clips || [])
    .filter((c) => c.text && String(c.text).trim().length > 0)
    .map((c) => ({ start: c.start, end: c.end, text: String(c.text).trim() }))
    .sort((a, b) => a.start - b.start);

  if (rawCaptions.length === 0) {
    throw new Error(
      `Premiereのキャプションの文字を読み取れませんでした(${read.clipCount || 0}個中0個)。` +
      'Premiereにはキャプションを読む公式な機能が無いため、この自動読み取りは環境によって失敗することがあります。' +
      'その場合はText(テキスト)パネルからSRTとして書き出し、シナリオ欄に貼り付ける方法をお試しください。'
    );
  }

  const jobDir = ensureDir(path.join(WORK_DIR, `telop-refine-${Date.now()}`));
  const built = buildTimelineCaptions(rawCaptions, scenarioText, maxCharsPerLine);
  const partial = read.readableCount < read.clipCount
    ? `(${read.clipCount}個中${read.readableCount}個のみ読み取れました。一部欠落している可能性があります)`
    : '';
  return finalizeCaptionImport(
    info, jobDir, built, maxCharsPerLine,
    `Premiereのネイティブ文字起こしを整形して再配置しました${partial}。`
  );
}

async function workflowInsertMedia(opts) {
  if (!opts.filePath) throw new Error('filePathが指定されていません');
  if (!fs.existsSync(opts.filePath)) throw new Error(`ファイルが見つかりません: ${opts.filePath}`);
  const trackIndex = opts.trackIndex != null ? opts.trackIndex : -1; // -1 = 最上段トラック
  const result = await evalJSON(scriptInsertMediaAtPlayhead(opts.filePath, trackIndex));
  return result;
}

// ───────────────────────── インサート(挟み込み)自動挿入 ─────────────────────────
//
// 「話している内容に合うB-roll素材を自動で見つけて挟み込む」機能。
// Claude(LLM)にその都度判定してもらう方式はAPIキー・実行コストが発生し、かつパネルの
// ボタンからは呼び出せない(ユーザーとの会話の中でしか動けない)ため不採用。
// 代わりに、素材フォルダ名(ユーザーが既に「悩む」「資格」等のテーマ別に整理済み)を
// タグとみなし、Whisperの文字起こし結果に含まれるキーワードでフォルダを選ぶ
// ルールベース方式にした(無料・オフラインで動く)。

const BROLL_ROOT = process.env.EDITFLUX_BROLL_ROOT
  || path.join(os.homedir(), 'Downloads', '広告動画作成素材', '広告素材');
const BROLL_VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v']);

// フォルダ名 → そのフォルダが合う内容を示すキーワード。文字起こしテキストに
// これらの単語が含まれていたら、そのフォルダをB-roll候補として加点する。
// 同じテーマのフォルダが複数ある場合(パソコン系・手元系など)は同じキーワード群を
// 共有させ、マッチ時にその中からランダムに1つ選ぶ。
const BROLL_KEYWORDS = {
  '笑顔': ['嬉しい', '楽しい', '幸せ', '喜び', 'よかった', '笑'],
  '悩む': ['悩み', '悩ん', '困った', '困って', '迷っ', '不安', '心配', 'つらい', '苦し'],
  '忙しい': ['忙し', '大変', '多忙', '時間がない'],
  '驚く': ['驚', 'びっくり', 'まさか', '信じられ'],
  '怒る': ['怒', '腹が立', 'イライラ', 'ムカ'],
  '退屈・面倒': ['退屈', '面倒', 'だるい', 'やる気が出ない'],
  '風邪': ['風邪', '体調不良', '熱が', '咳'],
  'パソコン・手元': ['パソコン', 'PC', '入力', 'タイピング', '作業'],
  'パソコン・人': ['パソコン', 'PC', '入力', 'タイピング', '作業'],
  '手元（+もの）': ['パソコン', '作業', '手元'],
  '手だけ': ['パソコン', '作業', '手元'],
  'スポーツ': ['スポーツ', '運動', 'トレーニング', '筋トレ'],
  'セミナー・Zoom': ['セミナー', 'Zoom', 'オンライン講座', '講座', '勉強会'],
  'オフィス＋会議＋話す': ['会議', '打ち合わせ', 'オフィス', '話し合い', '相談'],
  '子育て＋子供＋家族': ['子育て', '子供', '子ども', '家族', '育児'],
  '言い合い': ['言い合い', '口論', '喧嘩', '反論'],
  '占い師': ['占い', '占い師', '運勢', 'タロット'],
  '不動産': ['不動産', '大家', '賃貸', '物件', '家賃'],
  '治療家＋医療系＋介護': ['治療', '医療', '病院', '介護', '施術', '整体'],
  '美容＋ジムサロン': ['美容', 'ジム', 'サロン', 'エステ', 'ダイエット'],
  '料理': ['料理', '食べ', 'レシピ', '食事'],
  '歯': ['歯医者', '歯科'],
  '50代リストラ系': ['50代', '60代', '定年', 'リストラ', '早期退職', '会社を辞め'],
  'AI': ['AI', '人工知能', 'チャットGPT', '自動化'],
  '本・ノート': ['勉強', 'ノート', '学ん', '学び', '読書'],
  '電卓': ['計算', '電卓', '収支'],
  'お金ゼロ': ['ゼロ円', 'お金がない', '売上ゼロ', '収入ゼロ', '売上は、ゼロ'],
  'SNS': ['SNS', 'インスタ', 'ツイッター', '発信'],
  '時計': ['時間', '締め切り', '期限'],
  '資格': ['資格', '検定', '免許', 'キャリアコンサルタント'],
  '服': ['ファッション', '着替え'],
  '涙': ['涙', '泣', '悲し'],
  'チャンネル登録': ['チャンネル登録', 'フォロー', '高評価'],
  '分析': ['分析', 'データ', 'グラフ'],
  '着物': ['着物', '和服'],
  '運転': ['運転', 'ドライブ'],
  '戦争': ['戦争', '争い'],
  '農家': ['農家', '農業', '畑'],
  '女性': ['彼女', '主婦'],
  '男性': ['彼は', '父親'],
  '結婚': ['結婚', '夫婦', '離婚'],
  '景色': ['景色', '風景', '自然'],
  '背景+挿絵＋❔': ['疑問', 'わからない'],
  '地図': ['地図', 'エリア', '地域'],
  '旅行': ['旅行', '観光'],
};

function listBrollFolders() {
  if (!fs.existsSync(BROLL_ROOT)) return [];
  return fs.readdirSync(BROLL_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function listBrollFiles(folderName) {
  const dir = path.join(BROLL_ROOT, folderName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => BROLL_VIDEO_EXT.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(dir, f));
}

// テキストにマッチするフォルダ候補を、マッチしたキーワード数が多い順に返す。
// 実在する(=ファイルが1本以上ある)フォルダのみを対象にする。
function matchBrollFolders(text, existingFolders) {
  const scores = [];
  for (const [folder, keywords] of Object.entries(BROLL_KEYWORDS)) {
    if (!existingFolders.has(folder)) continue;
    let score = 0;
    for (const kw of keywords) {
      if (text.indexOf(kw) >= 0) score++;
    }
    if (score > 0) scores.push({ folder, score });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

// 無音カットと同じ考え方で、Whisperのセグメント開始〜次のセグメント開始までを
// 「文の頭から次の文の頭まで」の1テイクとみなす(ユーザーの編集ガイドライン通り)。
// 7秒を超えるテイクは2本に分割する。
function buildBrollTakes(rawCaptions) {
  const takes = [];
  for (let i = 0; i < rawCaptions.length; i++) {
    const cur = rawCaptions[i];
    const next = rawCaptions[i + 1];
    const takeEnd = next ? next.start : cur.end;
    if (takeEnd <= cur.start) continue;
    const duration = takeEnd - cur.start;
    if (duration > 7) {
      const mid = cur.start + duration / 2;
      takes.push({ start: cur.start, end: mid, text: cur.text });
      takes.push({ start: mid, end: takeEnd, text: cur.text });
    } else {
      takes.push({ start: cur.start, end: takeEnd, text: cur.text });
    }
  }
  return takes;
}

// Gemini(Google AI Studio、無料枠あり)に、セリフ一覧と候補フォルダ名を渡して
// 各セリフに最も合うフォルダを判定してもらう。キーワード辞書より言い回しの揺れに強い。
// GEMINI_API_KEYが未設定、またはAPI呼び出しに失敗した場合はnullを返し、
// 呼び出し側でキーワード辞書方式にフォールバックする。
async function geminiMatchTakes(takes, folderNames) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const items = takes.map((t, i) => `${i}: ${t.text}`).join('\n');
  const prompt = '以下は動画のセリフを時系列順に並べたものです。各セリフの内容に最も合う「挿し込み動画(B-roll)」の' +
    'フォルダ名を、次の候補から1つ選んでください。合う候補が無ければfolderをnullにしてください。\n\n' +
    `候補フォルダ: ${folderNames.join('、')}\n\n` +
    `セリフ一覧:\n${items}\n\n` +
    `出力はJSON配列で、インデックス順にちょうど${takes.length}個の要素を返してください。` +
    '各要素は {"folder": string|null, "score": number(0〜1の確信度)} の形式にしてください。';

  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      })
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini APIエラー (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;
  if (!text) throw new Error('Geminiから有効な応答がありませんでした');
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    throw new Error('Geminiの応答がJSONとして解析できませんでした: ' + text.slice(0, 200));
  }
  if (!Array.isArray(parsed)) throw new Error('Geminiの応答が配列ではありません');
  return parsed;
}

// takes(候補)の中からマッチしたものだけを残し、合計尺が動画全体の
// 30〜40%(目安35%)に収まるよう、マッチ度の高い順に採用していく。
// Gemini APIキーがあればそちらを優先し、無ければ/失敗すればキーワード辞書方式を使う。
async function buildBrollPlan(rawCaptions, totalDurationSec, opts) {
  opts = opts || {};
  const fullCoverage = !!opts.fullCoverage;
  const existingFolders = new Set(
    listBrollFolders().filter((f) => listBrollFiles(f).length > 0)
  );
  const takes = buildBrollTakes(rawCaptions);

  let matchSource = 'keyword';
  let geminiResults = null;
  let geminiError = null;
  if (process.env.GEMINI_API_KEY) {
    try {
      geminiResults = await geminiMatchTakes(takes, Array.from(existingFolders));
      if (geminiResults) matchSource = 'gemini';
    } catch (e) {
      geminiError = e.message;
    }
  }

  const candidates = [];
  takes.forEach((take, i) => {
    let folder = null;
    let score = 0;
    const g = geminiResults && geminiResults[i];
    if (g && g.folder && existingFolders.has(g.folder)) {
      folder = g.folder;
      score = typeof g.score === 'number' ? g.score : 0.5;
    } else if (!geminiResults) {
      const matches = matchBrollFolders(take.text, existingFolders);
      if (matches.length > 0) { folder = matches[0].folder; score = matches[0].score; }
    }
    if (folder) candidates.push({ start: take.start, end: take.end, duration: take.end - take.start, folder, score });
  });
  candidates.sort((a, b) => b.score - a.score || b.duration - a.duration);

  // fullCoverage: マッチした箇所を全部採用する(30〜40%ルールを使わない)。
  // 既定(false)は編集ガイドライン通り、動画全体の30〜40%(目安35%)に収める。
  let selected;
  let usedDuration;
  if (fullCoverage) {
    selected = candidates;
    usedDuration = candidates.reduce((sum, c) => sum + c.duration, 0);
  } else {
    const targetDuration = totalDurationSec * 0.35;
    const maxDuration = totalDurationSec * 0.4;
    selected = [];
    usedDuration = 0;
    for (const c of candidates) {
      if (usedDuration + c.duration > maxDuration) continue;
      selected.push(c);
      usedDuration += c.duration;
      if (usedDuration >= targetDuration) break;
    }
  }
  selected.sort((a, b) => a.start - b.start);

  // 同じフォルダから連続で同じファイルを選ばないよう、フォルダごとに直近使ったファイルを覚えておく
  const lastUsedByFolder = {};
  const plan = selected.map((c) => {
    const files = listBrollFiles(c.folder);
    let pick = files[Math.floor(Math.random() * files.length)];
    if (files.length > 1 && pick === lastUsedByFolder[c.folder]) {
      pick = files[(files.indexOf(pick) + 1) % files.length];
    }
    lastUsedByFolder[c.folder] = pick;
    return { start: c.start, end: c.end, duration: c.duration, folder: c.folder, filePath: pick };
  });

  return {
    plan,
    coverageRatio: totalDurationSec > 0 ? usedDuration / totalDurationSec : 0,
    matchSource,
    geminiError
  };
}

// 1本の新規ビデオトラックを最上段に追加し、plan内の各クリップをそのトラックの
// 指定時刻に配置して指定尺にトリムする。同じファイルを複数回使う場合はインポートを
// 使い回す(importFilesを毎回呼ぶと重複登録されるため、パス→projectItemのキャッシュを
// スクリプト内で保持する)。
function scriptInsertBrollPlan(plan) {
  const planJSON = JSON.stringify(plan.map((p) => ({ filePath: p.filePath, start: p.start, duration: p.duration })));
  return `${QE_HELPERS}
(function(){
    try {
      var items = ${planJSON};
      var seq = app.project.activeSequence;
      if (!seq) return JSON.stringify({ success: false, error: 'アクティブなシーケンスがありません' });

      var qeSeq = __qeSequenceFor(seq);
      var beforeTracks = seq.videoTracks.numTracks;
      if (qeSeq) { try { qeSeq.addTracks(1, beforeTracks, 0, 1, 0, 0, 0); } catch (eAdd) {} }
      var trackIdx = seq.videoTracks.numTracks > beforeTracks ? seq.videoTracks.numTracks - 1 : beforeTracks - 1;
      var track = seq.videoTracks[trackIdx];

      function walk(parent, out) {
        for (var i = 0; i < parent.children.numItems; i++) {
          var c = parent.children[i];
          out.push(c);
          if (c.type === ProjectItemType.BIN) walk(c, out);
        }
      }

      var itemCache = {};
      var insertedCount = 0;
      var errors = [];

      for (var idx = 0; idx < items.length; idx++) {
        var it = items[idx];
        try {
          var projItem = itemCache[it.filePath];
          if (!projItem) {
            var before = []; walk(app.project.rootItem, before);
            var ok = app.project.importFiles([it.filePath], true, app.project.rootItem, false);
            if (!ok) { errors.push(it.filePath + ': インポート失敗'); continue; }
            var after = []; walk(app.project.rootItem, after);
            for (var i = 0; i < after.length; i++) {
              var isNew = true;
              for (var j = 0; j < before.length; j++) {
                if (String(before[j].nodeId) === String(after[i].nodeId)) { isNew = false; break; }
              }
              if (isNew) { projItem = after[i]; break; }
            }
            if (!projItem) continue;
            itemCache[it.filePath] = projItem;
          }

          var atTime = new Time();
          atTime.seconds = it.start;
          var inserted = false;
          try { inserted = track.overwriteClip(projItem, atTime); } catch (eOv) {}
          if (!inserted) { try { inserted = track.insertClip(projItem, atTime); } catch (eIn) {} }
          if (inserted) {
            insertedCount++;
            try {
              var newClip = track.clips[track.clips.numItems - 1];
              var endTime = new Time();
              endTime.seconds = it.start + it.duration;
              newClip.end = endTime;
            } catch (eTrim) {}
          } else {
            errors.push(it.filePath + ': 配置失敗');
          }
        } catch (eItem) { errors.push(it.filePath + ': ' + String(eItem)); }
      }

      app.project.save();
      return JSON.stringify({ success: true, insertedCount: insertedCount, trackIndex: trackIdx, errors: errors });
    } catch (e) { return JSON.stringify({ success: false, error: String(e) }); }
})();`;
}

async function workflowInsertBroll(opts) {
  if (!fs.existsSync(BROLL_ROOT)) {
    throw new Error(`素材フォルダが見つかりません: ${BROLL_ROOT}`);
  }
  const language = opts.language || 'ja';
  const model = opts.model || 'small';

  const info = await evalJSON(SCRIPT_GET_ACTIVE_SEQ_INFO);
  const clips = (info.audio && info.audio[0] && info.audio[0].clips) || [];
  if (clips.length === 0) {
    throw new Error('オーディオトラック0(A1)にクリップがありません。');
  }
  const paths = uniqueMediaPaths(clips);
  if (paths.length === 0) throw new Error('A1クリップのメディアパスを取得できませんでした。');

  const jobDir = ensureDir(path.join(WORK_DIR, `broll-${Date.now()}`));
  const captionsByPath = {};
  for (const p of paths) {
    const outDir = ensureDir(path.join(jobDir, Buffer.from(p).toString('hex').slice(0, 24)));
    captionsByPath[p] = await transcribeFile(p, language, model, outDir);
  }

  const rawCaptions = mapIntervalsToTimeline(clips, captionsByPath, (iv) => ({ text: iv.text }));
  if (rawCaptions.length === 0) {
    return { success: true, message: '音声から文字を検出できませんでした。', sequenceName: info.name, inserted: 0 };
  }
  rawCaptions.sort((a, b) => a.start - b.start);

  const totalDurationSec = info.durationSec || rawCaptions[rawCaptions.length - 1].end;
  const { plan, coverageRatio, matchSource, geminiError } = await buildBrollPlan(rawCaptions, totalDurationSec, { fullCoverage: !!opts.fullCoverage });
  if (plan.length === 0) {
    return { success: true, message: '合致する箇所が見つかりませんでした。素材フォルダか判定方法を見直してください。', sequenceName: info.name, inserted: 0, matchSource, geminiError };
  }

  const result = await evalJSON(scriptInsertBrollPlan(plan));

  return {
    success: true,
    sequenceName: info.name,
    inserted: result.insertedCount || 0,
    planned: plan.length,
    coveragePercent: Math.round(coverageRatio * 1000) / 10,
    folders: plan.map((p) => p.folder),
    trackIndex: result.trackIndex,
    errors: result.errors || [],
    matchSource: matchSource,
    geminiError: geminiError
  };
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
  '/telop-refine': { method: 'POST', handler: (body) => workflowRefineNativeCaptions(body || {}) },
  '/insert-media': { method: 'POST', handler: (body) => workflowInsertMedia(body || {}) },
  '/insert-broll': { method: 'POST', handler: (body) => workflowInsertBroll(body || {}) },
  '/telop-presets': { method: 'GET', handler: async () => ({ presets: listTelopPresets(), dir: TELOP_PRESETS_DIR }) }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') { sendJSON(res, 204, {}); return; }

  if (url.pathname === '/telop-presets/thumb' && req.method === 'GET') {
    try {
      const key = url.searchParams.get('key');
      const preset = listTelopPresets().find((p) => p.key === key);
      if (!preset) { sendJSON(res, 404, { error: 'preset not found' }); return; }
      const thumbPath = await extractThumbnail(preset.mogrtPath);
      if (!thumbPath) { sendJSON(res, 404, { error: 'thumbnail not found in mogrt' }); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(thumbPath).pipe(res);
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // 既に同じポートでサーバーが動いている(多くは古いコードのまま残っているプロセス)。
    // 黙って落ちると「起動ボタンを押しても古い挙動のまま」という分かりにくい状態になるため、
    // はっきり分かるメッセージを残して終了する。利用者には既存プロセスの停止 or Premiere再起動を促す。
    console.error(
      `[EditFlux] ポート${PORT}は既に使用中です。古いautomation-serverプロセスが残っている可能性があります。` +
      `Premiere Proを完全に終了(Cmd+Q)してから再起動するか、\`lsof -i :${PORT}\`で該当プロセスを確認して終了してください。`
    );
    process.exit(1);
  }
  console.error('[EditFlux] サーバーエラー:', err);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[EditFlux] automation-server listening on http://127.0.0.1:${PORT}`);
  console.log(`[EditFlux] bridge temp dir: ${TEMP_DIR}`);
});
