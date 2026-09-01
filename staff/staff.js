/* =========================================================================
 * Esther's staff inbox - Phase 2A foundation
 *
 * A deliberately small client. Everything it can see is decided by the
 * database, not by this file: the migrations revoke every privilege from
 * anon and authenticated, and grant a narrow set back only to a signed-in
 * user with an active staff_profiles row. Hiding a button here is a
 * courtesy to the user, never a security control.
 *
 * The reads go through the Data API with the caller's own session, so RLS
 * applies to them directly. The writes go through the staff-actions Edge
 * Function, which re-checks membership server-side before touching
 * anything - a compromised browser cannot post as a customer or as a
 * colleague, because sender_type and the author id are set from the
 * verified JWT, never from anything sent by this page.
 *
 * PHASE 2A: none of the backend is deployed yet. Until the migrations are
 * applied and the functions are deployed, signing in will fail and the
 * lists will be empty. That is expected.
 * ========================================================================= */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var views = {
    setup:  $('view-setup'),
    login:  $('view-login'),
    denied: $('view-denied'),
    inbox:  $('view-inbox'),
  };

  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = (k !== name); });
  }

  function setError(el, message) {
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = message;
  }

  /* ------------------------------------------------------------- config */

  var config = window.ESTHERS_CHAT_CONFIG;

  function configured() {
    return !!(config &&
      typeof config.supabaseUrl === 'string' &&
      typeof config.supabasePublishableKey === 'string' &&
      config.supabaseUrl.indexOf('PASTE_') === -1 &&
      config.supabasePublishableKey.indexOf('PASTE_') === -1 &&
      config.supabaseUrl.length > 0 &&
      config.supabasePublishableKey.length > 0);
  }

  if (!configured() || typeof window.supabase === 'undefined') {
    show('setup');
    return;
  }

  var sb = window.supabase.createClient(
    config.supabaseUrl,
    config.supabasePublishableKey
  );

  var state = { user: null, staff: null, status: 'open', conversationId: null };

  /* ------------------------------------------------------------ session */

  function functionsUrl(name) {
    return config.supabaseUrl.replace(/\/+$/, '') + '/functions/v1/' + name;
  }

  /* Calls a staff Edge Function with the caller's access token. The token
     is sent in the Authorization header only - never in a URL, where it
     would end up in logs and browser history. */
  async function callFunction(name, payload) {
    var session = (await sb.auth.getSession()).data.session;
    if (!session) { await signOut(); throw new Error('Your session has expired.'); }

    var res = await fetch(functionsUrl(name), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
      },
      body: JSON.stringify(payload),
    });

    var data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }

    if (!res.ok) {
      throw new Error((data && data.error) || 'That did not work. Please try again.');
    }
    return data;
  }

  async function signOut() {
    await sb.auth.signOut();
    state.user = null; state.staff = null; state.conversationId = null;
    $('who').hidden = true;
    $('sign-out').hidden = true;
    show('login');
  }

  /*
   * Membership check.
   *
   * Reads the caller's own staff_profiles row. Under RLS a non-staff user
   * simply gets nothing back - there is no separate "are you allowed"
   * endpoint to spoof, because the absence of a row IS the answer.
   */
  async function resolveStaff(user) {
    var result = await sb
      .from('staff_profiles')
      .select('user_id, display_name, is_active')
      .eq('user_id', user.id)
      .maybeSingle();

    if (result.error || !result.data || result.data.is_active !== true) return null;
    return result.data;
  }

  async function afterSignIn(user) {
    state.user = user;
    var staff = await resolveStaff(user);

    if (!staff) { state.staff = null; show('denied'); return; }

    state.staff = staff;
    $('who').textContent = staff.display_name;
    $('who').hidden = false;
    $('sign-out').hidden = false;
    show('inbox');
    await loadConversations();
  }

  /* ------------------------------------------------------------- login */

  $('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    setError($('login-error'), '');
    var btn = $('login-submit');
    btn.disabled = true;

    var result = await sb.auth.signInWithPassword({
      email: $('login-email').value.trim(),
      password: $('login-password').value,
    });

    // Never clear the email - retyping it on every failed attempt is a
    // small cruelty. Always clear the password.
    $('login-password').value = '';
    btn.disabled = false;

    if (result.error) {
      // Supabase's own message is deliberately vague about whether the
      // account exists; keep it that way rather than adding detail.
      setError($('login-error'), 'Those details were not recognised.');
      return;
    }
    await afterSignIn(result.data.user);
  });

  $('sign-out').addEventListener('click', signOut);
  $('denied-sign-out').addEventListener('click', signOut);

  /* ------------------------------------------------------- conversations */

  function formatWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function describeCustomer(c) {
    return c.customer_name || c.customer_email || c.customer_phone || 'Website visitor';
  }

  async function loadConversations() {
    var list = $('conversation-list');
    list.innerHTML = '';

    var query = sb
      .from('chat_conversations')
      .select('id, status, created_at, last_message_at, staff_last_read_at, ' +
              'customer_name, customer_email, customer_phone')
      .order('last_message_at', { ascending: false })
      .limit(50);

    if (state.status !== 'all') query = query.eq('status', state.status);

    var result = await query;
    if (result.error) { $('list-empty').hidden = false;
      $('list-empty').textContent = 'Could not load conversations.'; return; }

    var rows = result.data || [];
    $('list-empty').hidden = rows.length > 0;
    if (rows.length === 0) $('list-empty').textContent = 'No conversations yet.';

    rows.forEach(function (c) {
      var unread = !c.staff_last_read_at ||
                   new Date(c.last_message_at) > new Date(c.staff_last_read_at);

      var li = document.createElement('li');
      li.className = 'staff-item' + (c.id === state.conversationId ? ' is-active' : '');

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'staff-item__btn';
      btn.addEventListener('click', function () { openConversation(c.id); });

      var top = document.createElement('span');
      top.className = 'staff-item__top';
      var who = document.createElement('span');
      who.className = 'staff-item__who';
      who.textContent = describeCustomer(c);
      var when = document.createElement('span');
      when.className = 'staff-item__when';
      when.textContent = formatWhen(c.last_message_at);
      top.appendChild(who); top.appendChild(when);

      var tags = document.createElement('span');
      tags.className = 'staff-item__tags';
      if (unread) {
        var dot = document.createElement('span');
        dot.className = 'staff-dot';
        dot.title = 'Unread';
        tags.appendChild(dot);
      }
      if (c.status === 'closed') {
        var closed = document.createElement('span');
        closed.className = 'staff-tag';
        closed.textContent = 'Closed';
        tags.appendChild(closed);
      }

      btn.appendChild(top); btn.appendChild(tags);
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.staff-chip'), function (chip) {
    chip.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.staff-chip'), function (c) {
        c.classList.remove('is-on');
      });
      chip.classList.add('is-on');
      state.status = chip.getAttribute('data-status');
      loadConversations();
    });
  });

  /* -------------------------------------------------------------- thread */

  async function openConversation(id) {
    state.conversationId = id;
    setError($('thread-error'), '');
    $('thread-empty').hidden = true;
    $('thread').hidden = false;

    var conv = await sb
      .from('chat_conversations')
      .select('id, status, created_at, customer_name, customer_email, customer_phone')
      .eq('id', id)
      .maybeSingle();

    if (conv.error || !conv.data) {
      setError($('thread-error'), 'Could not load that conversation.');
      return;
    }

    $('thread-title').textContent = describeCustomer(conv.data);

    var bits = [];
    if (conv.data.customer_email) bits.push(conv.data.customer_email);
    if (conv.data.customer_phone) bits.push(conv.data.customer_phone);
    bits.push('started ' + new Date(conv.data.created_at).toLocaleDateString());
    $('thread-meta').textContent = bits.join('  ·  ');

    $('toggle-status').textContent = conv.data.status === 'closed' ? 'Reopen' : 'Close';
    $('reply-input').disabled = conv.data.status === 'closed';
    $('reply-send').disabled = true;

    var msgs = await sb
      .from('chat_messages')
      .select('id, sender_type, body, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .limit(500);

    var log = $('thread-log');
    log.innerHTML = '';
    (msgs.data || []).forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'staff-msg staff-msg--' + m.sender_type;
      var body = document.createElement('p');
      body.className = 'staff-msg__body';
      // textContent, never innerHTML: message bodies are typed by members
      // of the public and are never treated as markup.
      body.textContent = m.body;
      var meta = document.createElement('p');
      meta.className = 'staff-msg__meta';
      meta.textContent = (m.sender_type === 'staff' ? "Esther's" :
                          m.sender_type === 'system' ? 'System' : 'Customer') +
                         '  ·  ' + new Date(m.created_at).toLocaleString();
      row.appendChild(body); row.appendChild(meta);
      log.appendChild(row);
    });
    log.scrollTop = log.scrollHeight;

    try { await callFunction('staff-actions', { action: 'mark-read', conversationId: id }); }
    catch (e) { /* not fatal: the transcript is already on screen */ }

    loadConversations();
  }

  $('reply-input').addEventListener('input', function () {
    $('reply-send').disabled = $('reply-input').value.trim() === '';
  });

  $('reply-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!state.conversationId) return;
    var text = $('reply-input').value.trim();
    if (!text) return;

    setError($('thread-error'), '');
    $('reply-send').disabled = true;
    try {
      await callFunction('staff-actions', {
        action: 'reply',
        conversationId: state.conversationId,
        message: text,
      });
      $('reply-input').value = '';
      await openConversation(state.conversationId);
    } catch (err) {
      setError($('thread-error'), err.message);
      $('reply-send').disabled = false;
    }
  });

  $('toggle-status').addEventListener('click', async function () {
    if (!state.conversationId) return;
    var next = $('toggle-status').textContent === 'Close' ? 'closed' : 'open';
    setError($('thread-error'), '');
    try {
      await callFunction('staff-actions', {
        action: 'set-status',
        conversationId: state.conversationId,
        status: next,
      });
      await openConversation(state.conversationId);
      await loadConversations();
    } catch (err) {
      setError($('thread-error'), err.message);
    }
  });

  /* --------------------------------------------------------------- boot */

  sb.auth.getSession().then(async function (res) {
    var session = res.data.session;
    if (session && session.user) await afterSignIn(session.user);
    else show('login');
  }).catch(function () { show('login'); });
}());
