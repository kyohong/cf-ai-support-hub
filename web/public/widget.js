/*
 * Customer-support chat widget, embedded with:
 *   <script src="https://your-worker.example/widget.js" data-bot-id="bot_xxx" defer></script>
 *
 * A floating button opens a chat panel; when the bot has auto-memory on, a pill in the header
 * opens a slide-over drawer where the visitor can view, edit, add and delete what the bot
 * remembers about them. No build step and no dependencies — plain JavaScript in a shadow root.
 */
;(function () {
  'use strict'

  var script = document.currentScript
  if (!script) return
  var botId = script.getAttribute('data-bot-id')
  if (!botId) return
  var base = new URL(script.src).origin

  var VISITOR_KEY = 'cshub_visitor_' + botId
  function visitorId() {
    try {
      var existing = localStorage.getItem(VISITOR_KEY)
      if (existing) return existing
      var fresh = (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'v-' + Date.now() + '-' + Math.random().toString(36).slice(2)
      localStorage.setItem(VISITOR_KEY, fresh)
      return fresh
    } catch (e) {
      return 'v-anon'
    }
  }
  var visitor = visitorId()

  var state = { config: null, open: false, drawer: false, memories: [], editingId: null, adding: false, sent: false }

  // ——— Tiny DOM helpers ———

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function bubble(role, text) {
    var wrap = el('div', 'msg ' + role)
    wrap.appendChild(el('div', 'bubble', text))
    return wrap
  }

  function badge(category) {
    var b = el('span', 'badge cat-' + category, category)
    return b
  }

  // ——— Styles (scoped to the shadow root) ———

  var CSS = [
    ':host{all:initial;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;color:#18181b}',
    '*{box-sizing:border-box;margin:0}',
    'button{font:inherit;cursor:pointer;border:0;background:none;color:inherit}',
    '.launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:52px;height:52px;border-radius:999px;',
    '  background:var(--accent,#2563eb);color:#fff;display:flex;align-items:center;justify-content:center;',
    '  box-shadow:0 8px 24px rgba(0,0,0,.22);transition:transform .15s ease}',
    '.launcher:hover{transform:scale(1.06)}',
    '.launcher svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '.panel{position:fixed;right:20px;bottom:84px;z-index:2147483000;width:min(380px,calc(100vw - 32px));',
    '  height:min(560px,calc(100vh - 120px));border-radius:16px;background:#fff;display:flex;flex-direction:column;overflow:hidden;',
    '  border:1px solid #e4e4e7;box-shadow:0 16px 48px rgba(0,0,0,.18);opacity:0;pointer-events:none;',
    '  transform:translateY(12px) scale(.98);transition:opacity .18s ease,transform .18s ease}',
    '.panel.on{opacity:1;pointer-events:auto;transform:none}',
    '.head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #f4f4f5;background:#fafafa}',
    '.dot{width:9px;height:9px;border-radius:999px;background:#22c55e;flex:none}',
    '.title{font-weight:600;font-size:14px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pill{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:500;padding:4px 9px;border-radius:999px;',
    '  background:#eef2ff;color:#4f46e5;transition:background .15s ease}',
    '.pill:hover{background:#e0e7ff}',
    '.pill svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '.flash{font-size:11px;color:#16a34a;white-space:nowrap;opacity:0;transition:opacity .3s ease}',
    '.flash.on{opacity:1}',
    '.iconbtn{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#71717a;flex:none}',
    '.iconbtn:hover{background:#f4f4f5;color:#18181b}',
    '.iconbtn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '.msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#fff}',
    '.msg{display:flex}',
    '.msg.user{justify-content:flex-end}',
    '.bubble{max-width:82%;padding:9px 12px;border-radius:14px;line-height:1.45;white-space:pre-wrap;word-break:break-word;font-size:14px}',
    '.msg.bot .bubble{background:#f4f4f5;color:#18181b;border-bottom-left-radius:4px}',
    '.msg.user .bubble{background:var(--accent,#2563eb);color:#fff;border-bottom-right-radius:4px}',
    '.dots{display:flex;gap:4px;padding:4px 2px}',
    '.dots i{width:6px;height:6px;border-radius:999px;background:#a1a1aa;animation:blink 1.2s infinite}',
    '.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}',
    '@keyframes blink{0%,80%,100%{opacity:.3}40%{opacity:1}}',
    '.inputrow{display:flex;gap:8px;padding:10px;border-top:1px solid #f4f4f5;background:#fff}',
    '.inputrow input{flex:1;min-width:0;height:40px;border-radius:10px;border:1px solid #e4e4e7;padding:0 12px;font:inherit;outline:none}',
    '.inputrow input:focus{border-color:var(--accent,#2563eb)}',
    '.send{width:40px;height:40px;border-radius:10px;background:var(--accent,#2563eb);color:#fff;display:flex;align-items:center;justify-content:center;flex:none}',
    '.send:disabled{opacity:.5;cursor:default}',
    '.send svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    // Drawer
    '.drawer{position:absolute;inset:0;background:#fff;display:flex;flex-direction:column;transform:translateX(105%);',
    '  transition:transform .22s ease;z-index:2}',
    '.drawer.on{transform:none}',
    '.dhead{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #f4f4f5;background:#fafafa}',
    '.dhead .title{font-weight:600;font-size:14px}',
    '.dcount{font-size:11px;color:#71717a;font-weight:400}',
    '.dbody{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#fff}',
    '.card{border:1px solid #e4e4e7;border-radius:12px;padding:10px 12px}',
    '.cardtop{display:flex;align-items:center;gap:6px;margin-bottom:6px}',
    '.badge{font-size:10px;font-weight:600;padding:2px 8px;border-radius:999px;text-transform:capitalize}',
    '.cat-profile{background:#e0f2fe;color:#0369a1}.cat-preference{background:#dcfce7;color:#15803d}',
    '.cat-context{background:#fef3c7;color:#a16207}.cat-constraint{background:#ffe4e6;color:#be123c}',
    '.cardtext{font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word}',
    '.cardbtns{display:flex;gap:2px;margin-top:6px}',
    '.cardbtn{font-size:11px;color:#71717a;padding:3px 7px;border-radius:6px}',
    '.cardbtn:hover{background:#f4f4f5;color:#18181b}',
    '.cardbtn.del:hover{background:#ffe4e6;color:#be123c}',
    '.card textarea{width:100%;min-height:56px;border:1px solid #e4e4e7;border-radius:8px;padding:6px 8px;font:inherit;font-size:13px;resize:vertical;outline:none}',
    '.card textarea:focus{border-color:var(--accent,#2563eb)}',
    '.card select{font:inherit;font-size:12px;border:1px solid #e4e4e7;border-radius:8px;padding:4px 6px;background:#fff}',
    '.mini{display:flex;gap:6px;align-items:center}',
    '.mini .ok{background:var(--accent,#2563eb);color:#fff;border-radius:8px;padding:5px 10px;font-size:12px}',
    '.addrow{border:1px dashed #d4d4d8;border-radius:12px;padding:10px 12px}',
    '.addrow input,.addrow textarea{width:100%;border:1px solid #e4e4e7;border-radius:8px;padding:6px 8px;font:inherit;font-size:13px;outline:none;resize:vertical}',
    '.empty{color:#71717a;font-size:13px;text-align:center;padding:24px 12px}',
    '.hint{font-size:11px;color:#a1a1aa;text-align:center;padding:8px;border-top:1px solid #f4f4f5}',
    '.badge+.badge{margin-left:0}',
  ].join('\n')

  var ICONS = {
    chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H4l2.2-2.6A8 8 0 1 1 21 12z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    brain: '<svg viewBox="0 0 24 24"><path d="M12 5a3 3 0 1 0-3 3 3 3 0 0 0-3 8 3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0-3-8 3 3 0 1 0-3-3z"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" width="11" height="11" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
  }

  function icon(name) {
    var span = el('span')
    span.innerHTML = ICONS[name]
    return span.firstChild
  }

  // ——— API ———

  function api(path, init) {
    return fetch(base + path, {
      method: init && init.method ? init.method : 'GET',
      headers: { 'content-type': 'application/json' },
      body: init && init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + res.status)
        return data
      })
    })
  }

  // ——— Build the UI ———

  var host = document.createElement('div')
  host.style.position = 'relative'
  host.style.zIndex = '2147483000'
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host
  var style = el('style')
  style.textContent = CSS
  root.appendChild(style)

  var launcher = el('button', 'launcher')
  launcher.setAttribute('aria-label', 'Open chat')
  launcher.appendChild(icon('chat'))

  var panel = el('div', 'panel')
  var head = el('div', 'head')
  head.appendChild(el('span', 'dot'))
  var title = el('span', 'title', '…')
  head.appendChild(title)
  var flash = el('span', 'flash', 'Memory updated')
  head.appendChild(flash)
  var memoryPill = el('button', 'pill')
  memoryPill.appendChild(icon('brain'))
  memoryPill.appendChild(el('span', null, 'Memory'))
  var closeBtn = el('button', 'iconbtn')
  closeBtn.setAttribute('aria-label', 'Close chat')
  closeBtn.appendChild(icon('close'))
  head.appendChild(memoryPill)
  head.appendChild(closeBtn)

  var msgs = el('div', 'msgs')
  var inputrow = el('div', 'inputrow')
  var input = el('input')
  input.type = 'text'
  input.placeholder = 'Type a message…'
  var send = el('button', 'send')
  send.setAttribute('aria-label', 'Send')
  send.appendChild(icon('send'))
  inputrow.appendChild(input)
  inputrow.appendChild(send)

  var drawer = el('div', 'drawer')
  var dhead = el('div', 'dhead')
  var backBtn = el('button', 'iconbtn')
  backBtn.setAttribute('aria-label', 'Back to chat')
  backBtn.appendChild(icon('back'))
  var dtitle = el('span', 'title', 'Memory ')
  var dcount = el('span', 'dcount')
  dtitle.appendChild(dcount)
  var addToggle = el('button', 'iconbtn')
  addToggle.setAttribute('aria-label', 'Add memory')
  addToggle.appendChild(icon('plus'))
  dhead.appendChild(backBtn)
  dhead.appendChild(dtitle)
  dhead.appendChild(addToggle)
  var dbody = el('div', 'dbody')
  var dhint = el('div', 'hint', 'Saved facts are recalled in every reply. Edit anything that is wrong or outdated.')
  drawer.appendChild(dhead)
  drawer.appendChild(dbody)
  drawer.appendChild(dhint)

  panel.appendChild(head)
  panel.appendChild(msgs)
  panel.appendChild(inputrow)
  panel.appendChild(drawer)
  root.appendChild(launcher)
  root.appendChild(panel)
  document.body.appendChild(host)

  // ——— Chat ———

  var typingRow = null

  function scrollDown() {
    msgs.scrollTop = msgs.scrollHeight
  }

  function showTyping() {
    typingRow = el('div', 'msg bot')
    var b = el('div', 'bubble')
    var dots = el('div', 'dots')
    dots.appendChild(el('i'))
    dots.appendChild(el('i'))
    dots.appendChild(el('i'))
    b.appendChild(dots)
    typingRow.appendChild(b)
    msgs.appendChild(typingRow)
    scrollDown()
  }

  function hideTyping() {
    if (typingRow && typingRow.parentNode) typingRow.parentNode.removeChild(typingRow)
    typingRow = null
  }

  function flashMemoryUpdated() {
    flash.classList.add('on')
    setTimeout(function () {
      flash.classList.remove('on')
    }, 2500)
  }

  function sendDisabled(on) {
    send.disabled = on
  }

  function sendCurrent() {
    var text = input.value.trim()
    if (!text || send.disabled) return
    msgs.appendChild(bubble('user', text))
    input.value = ''
    scrollDown()
    sendDisabled(true)
    showTyping()
    api('/api/widget/chat', { method: 'POST', body: { botId: botId, visitorId: visitor, message: text } })
      .then(function (data) {
        hideTyping()
        msgs.appendChild(bubble('bot', data.reply || '…'))
        scrollDown()
        if (state.config && state.config.memoryEnabled) {
          flashMemoryUpdated()
        }
      })
      .catch(function (err) {
        hideTyping()
        msgs.appendChild(bubble('bot', err && err.message === 'rate limited'
          ? 'You are sending messages very quickly. Please wait a minute and try again.'
          : 'Sorry, something went wrong. Please try again in a moment.'))
        scrollDown()
      })
      .then(function () {
        sendDisabled(false)
        input.focus()
      })
  }

  send.addEventListener('click', sendCurrent)
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      sendCurrent()
    }
  })

  // ——— Memory drawer ———

  var CATEGORIES = ['profile', 'preference', 'context', 'constraint']

  function refreshMemories() {
    return api('/api/widget/memories?botId=' + encodeURIComponent(botId) + '&visitorId=' + encodeURIComponent(visitor))
      .then(function (data) {
        state.memories = data.items || []
        renderMemories()
      })
      .catch(function () {
        state.memories = []
        renderMemories()
      })
  }

  function memoryCard(m) {
    var card = el('div', 'card')
    var top = el('div', 'cardtop')
    top.appendChild(badge(m.category))
    card.appendChild(top)
    if (state.editingId === m.id) {
      var ta = el('textarea')
      ta.value = m.content
      var sel = el('select')
      CATEGORIES.forEach(function (c) {
        var opt = el('option', null, c)
        opt.value = c
        if (c === m.category) opt.selected = true
        sel.appendChild(opt)
      })
      var row = el('div', 'mini')
      var saveBtn = el('button', 'cardbtn ok', 'Save')
      var cancelBtn = el('button', 'cardbtn', 'Cancel')
      row.appendChild(saveBtn)
      row.appendChild(cancelBtn)
      card.appendChild(sel)
      card.appendChild(ta)
      card.appendChild(row)
      saveBtn.addEventListener('click', function () {
        var content = ta.value.trim()
        if (!content) return
        api('/api/widget/memories/' + encodeURIComponent(m.id) + '?botId=' + encodeURIComponent(botId) + '&visitorId=' + encodeURIComponent(visitor), {
          method: 'PATCH',
          body: { content: content, category: sel.value },
        }).then(function () {
          state.editingId = null
          return refreshMemories()
        })
      })
      cancelBtn.addEventListener('click', function () {
        state.editingId = null
        renderMemories()
      })
      return card
    }
    card.appendChild(el('div', 'cardtext', m.content))
    var btns = el('div', 'cardbtns')
    var editBtn = el('button', 'cardbtn', 'Edit')
    editBtn.appendChild(icon('pencil'))
    var delBtn = el('button', 'cardbtn del', 'Delete')
    editBtn.addEventListener('click', function () {
      state.editingId = m.id
      state.adding = false
      renderMemories()
    })
    delBtn.addEventListener('click', function () {
      api('/api/widget/memories/' + encodeURIComponent(m.id) + '?botId=' + encodeURIComponent(botId) + '&visitorId=' + encodeURIComponent(visitor), {
        method: 'DELETE',
      }).then(refreshMemories)
    })
    btns.appendChild(editBtn)
    btns.appendChild(delBtn)
    card.appendChild(btns)
    return card
  }

  function addForm() {
    var wrap = el('div', 'addrow')
    var ta = el('textarea')
    ta.placeholder = 'One concise fact, e.g. I prefer replies in English.'
    var row = el('div', 'mini')
    row.style.marginTop = '6px'
    var sel = el('select')
    CATEGORIES.forEach(function (c) {
      var opt = el('option', null, c)
      opt.value = c
      if (c === 'context') opt.selected = true
      sel.appendChild(opt)
    })
    var saveBtn = el('button', 'cardbtn ok', 'Save')
    var cancelBtn = el('button', 'cardbtn', 'Cancel')
    row.appendChild(sel)
    row.appendChild(saveBtn)
    row.appendChild(cancelBtn)
    wrap.appendChild(ta)
    wrap.appendChild(row)
    saveBtn.addEventListener('click', function () {
      var content = ta.value.trim()
      if (!content) return
      api('/api/widget/memories?botId=' + encodeURIComponent(botId) + '&visitorId=' + encodeURIComponent(visitor), {
        method: 'POST',
        body: { content: content, category: sel.value },
      }).then(function () {
        state.adding = false
        return refreshMemories()
      })
    })
    cancelBtn.addEventListener('click', function () {
      state.adding = false
      renderMemories()
    })
    return wrap
  }

  function renderMemories() {
    dbody.innerHTML = ''
    dcount.textContent = '(' + state.memories.length + ')'
    if (state.adding) {
      dbody.appendChild(addForm())
    }
    if (!state.memories.length && !state.adding) {
      dbody.appendChild(el('div', 'empty', 'Nothing saved about you yet. Chat for a while, or add a fact yourself.'))
      return
    }
    // Newest first, matching what the bot recalls.
    var sorted = state.memories.slice().sort(function (a, b) {
      return a.updated_at < b.updated_at ? 1 : -1
    })
    sorted.forEach(function (m) {
      dbody.appendChild(memoryCard(m))
    })
  }

  function openDrawer() {
    state.drawer = true
    state.editingId = null
    drawer.classList.add('on')
    refreshMemories()
  }

  function closeDrawer() {
    state.drawer = false
    drawer.classList.remove('on')
  }

  memoryPill.addEventListener('click', function () {
    if (state.drawer) closeDrawer()
    else openDrawer()
  })
  backBtn.addEventListener('click', closeDrawer)
  addToggle.addEventListener('click', function () {
    state.adding = !state.adding
    state.editingId = null
    renderMemories()
  })

  // ——— Open / close ———

  function setPanel(open) {
    state.open = open
    panel.classList.toggle('on', open)
    if (open) {
      if (!state.sent) {
        state.sent = true
        msgs.appendChild(bubble('bot', state.config && state.config.greeting ? state.config.greeting : 'Hi! How can we help you today?'))
        scrollDown()
      }
      input.focus()
    } else {
      closeDrawer()
    }
  }

  launcher.addEventListener('click', function () {
    setPanel(!state.open)
  })
  closeBtn.addEventListener('click', function () {
    setPanel(false)
  })

  // ——— Boot: load config, then adjust the chrome ———

  api('/api/widget/config?botId=' + encodeURIComponent(botId))
    .then(function (config) {
      state.config = config
      title.textContent = config.title || 'Support'
      launcher.style.background = config.color || '#2563eb'
      if (!config.memoryEnabled) {
        memoryPill.style.display = 'none'
        flash.style.display = 'none'
      }
    })
    .catch(function () {
      title.textContent = 'Support'
      memoryPill.style.display = 'none'
      flash.style.display = 'none'
      msgs.appendChild(bubble('bot', 'This assistant is currently unavailable.'))
    })
})()
