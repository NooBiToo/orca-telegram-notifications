// Orca plugin worker: Telegram notifications on agent.status.changed.
// Runs as a plain Node child process (ELECTRON_RUN_AS_NODE), so node:*
// modules and global fetch are available. The capability gate covers only
// the orca.host bridge, not the Node stdlib.
//
// Конфиг читается из двух мест (первый найденный):
//   1. ~/.orca-plugin-config/telegram-notifications.json  — пользовательский
//      (главный для установки из git: папка плагина неизменяема, хост
//      проверяет её хеш — правки внутри сломают проверку целостности)
//   2. config.json рядом с main.mjs                       — удобно в dev
// Поля:
//   botToken   — токен @BotFather (обязательно)
//   chatId     — id чата/канала или "@channelname" (обязательно)
//   states     — ключевые слова фильтра статусов
//   notifyOnAll, quietSeconds, silent, dryRun

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
const LOCAL_CONFIG_FILE = join(PLUGIN_ROOT, 'config.json')
const SERVER_FILE = join(PLUGIN_ROOT, 'scripts', 'settings-server.mjs')

const DEFAULT_STATES = ['done', 'attention', 'stuck', 'error', 'waiting', 'needs']
const QUIET_DEFAULT_SECONDS = 60
const FETCH_TIMEOUT_MS = 10_000

// ---- конфиг ---------------------------------------------------------------

export function configPaths() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const userLevel = home
    ? join(home, '.orca-plugin-config', 'telegram-notifications.json')
    : null
  return { userLevel, local: LOCAL_CONFIG_FILE, server: SERVER_FILE }
}

export function setupHint() {
  return `node "${configPaths().server}"`
}

let cachedConfig = null
let cachedAt = 0

export function loadConfig(maxAgeMs = 30_000) {
  if (cachedConfig && Date.now() - cachedAt < maxAgeMs) return cachedConfig
  const { userLevel, local } = configPaths()
  for (const path of [userLevel, local].filter(Boolean)) {
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      continue // файла нет — пробуем следующий путь
    }
    try {
      cachedConfig = { ...normalizeConfig(JSON.parse(raw)), __source: path }
    } catch (error) {
      cachedConfig = { __invalid: `${path}: ${String(error)}` }
    }
    cachedAt = Date.now()
    return cachedConfig
  }
  cachedConfig = { __missing: true }
  cachedAt = Date.now()
  return cachedConfig
}

export function normalizeConfig(raw) {
  const states = Array.isArray(raw.states)
    ? raw.states.map((s) => String(s).toLowerCase()).filter(Boolean)
    : DEFAULT_STATES
  return {
    botToken: typeof raw.botToken === 'string' ? raw.botToken.trim() : '',
    chatId: raw.chatId !== undefined && raw.chatId !== null ? String(raw.chatId).trim() : '',
    states,
    notifyOnAll: raw.notifyOnAll === true,
    quietSeconds:
      Number.isFinite(raw.quietSeconds) && raw.quietSeconds >= 0
        ? Math.floor(raw.quietSeconds)
        : QUIET_DEFAULT_SECONDS,
    silent: raw.silent === true,
    dryRun: raw.dryRun === true
  }
}

export function configProblem(config) {
  if (config.__missing)
    return `конфиг не найден. Настройка: ${setupHint()}`
  if (config.__invalid) return `конфиг не читается: ${config.__invalid}`
  if (!config.botToken) return 'не задан botToken (токен от @BotFather)'
  if (!config.chatId) return 'не задан chatId'
  return null
}

// ---- решение «слать или нет» ---------------------------------------------

export function shouldNotify(config, state, lastMap, now = Date.now()) {
  const s = String(state ?? '').toLowerCase()
  if (!s) return { notify: false, reason: 'пустой статус' }
  const matched = config.notifyOnAll || config.states.some((keyword) => s.includes(keyword))
  if (!matched) return { notify: false, reason: `статус «${s}» не в списке` }
  const key = state
  const last = lastMap.get(key) ?? 0
  const quietMs = config.quietSeconds * 1000
  if (now - last < quietMs) {
    return { notify: false, reason: `антидребезг (<${config.quietSeconds}с для «${s}»)` }
  }
  lastMap.set(key, now)
  return { notify: true, reason: `статус «${s}»` }
}

// ---- Telegram -------------------------------------------------------------

export async function sendTelegram(config, text) {
  if (config.dryRun) {
    return { ok: true, dryRun: true, text }
  }
  if (typeof fetch !== 'function') {
    return { ok: false, error: 'в этом рантайме нет global fetch' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        silent: config.silent,
        disable_web_page_preview: true
      }),
      signal: controller.signal
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.ok !== true) {
      const description = body.description || `HTTP ${response.status}`
      return { ok: false, error: description }
    }
    return { ok: true }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'таймаут 10с' : String(error?.message ?? error)
    return { ok: false, error: reason }
  } finally {
    clearTimeout(timer)
  }
}

// ---- время ----------------------------------------------------------------

export function formatTime(ts) {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

// ---- активация ------------------------------------------------------------

// Хранится в памяти воркера; пережить рефORK не критично — антидребезг
// только гасит повторы, а не теряет события.
const lastNotified = new Map()
let setupHintShown = false

function announceSetupProblem(orca, problem) {
  orca.log(`пропущено: ${problem}`)
  if (setupHintShown) return
  setupHintShown = true
  void orca.host
    .call('notifications.show', {
      title: 'Telegram Notifications не настроен',
      body: 'Точная команда настройки — в логе плагина (кнопка Logs в карточке плагина).'
    })
    .catch(() => undefined)
}

export default function activate(orca) {
  async function handleEvent(payload) {
    const config = loadConfig()
    const problem = configProblem(config)
    if (problem) {
      announceSetupProblem(orca, problem)
      return
    }
    const decision = shouldNotify(config, payload.state, lastNotified)
    if (!decision.notify) {
      orca.log(`тихо: ${decision.reason} (${payload.paneKey})`)
      return
    }
    const when = formatTime(payload.receivedAt ?? Date.now())
    const text = [
      `🤖 Orca · ${when}`,
      `Статус агента: ${payload.state}`,
      payload.worktreeId ? `Воркспейс: ${payload.worktreeId}` : null,
      `Панель: ${payload.paneKey}`
    ]
      .filter(Boolean)
      .join('\n')
    const result = await sendTelegram(config, text)
    if (result.ok) {
      orca.log(`отправлено в Telegram: ${payload.state} (${payload.paneKey})`)
    } else {
      orca.log(`ошибка отправки: ${result.error}`)
      await orca.host
        .call('notifications.show', {
          title: 'Telegram Notifications',
          body: `Не удалось отправить: ${result.error}`
        })
        .catch(() => undefined)
    }
  }

  orca.commands.register('send-test', async () => {
    const config = loadConfig(0)
    const problem = configProblem(config)
    if (problem) {
      await orca.host.call('notifications.show', { title: 'Telegram', body: problem })
      return { ok: false, error: problem }
    }
    const result = await sendTelegram(config, '✅ Тест из Orca: плагин Telegram Notifications работает')
    const body = result.ok
      ? result.dryRun
        ? 'dryRun: сообщение напечатано в лог воркера'
        : 'Тестовое сообщение отправлено'
      : `Ошибка: ${result.error}`
    await orca.host.call('notifications.show', { title: 'Telegram', body })
    if (result.ok && result.dryRun) orca.log(`[dryRun] ${result.text}`)
    return result
  })

  orca.commands.register('send-summary', async () => {
    const config = loadConfig(0)
    const problem = configProblem(config)
    if (problem) return { ok: false, error: problem }
    const text = [
      '⚙️ Telegram Notifications · конфиг',
      `Статусы: ${config.notifyOnAll ? 'все' : config.states.join(', ')}`,
      `Антидребезг: ${config.quietSeconds}с · беззвучно: ${config.silent ? 'да' : 'нет'} · dryRun: ${config.dryRun ? 'да' : 'нет'}`
    ].join('\n')
    return sendTelegram(config, text)
  })

  orca.events.on('agent.status.changed', (payload) => {
    void handleEvent(payload)
  })

  orca.log('Telegram Notifications активен')
}
