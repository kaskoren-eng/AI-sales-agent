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
