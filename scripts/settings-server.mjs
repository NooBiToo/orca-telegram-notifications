// Локальный сервер настроек Telegram Notifications.
// Два способа запуска:
//   1) CLI:  node scripts/configure.mjs  — поднимает и открывает браузер
//   2) из воркера плагина: startSettingsServer({...})
// Слушает только 127.0.0.1; конфиг пишет в профиль пользователя
// (~/.orca-plugin-config/telegram-notifications.json), либо, с --local,
// в config.json рядом с манифестом (dev-режим).
// Страница локализована (RU/EN, переключатель в шапке), оформление
// повторяет интерфейс Orca: тёмная/светлая тема по системной настройке.

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOCAL_CONFIG = join(ROOT, 'config.json')
const USER_CONFIG = join(
  process.env.USERPROFILE || process.env.HOME || '.',
  '.orca-plugin-config',
  'telegram-notifications.json'
)

const COMMON_STATES = ['done', 'attention', 'stuck', 'error', 'waiting', 'needs', 'working', 'idle']

// ---- i18n -----------------------------------------------------------------

const T = {
  en: {
    title: 'Telegram Notifications · settings',
    header: 'Telegram Notifications',
    subtitle: 'Get a Telegram message when an agent changes status.',
    secBot: 'Bot',
    labelToken: 'Bot token',
    hintToken: 'from <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> → /newbot, format <code>123456789:AAA…</code>',
    labelChat: 'Chat ID',
    hintChat: 'your own id: message <code>@userinfobot</code>; channel: <code>@channelname</code>',
    btnChats: 'Find bot chats',
    chatsHint: 'Send any message to your bot, then click — the chat_id fills in automatically',
    chatsEmpty: 'Nothing yet. Send any message to your bot (or /start) and try again.',
    chatsErr: 'Error: ',
    secWhen: 'When to notify',
    hintStates: 'Statuses send a message when they contain at least one checked word (case-insensitive)',
    labelCustom: 'Custom keywords',
    hintCustom: 'comma-separated, added to the checked ones',
    labelWt: 'Only these workspaces',
    hintWt: 'comma-separated; empty — all. A status counts if the workspace name contains a word',
    labelQuiet: 'Pause between repeats, seconds',
    chkAll: 'notify on any status',
    chkSilent: 'silent delivery',
    chkDry: 'dry run (don’t send)',
    chkPane: 'show agent pane',
    labelLang: 'Message language',
    btnSave: 'Save',
    btnTest: 'Send test message',
    footPre: 'Config file: ',
    footPost: '. Orca picks it up automatically (30s cache), no restart needed. The server listens on 127.0.0.1 only and closes with the worker.',
    msgSavedOk: '✅ Saved. Orca picks up the config automatically (30s cache).',
    msgTestOk: '✅ Telegram accepted the message — check your chat',
    msgTestFail: '❌ Telegram error: ',
    msgFill: 'Fill in the bot token and chat ID',
    msgWarnPrefix: 'Saved. Note: '
  },
  ru: {
    title: 'Telegram Notifications · настройки',
    header: 'Telegram Notifications',
    subtitle: 'Сообщение в Telegram при смене статуса агента.',
    secBot: 'Бот',
    labelToken: 'Токен бота',
    hintToken: 'создать: <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> → /newbot, вид <code>123456789:AAA…</code>',
    labelChat: 'Chat ID',
    hintChat: 'свой id — спросить у <code>@userinfobot</code>; канал — <code>@channelname</code>',
    btnChats: 'Найти чаты бота',
    chatsHint: 'напишите своему боту любое сообщение и нажмите — chat_id подставится сам',
    chatsEmpty: 'Пока пусто. Напишите своему боту любое сообщение (или /start) и нажмите снова.',
    chatsErr: 'Ошибка: ',
    secWhen: 'Когда уведомлять',
    hintStates: 'статус уходит в Telegram, если содержит хотя бы одно отмеченное слово (без учёта регистра)',
    labelCustom: 'Свои ключевые слова',
    hintCustom: 'через запятую, добавляются к отмеченным',
    labelWt: 'Только эти воркспейсы',
    hintWt: 'через запятую; пусто — все. Статус учитывается, если имя воркспейса содержит слово',
    labelQuiet: 'Пауза между повторами, секунд',
    chkAll: 'слать на любой статус',
    chkSilent: 'беззвучно',
    chkDry: 'dryRun (не отправлять)',
    chkPane: 'показывать панель агента',
    labelLang: 'Язык сообщений',
    btnSave: 'Сохранить',
    btnTest: 'Тест отправки',
    footPre: 'Файл конфига: ',
    footPost: '. Orca подхватывает его автоматически (кэш 30 секунд), перезапуск не нужен. Сервер слушает только 127.0.0.1 и закрывается вместе с воркером.',
    msgSavedOk: '✅ Сохранено. Orca подхватит конфиг автоматически (кэш 30 секунд).',
    msgTestOk: '✅ Telegram принял сообщение — проверьте чат',
    msgTestFail: '❌ Ошибка Telegram: ',
    msgFill: 'Заполните токен и chat ID',
    msgWarnPrefix: 'Сохранено. Замечание: '
  }
}

// ---- форма ------------------------------------------------------------------

function readConfig() {
  for (const path of [USER_CONFIG, LOCAL_CONFIG]) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // нет файла или не читается — пробуем следующий источник
    }
  }
  return {}
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

function parseForm(body) {
  const out = {}
  for (const pair of String(body).split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=')
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
    const value = decodeURIComponent(rawValue.replace(/\+/g, ' '))
    out[key] = key.endsWith('[]') ? [...(out[key] ?? []), value] : value
  }
  return out
}

function buildConfig(fields) {
  const checked = Array.isArray(fields['states[]']) ? fields['states[]'] : []
  const custom = String(fields.statesCustom ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const states = [...new Set([...checked, ...custom])]
  const worktrees = String(fields.worktrees ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return {
    botToken: (fields.botToken ?? '').trim(),
    chatId: (fields.chatId ?? '').trim(),
    language: fields.language === 'ru' ? 'ru' : 'en',
    states,
    worktrees,
    notifyOnAll: fields.notifyOnAll === 'on',
    quietSeconds: Math.max(0, Math.floor(Number(fields.quietSeconds) || 60)),
    silent: fields.silent === 'on',
    dryRun: fields.dryRun === 'on',
    showPane: fields.showPane === 'on'
  }
}

function validate(config) {
  if (!config.botToken) return 'Token is missing / Токен не задан'
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken))
    return 'Token format looks off (expected 123456789:AAA…) — the test will still be sent / Формат токена странный — тест всё равно уйдёт'
  if (!config.chatId) return 'Chat ID is missing / Chat ID не задан'
  return null
}

async function runTest(config) {
  const mod = await import('file:///' + join(ROOT, 'main.mjs').replace(/\\/g, '/'))
  const normalized = mod.normalizeConfig(config)
  return mod.sendTelegram(
    { ...normalized, dryRun: false },
    mod.buildMessage(normalized, {
      state: 'done',
      worktreeId: 'setup-test',
      paneKey: 'settings-page',
      receivedAt: Date.now()
    })
  )
}

async function fetchChats(token) {
  if (typeof fetch !== 'function') return { error: 'no fetch in runtime' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      signal: controller.signal
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.ok !== true) {
      return { error: body.description || `HTTP ${response.status}` }
    }
    const chats = new Map()
    for (const update of body.result ?? []) {
      const msg = update.message ?? update.channel_post
      const chat = msg?.chat
      if (!chat) continue
      chats.set(String(chat.id), {
        id: String(chat.id),
        title:
          chat.title ??
          chat.username ??
          [chat.first_name, chat.last_name].filter(Boolean).join(' ') ??
          String(chat.id),
        type: chat.type
      })
    }
    return { chats: [...chats.values()] }
  } catch (error) {
    return { error: error?.name === 'AbortError' ? 'timeout 10s' : String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

// ---- страница ---------------------------------------------------------------

function page(config, configFile, message = null) {
  const stateBoxes = COMMON_STATES.map((s) => {
    const on = (config.states ?? []).includes(s)
    return `<label class="chip"><input type="checkbox" name="states[]" value="${s}" ${on ? 'checked' : ''}> ${s}</label>`
  }).join('')
  const known = COMMON_STATES
  const custom = (config.states ?? []).filter((s) => !known.includes(s)).join(', ')
  const showPane = config.showPane !== false
  const msgHtml = message
    ? `<div class="msg ${message.kind}" data-i18n-msg="${message.key}">${esc(message.detail ?? '')}</div>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Telegram Notifications</title>
<style>
  :root {
    --bg: #131316; --card: #1b1b1f; --border: #2b2b31; --text: #e4e4e7;
    --muted: #8f8f99; --accent: #4f7cff; --input: #101014;
    --ok-bg: #142a1c; --ok-tx: #7ee2a8; --err-bg: #33191c; --err-tx: #ffa1a1;
    --code-bg: #26262c; --link: #7ea2ff;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f7f7f8; --card: #ffffff; --border: #e2e2e6; --text: #232326;
      --muted: #71717a; --accent: #2563eb; --input: #ffffff;
      --ok-bg: #dcfce7; --ok-tx: #14532d; --err-bg: #fee2e2; --err-tx: #7f1d1d;
      --code-bg: #ececf0; --link: #2563eb;
    }
  }
  * { box-sizing: border-box; }
  body { font: 13.5px/1.55 system-ui, sans-serif; max-width: 640px; margin: 0 auto;
         padding: 28px 16px 40px; color: var(--text); background: var(--bg); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px;
          flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; }
  .subtitle { color: var(--muted); margin: 2px 0 14px; }
  .lang { display: flex; gap: 4px; }
  .lang button { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border);
                 background: var(--card); color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; }
  .lang button.active { color: var(--text); border-color: var(--accent); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px;
          padding: 14px 16px 16px; margin-bottom: 14px; }
  .section { text-transform: uppercase; letter-spacing: .08em; font-size: 11px;
             color: var(--muted); margin: 0 0 10px; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  .hint { font-weight: 400; color: var(--muted); font-size: 12.5px; }
  .hint a { color: var(--link); }
  input[type=text], input[type=password], input[type=number], select {
    width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
    font: inherit; background: var(--input); color: var(--text);
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  .row { display: flex; gap: 16px; align-items: center; margin: 12px 0 2px; flex-wrap: wrap; }
  .row label { margin: 0; font-weight: 400; display: flex; gap: 6px; align-items: center; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 2px; }
  .chip { margin: 0; font-weight: 400; display: flex; gap: 5px; align-items: center;
          border: 1px solid var(--border); border-radius: 999px; padding: 5px 12px;
          cursor: pointer; background: var(--input); }
  button.primary { padding: 9px 18px; border: 0; border-radius: 8px; font: inherit;
                   cursor: pointer; background: var(--accent); color: #fff; }
  button.ghost { padding: 9px 18px; border: 1px solid var(--border); border-radius: 8px;
                 font: inherit; cursor: pointer; background: var(--card); color: var(--text); }
  #chats button { margin: 4px 6px 4px 0; background: var(--input); color: var(--text);
                  border: 1px solid var(--border); padding: 6px 10px; }
  .msg { padding: 10px 12px; border-radius: 8px; margin: 0 0 14px; white-space: pre-wrap;
         font-weight: 500; }
  .msg.ok { background: var(--ok-bg); color: var(--ok-tx); }
  .msg.err { background: var(--err-bg); color: var(--err-tx); }
  code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  a { color: var(--link); }
  .foot { color: var(--muted); font-size: 12.5px; margin-top: 16px; }
</style>
</head>
<body>
<div class="head">
  <h1 data-i18n="header">${esc(T.en.header)}</h1>
  <div class="lang">
    <button type="button" data-lang="ru">RU</button>
    <button type="button" data-lang="en">EN</button>
  </div>
</div>
<p class="subtitle" data-i18n="subtitle">${esc(T.en.subtitle)}</p>
${msgHtml}
<form method="POST" action="/save">
  <div class="card">
    <p class="section" data-i18n="secBot">${esc(T.en.secBot)}</p>
    <label data-i18n="labelToken">${esc(T.en.labelToken)}</label>
    <div class="hint" data-i18n-html="hintToken">${T.en.hintToken}</div>
    <input type="password" id="botToken" name="botToken" value="${esc(config.botToken)}" autocomplete="off">
    <label data-i18n="labelChat">${esc(T.en.labelChat)}</label>
    <div class="hint" data-i18n-html="hintChat">${T.en.hintChat}</div>
    <input type="text" id="chatId" name="chatId" value="${esc(config.chatId)}" autocomplete="off">
    <div class="row">
      <button type="button" class="ghost" id="findChats" data-i18n="btnChats">${esc(T.en.btnChats)}</button>
      <span class="hint" data-i18n="chatsHint">${esc(T.en.chatsHint)}</span>
    </div>
    <div id="chats" class="hint"></div>
  </div>

  <div class="card">
    <p class="section" data-i18n="secWhen">${esc(T.en.secWhen)}</p>
    <div class="chips">${stateBoxes}</div>
    <div class="hint" data-i18n="hintStates">${esc(T.en.hintStates)}</div>
    <label data-i18n="labelCustom">${esc(T.en.labelCustom)}</label>
    <div class="hint" data-i18n="hintCustom">${esc(T.en.hintCustom)}</div>
    <input type="text" name="statesCustom" value="${esc(custom)}">
    <label data-i18n="labelWt">${esc(T.en.labelWt)}</label>
    <div class="hint" data-i18n="hintWt">${esc(T.en.hintWt)}</div>
    <input type="text" name="worktrees" value="${esc((config.worktrees ?? []).join(', '))}">
    <label data-i18n="labelQuiet">${esc(T.en.labelQuiet)}</label>
    <input type="number" name="quietSeconds" value="${esc(config.quietSeconds ?? 60)}" min="0">
    <div class="row">
      <label><input type="checkbox" name="notifyOnAll" ${config.notifyOnAll ? 'checked' : ''}> <span data-i18n="chkAll">${esc(T.en.chkAll)}</span></label>
      <label><input type="checkbox" name="silent" ${config.silent ? 'checked' : ''}> <span data-i18n="chkSilent">${esc(T.en.chkSilent)}</span></label>
      <label><input type="checkbox" name="dryRun" ${config.dryRun ? 'checked' : ''}> <span data-i18n="chkDry">${esc(T.en.chkDry)}</span></label>
      <label><input type="checkbox" name="showPane" ${showPane ? 'checked' : ''}> <span data-i18n="chkPane">${esc(T.en.chkPane)}</span></label>
    </div>
    <label data-i18n="labelLang">${esc(T.en.labelLang)}</label>
    <select name="language">
      <option value="en" ${config.language !== 'ru' ? 'selected' : ''}>English</option>
      <option value="ru" ${config.language === 'ru' ? 'selected' : ''}>Русский</option>
    </select>
  </div>

  <div class="row">
    <button type="submit" class="primary" data-i18n="btnSave">${esc(T.en.btnSave)}</button>
    <button type="submit" class="ghost" formaction="/test" formmethod="post" data-i18n="btnTest">${esc(T.en.btnTest)}</button>
  </div>
</form>
<p class="foot"><span data-i18n="footPre">${esc(T.en.footPre)}</span><code>${esc(configFile)}</code><span data-i18n="footPost">${esc(T.en.footPost)}</span></p>
<script>
  'use strict'
  var T = ${JSON.stringify(T)}
  function initialLang() {
    var saved = localStorage.getItem('tgNotifLang')
    if (saved === 'ru' || saved === 'en') return saved
    return (navigator.language || '').toLowerCase().indexOf('ru') === 0 ? 'ru' : 'en'
  }
  var lang = initialLang()
  function applyLang(next) {
    lang = next
    localStorage.setItem('tgNotifLang', next)
    document.documentElement.lang = next
    document.title = T[next].title
    var nodes = document.querySelectorAll('[data-i18n]')
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = T[next][nodes[i].getAttribute('data-i18n')]
    var htmls = document.querySelectorAll('[data-i18n-html]')
    for (var j = 0; j < htmls.length; j++) htmls[j].innerHTML = T[next][htmls[j].getAttribute('data-i18n-html')]
    var msg = document.querySelector('[data-i18n-msg]')
    if (msg) {
      var key = msg.getAttribute('data-i18n-msg')
      var detail = msg.textContent
      var base = T[next][key] || key
      msg.textContent = (key === 'msgTestFail' || key === 'msgWarnPrefix') ? base + detail : base
    }
    var buttons = document.querySelectorAll('.lang button')
    for (var k = 0; k < buttons.length; k++)
      buttons[k].classList.toggle('active', buttons[k].getAttribute('data-lang') === next)
  }
  applyLang(lang)
  var langButtons = document.querySelectorAll('.lang button')
  for (var b = 0; b < langButtons.length; b++) {
    langButtons[b].addEventListener('click', function (event) {
      applyLang(event.currentTarget.getAttribute('data-lang'))
    })
  }

  document.getElementById('findChats').addEventListener('click', async function () {
    var out = document.getElementById('chats')
    out.textContent = '…'
    try {
      var response = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: document.getElementById('botToken').value.trim() })
      })
      var data = await response.json()
      if (data.error) { out.textContent = T[lang].chatsErr + data.error; return }
      if (!data.chats.length) { out.textContent = T[lang].chatsEmpty; return }
      out.innerHTML = ''
      data.chats.forEach(function (chat) {
        var button = document.createElement('button')
        button.type = 'button'
        button.textContent = chat.id + ' · ' + chat.title + ' (' + chat.type + ')'
        button.addEventListener('click', function () {
          document.getElementById('chatId').value = chat.id
        })
        out.appendChild(button)
      })
    } catch (error) {
      out.textContent = T[lang].chatsErr + error
    }
  })
</script>
</body>
</html>`
}

export async function startSettingsServer(options = {}) {
  const portStart = options.portStart ?? 8791
  const portEnd = options.portEnd ?? 8799
  const writeLocal = options.writeLocal === true
  const CONFIG_FILE = writeLocal ? LOCAL_CONFIG : USER_CONFIG

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page(readConfig(), CONFIG_FILE))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk

    if (req.url === '/api/chats') {
      let token = ''
      try {
        token = JSON.parse(body).token ?? ''
      } catch {
        // пустой токен — вернём ошибку от API
      }
      const result = await fetchChats(token)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }

    const fields = parseForm(body)
    const config = buildConfig(fields)

    if (req.url === '/test') {
      if (!config.botToken || !config.chatId) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page({ ...readConfig(), ...config }, CONFIG_FILE, { kind: 'err', key: 'msgFill' }))
        return
      }
      const result = await runTest(config)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        page(
          { ...readConfig(), ...config },
          CONFIG_FILE,
          result.ok
            ? { kind: 'ok', key: 'msgTestOk' }
            : { kind: 'err', key: 'msgTestFail', detail: result.error }
        )
      )
      return
    }

    // /save
    const warning = validate(config)
    mkdirSync(dirname(CONFIG_FILE), { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      page(
        config,
        CONFIG_FILE,
        warning
          ? { kind: 'err', key: 'msgWarnPrefix', detail: warning }
          : { kind: 'ok', key: 'msgSavedOk' }
      )
    )
  })

  const browse = (target = url) => {
    if (process.platform !== 'win32') return
    import('node:child_process').then(({ spawn }) => {
      spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref()
    })
  }

  const url = await new Promise((resolve, reject) => {
    let lastError = null
    const tryPort = (port) => {
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError)
        resolve(`http://127.0.0.1:${port}`)
      })
      function onError(error) {
        server.off('error', onError)
        lastError = error
        if (port < portEnd) tryPort(port + 1)
        else reject(lastError)
      }
    }
    tryPort(portStart)
  })

  if (options.autoOpen) browse(url)

  return {
    url,
    browse,
    close() {
      // Без closeAllConnections/closeIdleConnections: на Windows libuv
      // падает ассертом при выходе, если сокет уже в состоянии CLOSING.
      // Незакрытые keep-alive соединения дохнут сами по таймауту.
      return new Promise((resolve) => server.close(resolve))
    }
  }
}
