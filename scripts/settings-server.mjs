// Локальный сервер настроек Telegram Notifications.
// Используется двумя способами:
//   1) CLI:  node scripts/configure.mjs  — поднимает и открывает браузер
//   2) из воркера плагина: startSettingsServer({...}) — авто-подсказка
// Слушает только 127.0.0.1; пишет конфиг в профиль пользователя
// (~/.orca-plugin-config/telegram-notifications.json), либо, с --local,
// в config.json рядом с манифестом (dev-режим).

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
    states,
    worktrees,
    notifyOnAll: fields.notifyOnAll === 'on',
    quietSeconds: Math.max(0, Math.floor(Number(fields.quietSeconds) || 60)),
    silent: fields.silent === 'on',
    dryRun: fields.dryRun === 'on'
  }
}

function validate(config) {
  if (!config.botToken) return 'Токен не задан'
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken))
    return 'Токен не похож на формат Telegram (ожидается 123456789:AAA…) — отправка всё равно будет выполнена'
  if (!config.chatId) return 'Chat ID не задан'
  return null
}

async function runTest(config) {
  const mod = await import('file:///' + join(ROOT, 'main.mjs').replace(/\\/g, '/'))
  const result = await mod.sendTelegram(
    { ...mod.normalizeConfig(config), dryRun: false },
    '✅ Тест из Orca: плагин Telegram Notifications работает'
  )
  return result
}

async function fetchChats(token) {
  if (typeof fetch !== 'function') return { error: 'нет fetch в рантайме' }
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
        title: chat.title ?? chat.username ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ') ?? String(chat.id),
        type: chat.type
      })
    }
    return { chats: [...chats.values()] }
  } catch (error) {
    return { error: error?.name === 'AbortError' ? 'таймаут 10с' : String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

function page(config, configFile, message = '', messageKind = '') {
  const msgHtml = message ? `<div class="msg ${messageKind}">${esc(message)}</div>` : ''
  const stateBoxes = COMMON_STATES.map((s) => {
    const on = (config.states ?? []).includes(s)
    return `<label class="chip"><input type="checkbox" name="states[]" value="${s}" ${on ? 'checked' : ''}> ${s}</label>`
  }).join('')
  const known = COMMON_STATES
  const custom = (config.states ?? []).filter((s) => !known.includes(s)).join(', ')
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Telegram Notifications · настройки</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; max-width: 620px; margin: 32px auto; padding: 0 16px;
         color: #222; background: #fafafa; }
  h1 { font-size: 18px; }
  h2 { font-size: 14px; margin: 22px 0 6px; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  .hint { font-weight: 400; color: #777; font-size: 12.5px; }
  input[type=text], input[type=password], input[type=number] {
    width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #ccc;
    border-radius: 6px; font: inherit; background: #fff;
  }
  .row { display: flex; gap: 16px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
  .row label { margin: 0; font-weight: 400; display: flex; gap: 6px; align-items: center; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0; }
  .chip { margin: 0; font-weight: 400; display: flex; gap: 5px; align-items: center;
          border: 1px solid #ddd; border-radius: 999px; padding: 5px 12px; cursor: pointer; background: #fff; }
  button { padding: 9px 18px; border: 0; border-radius: 6px; font: inherit; cursor: pointer;
           background: #2563eb; color: #fff; }
  button.ghost { background: #e5e7eb; color: #222; }
  .msg { padding: 10px 12px; border-radius: 6px; margin: 12px 0; white-space: pre-wrap; }
  .msg.ok { background: #dcfce7; color: #14532d; }
  .msg.err { background: #fee2e2; color: #7f1d1d; }
  code { background: #eee; padding: 1px 5px; border-radius: 4px; }
  #chats button { margin: 4px 6px 4px 0; background: #eef2ff; color: #3730a3; padding: 6px 10px; }
  fieldset { border: 1px solid #e2e2e2; border-radius: 8px; margin: 0 0 8px; }
</style>
</head>
<body>
<h1>Telegram Notifications · настройки</h1>
${msgHtml}
<form method="POST" action="/save">
  <label>Токен бота <span class="hint">создать бота: <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> → /newbot, вид <code>123456789:AAA…</code></span>
    <input type="password" id="botToken" name="botToken" value="${esc(config.botToken)}" placeholder="123456789:AAA…" autocomplete="off">
  </label>

  <label>Chat ID
    <input type="text" id="chatId" name="chatId" value="${esc(config.chatId)}" placeholder="123456789 или @channelname" autocomplete="off">
  </label>
  <div class="row">
    <button type="button" class="ghost" id="findChats">Найти чаты бота</button>
    <span class="hint">напишите своему боту любое сообщение и нажмите — chat_id подставится сам</span>
  </div>
  <div id="chats" class="hint"></div>

  <h2>Когда уведомлять</h2>
  <div class="chips">${stateBoxes}</div>
  <label>Свои ключевые слова <span class="hint">через запятую; статус уходит в Telegram, если содержит хотя бы одно слово (без учёта регистра)</span>
    <input type="text" name="statesCustom" value="${esc(custom)}" placeholder="например: waiting, review">
  </label>
  <div class="row">
    <label><input type="checkbox" name="notifyOnAll" ${config.notifyOnAll ? 'checked' : ''}> слать на любой статус</label>
  </div>
  <label>Только эти воркспейсы <span class="hint">через запятую; пусто — все. Статус учитывается, если имя воркспейса содержит слово</span>
    <input type="text" name="worktrees" value="${esc((config.worktrees ?? []).join(', '))}" placeholder="gt-backend, client-frontend">
  </label>
  <label>Пауза между повторами, секунд
    <input type="number" name="quietSeconds" value="${esc(config.quietSeconds ?? 60)}" min="0">
  </label>
  <div class="row">
    <label><input type="checkbox" name="silent" ${config.silent ? 'checked' : ''}> беззвучно</label>
    <label><input type="checkbox" name="dryRun" ${config.dryRun ? 'checked' : ''}> dryRun (не отправлять)</label>
  </div>
  <div class="row">
    <button type="submit">Сохранить</button>
    <button type="submit" class="ghost" formaction="/test" formmethod="post">Тест отправки</button>
  </div>
</form>
<p class="hint">Файл конфига: <code>${esc(configFile)}</code>. Orca подхватывает его
автоматически (кэш до 30 секунд), перезапуск не нужен. Сервер слушает только
<code>127.0.0.1</code> и закроется вместе с воркером — страница просто перестанет
отвечать после настройки.</p>
<script>
  document.getElementById('findChats').addEventListener('click', async function () {
    var out = document.getElementById('chats')
    out.textContent = 'Ищу…'
    try {
      var response = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: document.getElementById('botToken').value.trim() })
      })
      var data = await response.json()
      if (data.error) { out.textContent = 'Ошибка: ' + data.error; return }
      if (!data.chats.length) {
        out.textContent = 'Пока пусто. Напишите своему боту любое сообщение (или /start) и нажмите снова.'
        return
      }
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
      out.textContent = 'Ошибка: ' + error
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
      const problem = !config.botToken || !config.chatId ? 'Заполните токен и chat ID' : null
      if (problem) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page({ ...readConfig(), ...config }, problem, 'err'))
        return
      }
      const result = await runTest(config)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        page(
          { ...readConfig(), ...config },
          CONFIG_FILE,
          result.ok
            ? '✅ Telegram принял сообщение — проверьте чат'
            : `❌ Ошибка Telegram: ${result.error}`,
          result.ok ? 'ok' : 'err'
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
        warning ? `Сохранено. Замечание: ${warning}` : '✅ Сохранено. Orca подхватит конфиг автоматически (кэш до 30 секунд).',
        warning ? 'err' : 'ok'
      )
    )
  })

  const url = await new Promise((resolve, reject) => {
    let lastError = null
    let attempts = 0
    const tryPort = (port) => {
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError)
        resolve(`http://127.0.0.1:${port}`)
      })
      function onError(error) {
        server.off('error', onError)
        lastError = error
        attempts += 1
        if (port < portEnd) tryPort(port + 1)
        else reject(lastError)
      }
    }
    tryPort(portStart)
  })

  const browse = (target = url) => {
    if (process.platform !== 'win32') return
    import('node:child_process').then(({ spawn }) => {
      spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref()
    })
  }

  if (options.autoOpen) browse(url)

  return {
    url,
    browse,
    close() {
      server.closeIdleConnections?.()
      return new Promise((resolve) => server.close(resolve))
    }
  }
}
