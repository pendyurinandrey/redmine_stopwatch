/* Redmine Stopwatch Plugin — client-side timer widget
 *
 * LOCAL REDESIGN: a large floating bar with three controls —
 *   ▶ start (on the issue that is open), ⏹ stop, ☰ recent issues.
 * The timer always belongs to an issue. The ☰ panel lists the last tracked
 * issues; choosing one switches the timer (previous segment is written to
 * Redmine immediately, then a new segment starts).
 */
(function ($) {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────
  var widget       = null;   // #stopwatch-widget (fixed container)
  var bar          = null;   // .sw-bar   (buttons)
  var popup        = null;   // .sw-popup (recent issues)
  var toast        = null;   // .sw-toast (feedback)
  var i18n         = {};
  var timerState   = 'stopped';   // 'stopped' | 'running' | 'paused' (legacy)
  var accSeconds   = 0;
  var startedAtMs  = null;
  var tickInterval = null;
  var tickTimeout  = null;
  var busy         = false;
  var pendingCount = 0;          // segments that could not be auto-logged
  var timerIssue   = null;       // { id, subject, url } the timer runs on
  var pageIssue    = null;       // { id, subject, url, canTrack } open page
  var popupOpen    = false;
  var toastTimer   = null;
  var swChannel    = null;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function esc(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str == null ? '' : String(str)));
    return div.innerHTML.replace(/"/g, '&quot;');
  }

  function fmt(template, vars) {
    return String(template || '').replace(/\{(\w+)\}/g, function (m, key) {
      return Object.prototype.hasOwnProperty.call(vars || {}, key) ? vars[key] : m;
    });
  }

  function t(key) { return i18n[key] || ''; }

  function formatTime(totalSeconds) {
    var totalMinutes = Math.floor(totalSeconds / 60);
    var hours        = Math.floor(totalMinutes / 60);
    var minutes      = totalMinutes % 60;
    return hours + ':' + (minutes < 10 ? '0' : '') + minutes;
  }

  function computeElapsed() {
    if (timerState === 'running' && startedAtMs !== null) {
      return Math.max(0, accSeconds + Math.floor((Date.now() - startedAtMs) / 1000));
    }
    return accSeconds;
  }

  function isTracking() { return timerState === 'running' || timerState === 'paused'; }

  function readIssue(prefix) {
    var id = widget.dataset[prefix + 'IssueId'];
    if (!id) { return null; }
    return {
      id:       String(id),
      subject:  widget.dataset[prefix + 'IssueSubject'] || '',
      url:      widget.dataset[prefix + 'IssueUrl'] || '',
      canTrack: widget.dataset[prefix + 'CanTrack'] === '1'
    };
  }

  function issueFromJson(issue) {
    return issue ? { id: String(issue.id), subject: issue.subject || '', url: issue.url || '' } : null;
  }

  function isOnSegmentsPage() {
    var segUrl = widget && widget.dataset.segmentsUrl;
    if (!segUrl) { return false; }
    return window.location.pathname === segUrl.split('?')[0].split('#')[0];
  }

  // ── Feedback toast ───────────────────────────────────────────────────────

  function showToast(html, kind, ms) {
    if (!toast) { return; }
    toast.className = 'sw-toast sw-toast-' + (kind || 'ok');
    toast.innerHTML = html;
    toast.hidden = false;
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { toast.hidden = true; }, ms || 5000);
  }

  function showResult(result) {
    if (!result) { return; }
    if (result.status === 'logged') {
      showToast(esc(fmt(t('notice_stopwatch_logged'),
        { hours: Number(result.hours).toFixed(2), id: result.issue_id })), 'ok');
    } else if (result.status === 'discarded') {
      showToast(esc(fmt(t('notice_stopwatch_discarded'), { id: result.issue_id })), 'warn');
    } else if (result.status === 'kept') {
      showToast(esc(fmt(t('notice_stopwatch_kept'), { id: result.issue_id })) +
        ' <a href="' + esc(widget.dataset.segmentsUrl) + '">' +
        esc(fmt(t('label_stopwatch_unsaved_segments'), { n: pendingCount })) + '</a>',
        'error', 12000);
    }
  }

  // ── API ──────────────────────────────────────────────────────────────────

  function setBusy(on) {
    busy = on;
    if (!widget) { return; }
    widget.classList.toggle('sw-busy', on);
    var buttons = widget.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) { buttons[i].disabled = on; }
  }

  function apiCall(url, params, callback) {
    if (busy) { return; }
    setBusy(true);
    $.ajax({
      url:      url,
      type:     'POST',
      data:     params || {},
      dataType: 'json',
      headers:  { 'X-CSRF-Token': csrfToken() },
      success: function (data) {
        setBusy(false);
        callback(data);
        broadcastState(data);
      },
      error: function (xhr) {
        setBusy(false);
        var msg = (xhr.responseJSON && xhr.responseJSON.error) || t('error_stopwatch_generic');
        showToast(esc(msg), 'error', 7000);
        console.error('[Stopwatch] API error', xhr.status, xhr.responseText);
      }
    });
  }

  function startOn(issueId) {
    closePopup();
    apiCall(widget.dataset.startUrl, { issue_id: issueId }, function (data) { applyState(data); });
  }

  function stopTimer() {
    closePopup();
    apiCall(widget.dataset.stopUrl, {}, function (data) { applyState(data); });
  }

  // ── Cross-tab sync ───────────────────────────────────────────────────────

  function broadcastState(data) {
    if (!swChannel) { return; }
    swChannel.postMessage({
      state:                  data.state,
      accumulated_seconds:    data.accumulated_seconds,
      started_at:             data.started_at,
      pending_segments_count: data.pending_segments_count,
      issue:                  data.issue
    });
  }

  // ── State ────────────────────────────────────────────────────────────────

  function applyState(data, silent) {
    timerState  = data.state || 'stopped';
    accSeconds  = data.accumulated_seconds || 0;
    startedAtMs = data.started_at ? new Date(data.started_at).getTime() : null;
    if (typeof data.pending_segments_count !== 'undefined') {
      pendingCount = data.pending_segments_count;
    }
    timerIssue = issueFromJson(data.issue);

    if (!silent) { showResult(data.result); }

    // The segments page renders lists on the server: refresh it after a change.
    if (!silent && isOnSegmentsPage()) {
      setTimeout(function () { window.location.reload(); }, data.result ? 1500 : 0);
      return;
    }
    renderBar();
    resetTick();
  }

  // Re-read the timer from the server so a tab that was in the background
  // (or restored from the browser cache) never shows a stale state.
  var lastSyncMs = 0;
  function syncFromServer() {
    if (busy || !widget || !widget.dataset.stateUrl) { return; }
    var now = Date.now();
    if (now - lastSyncMs < 2000) { return; }
    lastSyncMs = now;
    $.ajax({
      url: widget.dataset.stateUrl, type: 'GET', dataType: 'json', cache: false,
      success: function (data) { if (!busy) { applyState(data, true); } }
    });
  }

  function resetTick() {
    if (tickTimeout)  { clearTimeout(tickTimeout);   tickTimeout  = null; }
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
    if (timerState !== 'running') { return; }

    var msUntilNextMinute = 60000 - (Date.now() % 60000);
    tickTimeout = setTimeout(function () {
      tickTimeout  = null;
      renderBar();
      tickInterval = setInterval(renderBar, 60000);
    }, msUntilNextMinute);
  }

  // ── Bar rendering ────────────────────────────────────────────────────────

  function startButton(issue, title) {
    return '<button type="button" class="sw-btn sw-start" data-issue-id="' + esc(issue.id) + '"' +
           ' title="' + esc(title) + '" aria-label="' + esc(title) + '">' +
           '<span class="sw-ico">▶</span><span class="sw-lbl">#' + esc(issue.id) + '</span></button>';
  }

  function renderBar() {
    if (!bar) { return; }
    var tracking = isTracking();
    var html = '';
    widget.classList.toggle('sw-tracking', tracking);

    if (tracking && timerIssue) {
      html += '<a class="sw-ctx" href="' + esc(timerIssue.url) + '" title="' + esc(timerIssue.subject) + '">' +
              '<span class="sw-ctx-id">#' + esc(timerIssue.id) + '</span>' +
              '<span class="sw-ctx-subject">' + esc(timerIssue.subject) + '</span></a>';
    }
    if (tracking) {
      html += '<span class="sw-time' + (timerState === 'paused' ? ' sw-paused' : '') + '">' +
              formatTime(computeElapsed()) + '</span>';
    }

    // Legacy paused timer (pause is no longer offered): allow resuming it
    if (timerState === 'paused' && timerIssue) {
      html += startButton(timerIssue, t('button_stopwatch_start'));
    }

    // Start (or switch) on the issue that is open right now
    if (pageIssue && pageIssue.canTrack && !(tracking && timerIssue && timerIssue.id === pageIssue.id)) {
      html += startButton(pageIssue, tracking ? t('button_stopwatch_start_here') : t('button_stopwatch_start'));
    }

    if (tracking) {
      html += '<button type="button" class="sw-btn sw-stop" title="' + esc(t('button_stopwatch_stop')) +
              '" aria-label="' + esc(t('button_stopwatch_stop')) + '"><span class="sw-ico">⏹</span></button>';
    }

    html += '<button type="button" class="sw-btn sw-list' + (popupOpen ? ' sw-list-open' : '') +
            '" title="' + esc(t('button_stopwatch_recent')) + '" aria-label="' + esc(t('button_stopwatch_recent')) +
            '" aria-expanded="' + (popupOpen ? 'true' : 'false') + '"><span class="sw-ico">☰</span>';
    if (pendingCount > 0) { html += '<span class="sw-badge">' + pendingCount + '</span>'; }
    html += '</button>';

    bar.innerHTML = html;
    bindBar();
  }

  function bindBar() {
    var startBtns = bar.querySelectorAll('.sw-start');
    for (var i = 0; i < startBtns.length; i++) {
      startBtns[i].addEventListener('click', function (e) {
        startOn(e.currentTarget.getAttribute('data-issue-id'));
      });
    }
    var stopBtn = bar.querySelector('.sw-stop');
    if (stopBtn) { stopBtn.addEventListener('click', stopTimer); }
    var listBtn = bar.querySelector('.sw-list');
    if (listBtn) { listBtn.addEventListener('click', togglePopup); }
  }

  // ── Recent issues popup ──────────────────────────────────────────────────

  function togglePopup() { if (popupOpen) { closePopup(); } else { openPopup(); } }

  function openPopup() {
    popupOpen = true;
    popup.hidden = false;
    popup.innerHTML = '<div class="sw-popup-title">' + esc(t('label_stopwatch_recent_title')) + '</div>' +
                      '<div class="sw-popup-body sw-muted">' + esc(t('label_stopwatch_recent_loading')) + '</div>';
    renderBar();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('touchstart', onOutside, true);

    $.getJSON(widget.dataset.recentUrl)
      .done(function (data) { if (popupOpen) { renderRecent(data); } })
      .fail(function () {
        if (popupOpen) { popup.querySelector('.sw-popup-body').textContent = t('error_stopwatch_generic'); }
      });
  }

  function closePopup() {
    if (!popupOpen) { return; }
    popupOpen = false;
    popup.hidden = true;
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('touchstart', onOutside, true);
    renderBar();
  }

  function onKeyDown(e) { if (e.key === 'Escape') { closePopup(); } }
  function onOutside(e) { if (widget && !widget.contains(e.target)) { closePopup(); } }

  function formatLast(iso) {
    if (!iso) { return ''; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    var now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  function renderRecent(data) {
    var issues = (data && data.issues) || [];
    var html = '<div class="sw-popup-title">' + esc(t('label_stopwatch_recent_title')) + '</div>';

    if (!issues.length) {
      html += '<div class="sw-popup-body sw-muted">' + esc(t('label_stopwatch_recent_empty')) + '</div>';
    } else {
      html += '<div class="sw-popup-body">';
      issues.forEach(function (issue) {
        var meta = [issue.project];
        if (issue.active) {
          meta.push(t('label_stopwatch_recent_active'));
        } else {
          if (issue.today_hours > 0) { meta.push(fmt(t('label_stopwatch_recent_today'), { h: issue.today_hours })); }
          var last = formatLast(issue.last_at);
          if (last) { meta.push(last); }
        }
        html += '<button type="button" class="sw-row' + (issue.active ? ' sw-row-active' : '') + '"' +
                ' data-issue-id="' + esc(issue.id) + '"' + (issue.active && timerState === 'running' ? ' disabled' : '') + '>' +
                '<span class="sw-row-main"><span class="sw-row-id">#' + esc(issue.id) + '</span> ' +
                '<span class="sw-row-subject">' + esc(issue.subject) + '</span></span>' +
                '<span class="sw-row-meta">' + (issue.active ? '● ' : '') + esc(meta.join(' · ')) + '</span>' +
                '</button>';
      });
      html += '</div>';
    }

    if (pendingCount > 0) {
      html += '<a class="sw-popup-footer" href="' + esc(widget.dataset.segmentsUrl) + '">' +
              esc(fmt(t('label_stopwatch_unsaved_segments'), { n: pendingCount })) + '</a>';
    }
    popup.innerHTML = html;

    var rows = popup.querySelectorAll('.sw-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener('click', function (e) {
        startOn(e.currentTarget.getAttribute('data-issue-id'));
      });
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  $(document).ready(function () {
    widget = document.getElementById('stopwatch-widget');
    if (!widget) { return; }

    try { i18n = JSON.parse(widget.dataset.i18n || '{}'); } catch (e) { i18n = {}; }

    timerState   = widget.dataset.state || 'stopped';
    accSeconds   = parseInt(widget.dataset.accumulatedSeconds, 10) || 0;
    pendingCount = parseInt(widget.dataset.pendingCount, 10) || 0;
    startedAtMs  = widget.dataset.startedAt ? new Date(widget.dataset.startedAt).getTime() : null;
    timerIssue   = readIssue('timer');
    pageIssue    = readIssue('page');

    // Floating bar attached to <body> (never inside the small #top-menu)
    document.body.appendChild(widget);
    widget.innerHTML = '<div class="sw-popup" hidden></div>' +
                       '<div class="sw-toast" role="status" hidden></div>' +
                       '<div class="sw-bar"></div>';
    popup = widget.querySelector('.sw-popup');
    toast = widget.querySelector('.sw-toast');
    bar   = widget.querySelector('.sw-bar');

    try { swChannel = new BroadcastChannel('stopwatch-' + (widget.dataset.userId || '0')); } catch (e) { /* unsupported */ }
    if (swChannel) {
      swChannel.onmessage = function (e) { applyState(e.data, true); };
    }

    renderBar();
    resetTick();

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { syncFromServer(); }
    });
    window.addEventListener('pageshow', function (e) { if (e.persisted) { syncFromServer(); } });
    window.addEventListener('focus', syncFromServer);
    setInterval(function () { if (!document.hidden) { syncFromServer(); } }, 60000);
    syncFromServer();
  });

}(jQuery));
