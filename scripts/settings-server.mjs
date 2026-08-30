// Локальная веб-форма настройки: node scripts/settings-server.mjs
// Открывает http://127.0.0.1:8791, сохраняет config.json, умеет тестировать
// отправку. Только для локального доступа (bind 127.0.0.1).

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CONFIG_FILE = join(ROOT, 'config.json')
const PORT = Number(process.argv.find((a, i) => process.argv[i - 1] === '--port') ?? 8791) || 8791
const NO_OPEN = process.argv.includes('--no-open')

const FIELDS = ['botToken', 'chatId', 'states', 'notifyOnAll', 'quietSeconds', 'silent', 'dryRun']

function readConfig() {
  if (!existsSync(CONFIG_FILE)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

function page(config, message = '', messageKind = '') {
  const msgHtml = message
    ? `<div class="msg ${messageKind}">${esc(message)}</div>`
    : ''
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Telegram Notifications · настройки</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; max-width: 560px; margin: 32px auto; padding: 0 16px;
         color: #222; background: #fafafa; }
  h1 { font-size: 18px; }
  label { display: block; margin: 14px 0 4px; font-weight: 600; }
  .hint { font-weight: 400; color: #777; font-size: 12.5px; }
  input[type=text], input[type=password], input[type=number] {
    width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #ccc;
    border-radius: 6px; font: inherit; background: #fff;
  }
  .row { display: flex; gap: 16px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
  .row label { margin: 0; font-weight: 400; display: flex; gap: 6px; align-items: center; }
  button { padding: 9px 18px; border: 0; border-radius: 6px; font: inherit; cursor: pointer;
           background: #2563eb; color: #fff; }
  button.ghost { background: #e5e7eb; color: #222; }
  .msg { padding: 10px 12px; border-radius: 6px; margin: 12px 0; white-space: pre-wrap; }
  .msg.ok { background: #dcfce7; color: #14532d; }
  .msg.err { background: #fee2e2; color: #7f1d1d; }
  code { background: #eee; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<h1>Telegram Notifications · настройки</h1>
${msgHtml}
<form method="POST" action="/save">
  <label>Токен бота <span class="hint">от <code>@BotFather</code>, вид <code>123456789:AAA…</code></span>
    <input type="password" name="botToken" value="${esc(config.botToken)}" placeholder="123456789:AAA…" autocomplete="off">
  </label>
  <label>Chat ID <span class="hint">свой id — спросить у <code>@userinfobot</code>; канал — <code>@channelname</code></span>
    <input type="text" name="chatId" value="${esc(config.chatId)}" placeholder="123456789" autocomplete="off">
  </label>
  <label>Статусы для уведомлений <span class="hint">через запятую; статус агента уходит в Telegram, если содержит хотя бы одно слово</span>
    <input type="text" name="states" value="${esc(config.states ?? 'done, attention, stuck, error, waiting, needs')}">
  </label>
  <label>Пауза между повторами, секунд
    <input type="number" name="quietSeconds" value="${esc(config.quietSeconds ?? 60)}" min="0">
  </label>
  <div class="row">
    <label><input type="checkbox" name="notifyOnAll" ${config.notifyOnAll ? 'checked' : ''}> слать на любой статус</label>
    <label><input type="checkbox" name="silent" ${config.silent ? 'checked' : ''}> беззвучно</label>
    <label><input type="checkbox" name="dryRun" ${config.dryRun ? 'checked' : ''}> dryRun (не отправлять)</label>
  </div>
  <div class="row">
    <button type="submit">Сохранить</button>
    <button type="submit" class="ghost" formaction="/test" formmethod="post">Тест отправки</button>
  </div>
</form>
<p class="hint">Файл сохраняется в <code>${esc(CONFIG_FILE)}</code>.
Orca подхватывает конфиг автоматически (кэш 30 секунд), перезапуск не нужен.
Сервер слушает только <code>127.0.0.1</code> — страница недоступна из сети.</p>
</body>
</html>`
}

function parseForm(body) {
  const out = {}
  for (const pair of String(body).split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=')
    out[decodeURIComponent(rawKey.replace(/\+/g, ' '))] = decodeURIComponent(rawValue.replace(/\+/g, ' '))
  }
  return out
}

function buildConfig(fields) {
  return {
    botToken: (fields.botToken ?? '').trim(),
    chatId: (fields.chatId ?? '').trim(),
    states: String(fields.states ?? '')
      .split(/[,\n]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    notifyOnAll: fields.notifyOnAll === 'on',
    quietSeconds: Math.max(0, Math.floor(Number(fields.quietSeconds) || 60)),
    silent: fields.silent === 'on',
    dryRun: fields.dryRun === 'on'
  }
}

function validate(config) {
  if (!config.botToken) return 'Токен не задан'
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken))
    return 'Токен не похож на формат Telegram (должен быть вида 123456789:AAA…) — отправка всё равно будет выполнена'
  if (!config.chatId) return 'Chat ID не задан'
  return null
}

async function runTest(config) {
  // Динамический импорт, чтобы тестировать реальный код воркера.
  const mod = await import('file:///' + join(ROOT, 'main.mjs').replace(/\\/g, '/'))
  const cfg = mod.normalizeConfig(config)
  const result = await mod.sendTelegram({ ...cfg, dryRun: false }, '✅ Тест из Orca: плагин Telegram Notifications работает')
  return result
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page(readConfig()))
    return
  }
  if (req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    const fields = parseForm(body)

    if (req.url === '/test') {
      const config = buildConfig(fields)
      const problem = !config.botToken || !config.chatId
        ? 'Заполните токен и chat ID'
        : null
      if (problem) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page({ ...readConfig(), ...fields }, problem, 'err'))
        return
      }
      const result = await runTest(config)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        page(
          { ...readConfig(), ...fields },
          result.ok
            ? '✅ Telegram принял сообщение — проверьте чат'
            : `❌ Ошибка Telegram: ${result.error}`,
          result.ok ? 'ok' : 'err'
        )
      )
      return
    }

    // /save
    const config = buildConfig(fields)
    const warning = validate(config)
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      page(
        config,
        warning
          ? `Сохранено. Замечание: ${warning}`
          : '✅ Сохранено. Orca подхватит конфиг автоматически (кэш до 30 секунд).',
        warning ? 'err' : 'ok'
      )
    )
    return
  }
  res.writeHead(405).end()
})

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`
  console.log(`Настройки Telegram Notifications: ${url}`)
  console.log('Остановить: Ctrl+C')
  if (!NO_OPEN && process.platform === 'win32') {
    import('node:child_process').then(({ spawn }) => {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    })
  }
})
