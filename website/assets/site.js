/* ClickScales marketing site — shared behaviour for both language pages. */
(function () {
  'use strict';

  // --- waveform bars: heights from a fixed seed so they read as audio, not noise
  document.querySelectorAll('[data-wave]').forEach(function (el) {
    var n = +el.dataset.wave, out = '';
    for (var i = 0; i < n; i++) {
      var h = 4 + Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6)) * 26;
      out += '<i style="height:' + h.toFixed(1) + 'px"></i>';
    }
    el.innerHTML = out;
  });

  // --- demo tabs
  var tabs = document.querySelectorAll('.tab');
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      tabs.forEach(function (x) { x.setAttribute('aria-selected', 'false'); });
      t.setAttribute('aria-selected', 'true');
      document.querySelectorAll('.pane').forEach(function (p) { p.removeAttribute('data-on'); });
      var pane = document.getElementById(t.dataset.pane);
      if (pane) pane.setAttribute('data-on', '');
    });
  });

  // --- scroll reveal
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -60px' });
    document.querySelectorAll('.rv').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.rv').forEach(function (el) { el.classList.add('in'); });
  }

  // --- demo form
  // Submits to Netlify Forms (the plain <form> keeps working with JS disabled).
  // Netlify picks it up from the static HTML at deploy time — no config needed.
  var form = document.querySelector('form[data-demo-form]');
  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = form.querySelector('.btn');
    var ok = form.querySelector('.form__ok');
    var original = btn.textContent;

    btn.disabled = true;
    btn.textContent = btn.dataset.sending || 'Sending…';

    var data = new URLSearchParams(new FormData(form)).toString();

    fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: data
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        form.setAttribute('data-sent', '');
        if (ok) ok.setAttribute('data-on', '');
      })
      .catch(function () {
        // Never swallow a lead: fall back to a normal browser POST.
        btn.disabled = false;
        btn.textContent = original;
        form.removeAttribute('data-demo-form');
        form.submit();
      });
  });
})();

/* TABS: ARROW-KEY NAVIGATION.
   A role="tablist" that only answers to clicks is a keyboard trap in the eyes of the standard:
   the ARIA role promises arrow-key behaviour, so announcing the role without implementing it is
   worse than using plain buttons. Roving tabindex: exactly one tab is in the tab order. */
(function(){
  var lists = document.querySelectorAll('[role="tablist"]');
  Array.prototype.forEach.call(lists, function(list){
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    if (!tabs.length) return;
    function sync(){
      tabs.forEach(function(t){ t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1; });
    }
    sync();
    tabs.forEach(function(t){ t.addEventListener('click', function(){ setTimeout(sync, 0); }); });
    list.addEventListener('keydown', function(e){
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      /* RTL: the standard maps ArrowRight/Left to visual direction, so flip them in Hebrew. */
      var rtl = document.documentElement.dir === 'rtl';
      var next = null;
      if (e.key === 'ArrowRight') next = rtl ? i - 1 : i + 1;
      else if (e.key === 'ArrowLeft') next = rtl ? i + 1 : i - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      else return;
      e.preventDefault();
      next = (next + tabs.length) % tabs.length;
      tabs[next].focus();
      tabs[next].click();
      sync();
    });
  });
})();

/* LEAD JOURNEY — scroll engine.
   Drives four things off one scroll position: the active step, the phone
   pane it shows, the rail fill + node, and the section background tone.
   Picks the step nearest the viewport centre in BOTH directions, so
   scrolling back always restores the exact state (and replays the pane
   build-up). The rail is trimmed to end on the closing check mark. */
(function(){
  var steps = Array.prototype.slice.call(document.querySelectorAll('.jn-step'));
  var panes = Array.prototype.slice.call(document.querySelectorAll('.jn-pane'));
  if (!steps.length || !panes.length) return;
  var clock = document.querySelector('.jn-status span');
  var count = document.querySelector('.jn-count');
  var band  = document.querySelector('.jnr');
  var stepsEl = document.querySelector('.jn-steps');
  var rail = document.querySelector('.jn-rail');
  var fill = rail && rail.querySelector('i');
  var endMark = document.querySelector('.jn-endline__mark');
  var times = ['21:40','21:40','21:41','21:44','21:45','21:42','22:40'];
  var current = -1, ticking = false;

  function activate(i){
    if (i === current) return; /* don't restart animations mid-view */
    current = i;
    steps.forEach(function(s,k){ s.classList.toggle('on', k===i); });
    panes.forEach(function(p,k){ p.classList.toggle('on', k===i); });
    if (clock) clock.textContent = times[i] || times[times.length-1];
    if (count) count.textContent = (i+1) + ' / ' + steps.length;
    if (band) band.setAttribute('data-tone', steps[i].dataset.tone || i);
  }
  /* the dashed rail must stop at the centre of the closing check, not run past it */
  function sizeRail(){
    if (!rail || !stepsEl || !endMark) return;
    var top = stepsEl.getBoundingClientRect().top;
    var m = endMark.getBoundingClientRect();
    rail.style.height = Math.max(0, (m.top + m.height/2) - top) + 'px';
  }
  function pick(){
    ticking = false;
    sizeRail();   /* keep the rail's end anchored to the check as content reflows */
    var mid = window.innerHeight / 2, best = 0, bestd = Infinity;
    steps.forEach(function(s,i){
      var r = s.getBoundingClientRect();
      var d = Math.abs(r.top + r.height/2 - mid);
      if (d < bestd){ bestd = d; best = i; }
    });
    activate(best);
    /* The fill tracks the SCROLL POSITION, not the active node: it follows the
       viewport's centre line 1:1 so the line glides with the wheel instead of
       hopping between steps. Clamped to the rail so it never over/undershoots. */
    if (fill && rail){
      var rr = rail.getBoundingClientRect();
      var h = mid - rr.top;
      fill.style.height = Math.max(0, Math.min(rr.height, h)) + 'px';
    }
  }
  function onScroll(){ if (!ticking){ ticking = true; requestAnimationFrame(pick); } }
  window.addEventListener('scroll', onScroll, {passive:true});
  window.addEventListener('resize', function(){ sizeRail(); onScroll(); });
  sizeRail(); pick();
  window.addEventListener('load', function(){ sizeRail(); pick(); });

  /* MOBILE: the sticky phone can't hold the pane content on small screens,
     so each pane moves INLINE into its own step and renders full-width.
     Desktop keeps the sticky phone; resizing moves them back. */
  var screenEl = document.querySelector('.jn-screen');
  var mq = window.matchMedia('(max-width:900px)');
  function placePanes(){
    if (mq.matches){
      panes.forEach(function(p,i){
        if (steps[i] && p.parentNode !== steps[i]){
          steps[i].appendChild(p);
          p.classList.add('jn-pane--inline');
        }
      });
    } else if (screenEl){
      panes.forEach(function(p){
        if (p.parentNode !== screenEl){
          screenEl.appendChild(p);
          p.classList.remove('jn-pane--inline');
        }
      });
    }
    sizeRail();
  }
  placePanes();
  if (mq.addEventListener) mq.addEventListener('change', placePanes);
})();

/* AGENT CALL RECORDINGS (hero).
   Pre-recorded real calls instead of a live demo: zero marginal cost per
   visitor. One shared <audio>; each row swaps the source. A missing file
   marks its row "soon" instead of breaking. */
(function(){
  var box = document.querySelector('.krec');
  if (!box) return;
  var audio = box.querySelector('.krec__audio');
  var rows = Array.prototype.slice.call(box.querySelectorAll('.krec__row'));
  var base = box.dataset.audioBase || '/assets/audio/';
  var he = document.documentElement.lang === 'he';
  var SOON = he ? 'בקרוב' : 'soon';
  var current = null;

  function fmt(sec){
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec/60) + ':' + ('0'+(sec%60)).slice(-2);
  }
  function setPlaying(row, on){
    rows.forEach(function(r){ r.removeAttribute('data-playing'); r.querySelector('.krec__play').textContent = '▶'; });
    if (on && row){ row.setAttribute('data-playing',''); row.querySelector('.krec__play').textContent = '❚❚'; }
    if (on) box.setAttribute('data-live',''); else box.removeAttribute('data-live');
  }

  /* fill real durations from file metadata (never invented) */
  rows.forEach(function(row){
    var probe = document.createElement('audio');
    probe.preload = 'metadata';
    probe.src = base + row.dataset.src;
    probe.onloadedmetadata = function(){
      row.querySelector('.krec__dur').textContent = fmt(probe.duration);
    };
    probe.onerror = function(){
      row.querySelector('.krec__dur').textContent = SOON;
      row.setAttribute('data-missing','');
    };
  });

  rows.forEach(function(row){
    row.addEventListener('click', function(){
      if (row.hasAttribute('data-missing')) return;
      if (current === row && !audio.paused){ audio.pause(); setPlaying(null, false); return; }
      current = row;
      audio.src = base + row.dataset.src;
      audio.play().then(function(){ setPlaying(row, true); }).catch(function(){
        row.querySelector('.krec__dur').textContent = SOON;
        row.setAttribute('data-missing','');
        setPlaying(null, false);
      });
    });
  });

  audio.addEventListener('timeupdate', function(){
    if (!current || !audio.duration) return;
    current.querySelector('.krec__bar i').style.width = (audio.currentTime / audio.duration * 100) + '%';
  });
  audio.addEventListener('ended', function(){
    if (current) current.querySelector('.krec__bar i').style.width = '0%';
    setPlaying(null, false);
  });
})();

/* PRICING CONSOLE — one price that morphs when a plan is picked.
   ------------------------------------------------------------------
   >>> THE ONLY BLOCK TO EDIT WHEN PRICING CHANGES IS `PLANS` BELOW. <<<
   Numbers are from docs/gtm/pricing-model.md (approved 2026-09-02) and
   the launch-pricing brief. `was` is the list price, struck through;
   `price` is what the customer pays during the launch window. A plan
   with custom:true renders `price` as a word and hides the ₪ glyph.
   ------------------------------------------------------------------ */
(function(){
  var box = document.querySelector('.pr');
  if (!box) return;
  var he = document.documentElement.lang === 'he';

  var PLANS = he ? [
    { name:'פיילוט',   kick:'PILOT',      was:'799',   price:'649',   min:'500',    calls:'1' },
    { name:'התחלה',    kick:'START',      was:'1,490', price:'1,190', min:'1,100',  calls:'2', popular:'הבחירה הפופולרית ביותר' },
    { name:'צמיחה',    kick:'GROWTH',     was:'2,390', price:'1,990', min:'2,500',  calls:'3' },
    { name:'סקייל',    kick:'SCALE',      was:'3,990', price:'3,590', min:'5,000',  calls:'4' },
    { name:'אנטרפרייז', kick:'ENTERPRISE', was:'',      price:'לפי אפיון', min:'5,000+', calls:'4-6', custom:true }
  ] : [
    { name:'Pilot',      kick:'PILOT',      was:'799',   price:'649',   min:'500',    calls:'1' },
    { name:'Start',      kick:'START',      was:'1,490', price:'1,190', min:'1,100',  calls:'2', popular:'The most popular choice' },
    { name:'Growth',     kick:'GROWTH',     was:'2,390', price:'1,990', min:'2,500',  calls:'3' },
    { name:'Scale',      kick:'SCALE',      was:'3,990', price:'3,590', min:'5,000',  calls:'4' },
    { name:'Enterprise', kick:'ENTERPRISE', was:'',      price:'Custom', min:'5,000+', calls:'4-6', custom:true }
  ];

  var L = he ? {
    was:'במקום', per:'לחודש · מחיר השקה', perCustom:'לחודש · תמחור אישי',
    min:'דקות שיחה בחודש', calls:'שיחות במקביל',
    setupWas:'דמי הקמה 1,500 ₪', setupNow:'ללא דמי הקמה',
    setupFine:'במחירי ההשקה, לכל החבילות', setupCustom:'דמי הקמה לפי אפיון'
  } : {
    was:'was', per:'per month · launch price', perCustom:'per month · custom pricing',
    min:'CALL MINUTES / MONTH', calls:'CONCURRENT CALLS',
    setupWas:'Setup fee 1,500 ₪', setupNow:'No setup fee',
    setupFine:'at launch pricing, on every plan', setupCustom:'setup fee on scoping'
  };

  var seg   = box.querySelector('.pr__seg');
  var kick  = box.querySelector('.pr__kick');
  var was   = box.querySelector('.pr__was');
  var price = box.querySelector('.pr__price');
  var sub   = box.querySelector('.pr__sub');
  var facts = box.querySelector('.pr__facts');
  var setup = box.querySelector('.pr__setup');
  var code  = box.querySelector('.pr__code');
  var btns  = [];

  PLANS.forEach(function(p, i){
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.textContent = p.name;
    if (p.popular) b.setAttribute('data-pop', '');
    b.addEventListener('click', function(){ show(i); });
    seg.appendChild(b);
    btns.push(b);
  });

  function n(v){ return '<span class="num">' + v + '</span>'; }

  function show(i){
    var p = PLANS[i];
    btns.forEach(function(b, k){ b.setAttribute('aria-selected', k === i ? 'true' : 'false'); });

    kick.textContent = p.kick + ' PLAN';
    was.innerHTML  = p.was ? L.was + ' <s>' + n(p.was) + ' ₪</s>' : '';
    price.innerHTML = p.custom ? p.price : '<i>₪</i>' + n(p.price);
    price.classList.toggle('pr__price--word', !!p.custom);
    sub.textContent = p.custom ? L.perCustom : L.per;
    facts.innerHTML =
      '<div><b>' + n(p.min) + '</b><span>' + L.min + '</span></div>' +
      '<div><b>' + n(p.calls) + '</b><span>' + L.calls + '</span></div>';
    setup.innerHTML = p.custom
      ? '<em>' + L.setupCustom + '</em>'
      : '<s>' + L.setupWas + '</s> <b>' + L.setupNow + '</b> <em>' + L.setupFine + '</em>';
    if (code) code.textContent = 'PLAN 0' + (i + 1) + ' / 0' + PLANS.length;
    box.classList.toggle('is-pop', !!p.popular);
    var pt = box.querySelector('.pr__poptxt');
    if (pt && p.popular) pt.textContent = p.popular;

    [price, sub, facts, was].forEach(function(el){
      el.classList.remove('pr-fade'); void el.offsetWidth; el.classList.add('pr-fade');
    });
  }

  /* RTL-aware arrow keys, same contract as the site's other tablists */
  seg.addEventListener('keydown', function(e){
    var i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    var rtl = document.documentElement.dir === 'rtl', next = null;
    if (e.key === 'ArrowRight') next = rtl ? i - 1 : i + 1;
    else if (e.key === 'ArrowLeft') next = rtl ? i + 1 : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = btns.length - 1;
    else return;
    e.preventDefault();
    next = (next + btns.length) % btns.length;
    btns[next].focus(); show(next);
  });

  show(1); /* Start leads: it is the entry plan we can actually deliver today */

  /* The confetti fires once, on first sight. A permanently looping party
     reads as decoration; a single burst reads as an event. */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (e.isIntersecting) { box.classList.add('is-live'); io.disconnect(); }
      });
    }, { threshold: 0.35 });
    io.observe(box);
  } else {
    box.classList.add('is-live');
  }
})();
