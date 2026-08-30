/**
 * The page you talk to the agent from.
 *
 * One file, no build step, no framework — it is served by `local-session.ts` off a laptop and has
 * to work when nothing else is running. The dashboard Simulator (`dashboard/src/pages/Simulator.tsx`)
 * is the same idea for tenants; this is the developer-loop version, and it exists because that page
 * lives in another workstream's territory and cannot tell you WHICH agent answered.
 *
 * The one thing this page must never do is let you tune a laptop while talking to production. So
 * the answering worker's `lk.agent.name` is read off the participant and shown in a banner that is
 * GREEN only when it is the worker you asked for, and RED when it is empty — which on this project
 * means the deployed cloud agent. Nothing else on the page is as important as that banner.
 */

export interface LocalSessionPageConfig {
  /** `lk.agent.name` the answering agent must report for this session to be the local one. */
  expectAgentName: string;
  /** 'explicit' (a named local worker) or 'auto' (whatever LiveKit picks — production). */
  mode: 'auto' | 'explicit';
  /** Tenant whose settings/tools the agent will resolve. */
  tenantId: string;
  /** Human sentence describing the dispatch, straight from `resolveWebCallDispatch`. */
  note: string;
  /** Where the cached livekit-client UMD bundle is served from. */
  clientSrc: string;
}

const esc = (s: string): string =>
  s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

export function renderLocalSessionPage(cfg: LocalSessionPageConfig): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>שיחה עם הסוכן המקומי</title>
<style>
  :root { --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2; --acc:#3b82f6;
          --ok:#1f7a4d; --okline:#2fae70; --bad:#7a2020; --badline:#e05656; --warn:#7a4a2a; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }
  main { max-width:820px; margin:0 auto; padding:24px 20px 60px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:var(--dim); font-size:14px; margin:0 0 18px; line-height:1.6; }
  .banner { border-radius:12px; padding:14px 18px; margin:0 0 18px; font-size:16px; line-height:1.5;
            border:1px solid var(--line); background:var(--card); }
  .banner.ok { background:#0f2318; border-color:var(--okline); }
  .banner.bad { background:#241010; border-color:var(--badline); }
  .banner.wait { background:#20160f; border-color:var(--warn); }
  .banner b { font-size:18px; }
  .mono { font-family:monospace; font-size:13px; color:var(--dim); }
  .stage { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px;
           display:flex; flex-direction:column; align-items:center; gap:18px; }
  .orb { inline-size:120px; block-size:120px; border-radius:50%; background:var(--acc);
         transform:scale(1); transition:transform 90ms linear, background .2s; }
  .orb.idle { background:#2a3140; }
  .state { font-size:17px; font-weight:600; }
  .row { display:flex; gap:10px; flex-wrap:wrap; justify-content:center; }
  button { background:var(--acc); border:0; color:#fff; border-radius:10px; padding:12px 22px;
           font-size:15px; cursor:pointer; }
  button.ghost { background:#232a36; }
  button:disabled { opacity:.45; cursor:default; }
  #log { margin-top:18px; background:var(--card); border:1px solid var(--line); border-radius:12px;
         padding:14px 18px; min-height:120px; max-height:420px; overflow-y:auto; }
  .line { margin:8px 0; font-size:15px; line-height:1.5; }
  .line .who { font-family:monospace; font-size:12px; color:var(--dim); margin-inline-end:8px; }
  .line.user { color:#9fc6ff; }
  .line.sys { color:var(--dim); font-size:13px; }
  .err { color:#ffb4b4; }
</style>
</head>
<body>
<main>
  <h1>שיחה עם הסוכן שרץ על המחשב שלך</h1>
  <p class="sub">
    זו שיחה אמיתית — מיקרופון, הקשבה, מודל, קול. כל מה שקורה בשיחת טלפון חוץ מהקו עצמו.<br>
    שינית פרומפט או הגדרה? עצור את <span class="mono">npm run voice:dev</span>, הפעל מחדש, ולחץ כאן שוב. בלי דיפלוי.
  </p>

  <div id="banner" class="banner wait">
    <b>עוד לא התחלנו.</b><br>
    אמור לענות: <span class="mono">${esc(cfg.expectAgentName || '(ברירת מחדל — הסוכן בענן)')}</span>
    · <span class="mono">${esc(cfg.note)}</span>
  </div>

  <div class="stage">
    <div id="orb" class="orb idle"></div>
    <div id="state" class="state">מוכן</div>
    <div class="row">
      <button id="start">התחל שיחה</button>
      <button id="mute" class="ghost" disabled>השתק מיקרופון</button>
      <button id="hang" class="ghost" disabled>נתק</button>
      <button id="unlock" class="ghost" style="display:none">הפעל שמע</button>
    </div>
    <div class="mono" id="meta">tenant ${esc(cfg.tenantId)}</div>
  </div>

  <div id="log"><div class="line sys">התמלול של השיחה יופיע כאן.</div></div>
  <div id="audio"></div>
</main>

<script src="${esc(cfg.clientSrc)}"></script>
<script>
(function () {
  var CFG = ${JSON.stringify(cfg)};
  var AGENT_NAME_ATTR = 'lk.agent.name';
  var LK = window.LivekitClient;
  var banner = document.getElementById('banner');
  var stateEl = document.getElementById('state');
  var orb = document.getElementById('orb');
  var logEl = document.getElementById('log');
  var audioBox = document.getElementById('audio');
  var startBtn = document.getElementById('start');
  var muteBtn = document.getElementById('mute');
  var hangBtn = document.getElementById('hang');
  var unlockBtn = document.getElementById('unlock');
  var room = null, ctx = null, raf = 0, timer = null, startedAt = 0, muted = false, answered = false;

  if (!LK) {
    banner.className = 'banner bad';
    banner.innerHTML = '<b>ספריית LiveKit לא נטענה.</b><br>' +
      '<span class="mono">' + CFG.clientSrc + '</span> לא זמין. הרץ את הסקריפט פעם אחת עם אינטרנט כדי לשמור אותה במטמון.';
    startBtn.disabled = true;
    return;
  }

  function say(role, text, id) {
    var el = id ? document.querySelector('[data-seg="' + id + '"]') : null;
    if (!el) {
      el = document.createElement('div');
      el.className = 'line ' + role;
      if (id) el.setAttribute('data-seg', id);
      el.innerHTML = '<span class="who">' + (role === 'user' ? 'אתה' : role === 'agent' ? 'היא' : '—') + '</span><span class="t"></span>';
      logEl.appendChild(el);
    }
    el.querySelector('.t').textContent = text;
    logEl.scrollTop = logEl.scrollHeight;
  }

  /** THE WHOLE POINT: name the worker that actually answered, and shout if it is production. */
  function judgeAgent(name) {
    answered = true;
    if (CFG.mode === 'explicit' && name === CFG.expectAgentName) {
      banner.className = 'banner ok';
      banner.innerHTML = '<b>✔ ענה הסוכן שעל המחשב שלך</b><br><span class="mono">lk.agent.name = "' +
        name + '" — זה הקוד וההגדרות שרצות אצלך עכשיו.</span>';
    } else if (!name) {
      banner.className = 'banner bad';
      banner.innerHTML = '<b>⚠ ענה סוכן בלי שם — כלומר הסוכן בענן (ייצור)</b><br>' +
        '<span class="mono">lk.agent.name = "" — לא המחשב שלך. אל תסיק מכאן שום דבר על שינוי מקומי.</span>';
    } else {
      banner.className = 'banner bad';
      banner.innerHTML = '<b>⚠ ענה סוכן אחר: ' + name + '</b><br><span class="mono">ציפינו ל־"' +
        CFG.expectAgentName + '".</span>';
    }
  }

  function watchLevel(track) {
    try {
      ctx = new AudioContext();
      var an = ctx.createAnalyser();
      an.fftSize = 256;
      ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(an);
      var data = new Uint8Array(an.frequencyBinCount);
      (function tick() {
        an.getByteFrequencyData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i];
        var level = sum / data.length / 255;
        orb.style.transform = 'scale(' + (1 + level * 0.9).toFixed(3) + ')';
        stateEl.textContent = level > 0.02 ? 'היא מדברת' : 'מקשיבה';
        raf = requestAnimationFrame(tick);
      })();
    } catch (e) { /* level meter is a nicety, never a blocker */ }
  }

  function teardown() {
    cancelAnimationFrame(raf);
    if (timer) clearInterval(timer);
    timer = null;
    if (ctx) { try { ctx.close(); } catch (e) {} ctx = null; }
    orb.className = 'orb idle';
    orb.style.transform = 'scale(1)';
    var r = room; room = null;
    if (r) r.disconnect();
    startBtn.disabled = false;
    muteBtn.disabled = true;
    hangBtn.disabled = true;
  }

  startBtn.onclick = async function () {
    startBtn.disabled = true;
    answered = false;
    logEl.innerHTML = '';
    banner.className = 'banner wait';
    banner.innerHTML = '<b>מחייג…</b> ממתין לסוכן <span class="mono">' +
      (CFG.expectAgentName || '(ברירת מחדל — הענן)') + '</span>';
    stateEl.textContent = 'מתחבר';
    try {
      try {
        var probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) { throw new Error('המיקרופון חסום בדפדפן. אשר גישה ונסה שוב.'); }

      var res = await fetch('/token', { method: 'POST' });
      if (!res.ok) throw new Error('השרת המקומי החזיר ' + res.status + ': ' + (await res.text()));
      var s = await res.json();

      room = new LK.Room();
      orb.className = 'orb';

      room.on(LK.RoomEvent.TrackSubscribed, function (track, pub, participant) {
        if (track.kind !== LK.Track.Kind.Audio) return;
        audioBox.appendChild(track.attach());
        if (pub.trackName !== 'recording-notice') watchLevel(track);
        if (!answered) judgeAgent((participant.attributes || {})[AGENT_NAME_ATTR] || '');
        if (!timer) {
          startedAt = Date.now();
          timer = setInterval(function () {
            var s2 = Math.floor((Date.now() - startedAt) / 1000);
            document.getElementById('meta').textContent =
              'tenant ' + CFG.tenantId + ' · ' + String(Math.floor(s2 / 60)).padStart(2, '0') + ':' + String(s2 % 60).padStart(2, '0');
          }, 1000);
        }
      });
      room.on(LK.RoomEvent.TrackUnsubscribed, function (track) {
        track.detach().forEach(function (el) { el.remove(); });
      });
      room.on(LK.RoomEvent.ParticipantConnected, function (p) {
        if (!answered && p.attributes && AGENT_NAME_ATTR in p.attributes) judgeAgent(p.attributes[AGENT_NAME_ATTR] || '');
      });
      room.on(LK.RoomEvent.ParticipantAttributesChanged, function (changed, p) {
        if (!answered && changed && AGENT_NAME_ATTR in changed) judgeAgent(changed[AGENT_NAME_ATTR] || '');
      });
      room.on(LK.RoomEvent.TranscriptionReceived, function (segs, participant) {
        var role = participant && participant.isLocal ? 'user' : 'agent';
        segs.forEach(function (seg) { say(role, seg.text, seg.id); });
      });
      room.on(LK.RoomEvent.AudioPlaybackStatusChanged, function () {
        unlockBtn.style.display = room && !room.canPlaybackAudio ? '' : 'none';
      });
      room.on(LK.RoomEvent.Disconnected, function () {
        stateEl.textContent = 'השיחה הסתיימה';
        teardown();
      });

      await room.connect(s.url, s.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      muted = false;
      muteBtn.textContent = 'השתק מיקרופון';
      muteBtn.disabled = false;
      hangBtn.disabled = false;
      stateEl.textContent = 'ממתין שהסוכן יצטרף';
      say('sys', 'התחברת. אם הסוכן לא מצטרף תוך כמה שניות — בדוק שהחלון של npm run voice:dev רץ.');
    } catch (err) {
      banner.className = 'banner bad';
      banner.innerHTML = '<b>לא הצלחנו להתחיל</b><br><span class="err">' + (err && err.message ? err.message : err) + '</span>';
      stateEl.textContent = 'תקלה';
      teardown();
    }
  };

  muteBtn.onclick = async function () {
    if (!room) return;
    muted = !muted;
    await room.localParticipant.setMicrophoneEnabled(!muted);
    muteBtn.textContent = muted ? 'בטל השתקה' : 'השתק מיקרופון';
  };
  hangBtn.onclick = function () { stateEl.textContent = 'ניתקת'; teardown(); };
  unlockBtn.onclick = function () { if (room) room.startAudio(); unlockBtn.style.display = 'none'; };
})();
</script>
</body>
</html>
`;
}
