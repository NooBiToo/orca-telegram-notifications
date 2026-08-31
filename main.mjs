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
import { startSettingsServer } from './scripts/settings-server.mjs'

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
  const worktrees = Array.isArray(raw.worktrees)
    ? raw.worktrees.map((s) => String(s).toLowerCase()).filter(Boolean)
    : []
  return {
    botToken: typeof raw.botToken === 'string' ? raw.botToken.trim() : '',
    chatId: raw.chatId !== undefined && raw.chatId !== null ? String(raw.chatId).trim() : '',
    language: raw.language === 'ru' ? 'ru' : 'en',
    states,
    worktrees,
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

export function shouldNotify(config, state, lastMap, now = Date.now(), worktreeId = null) {
  const s = String(state ?? '').toLowerCase()
  if (!s) return { notify: false, reason: 'пустой статус' }
  if (config.worktrees.length > 0) {
    const wt = String(worktreeId ?? '').toLowerCase()
    const matched = wt && config.worktrees.some((keyword) => wt.includes(keyword))
    if (!matched) return { notify: false, reason: `воркспейс «${wt || '—'}» не в фильтре` }
  }
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

// ---- формат сообщения -----------------------------------------------------

const STATE_META = {
  done: { emoji: '✅', ru: 'Агент завершил работу', en: 'Agent finished' },
  attention: { emoji: '🙋', ru: 'Агент ждёт вашего внимания', en: 'Agent needs your attention' },
  needs: { emoji: '🙋', ru: 'Агент ждёт вашего внимания', en: 'Agent needs your attention' },
  stuck: { emoji: '⚠️', ru: 'Похоже, агент застрял', en: 'Agent looks stuck' },
  error: { emoji: '❌', ru: 'У агента ошибка', en: 'Agent hit an error' },
  waiting: { emoji: '⏳', ru: 'Агент ожидает', en: 'Agent is waiting' },
  working: { emoji: '🔧', ru: 'Агент работает', en: 'Agent is working' },
  idle: { emoji: '💤', ru: 'Агент простаивает', en: 'Agent is idle' }
}

const STATE_KEYS = ['done', 'attention', 'needs', 'stuck', 'error', 'waiting', 'working', 'idle']

export function describeState(state, language = 'en') {
  const s = String(state ?? '').toLowerCase()
  for (const key of STATE_KEYS) {
    if (s.includes(key)) {
      const meta = STATE_META[key]
      return { emoji: meta.emoji, title: meta[language] ?? meta.en }
    }
  }
  return { emoji: '🤖', title: (language === 'ru' ? 'Статус: ' : 'Status: ') + String(state ?? '') }
}

// Короткие слова для строки «Статус агента: …» — в отличие от STATE_META
// (развернутые фразы) тут именно значение статуса.
const STATUS_I18N = {
  done: { ru: 'готово', en: 'done' },
  attention: { ru: 'ждёт внимания', en: 'needs attention' },
  needs: { ru: 'ждёт внимания', en: 'needs attention' },
  stuck: { ru: 'застрял', en: 'stuck' },
  error: { ru: 'ошибка', en: 'error' },
  waiting: { ru: 'ожидает', en: 'waiting' },
  working: { ru: 'работает', en: 'working' },
  idle: { ru: 'простаивает', en: 'idle' }
}

export function localizeStatus(state, language = 'en') {
  const s = String(state ?? '').toLowerCase()
  for (const key of STATE_KEYS) {
    if (s.includes(key)) return STATUS_I18N[key][language] ?? STATUS_I18N[key].en
  }
  return String(state ?? '')
}

// ---- имена проекта и воркспейса --------------------------------------------

// worktreeId бывает двух форм: «repoId::путь» (git-воркспейсы) и «folder:id»
// (папочные). Человеческие имена лежат в сторе Orca
// profiles/<activeProfileId>/orca-data.json — читаем напрямую; это внутренний
// файл, может поменяться между версиями Orca, тогда фолбэк на имена из пути.
function userDataBases() {
  return [
    process.env.APPDATA,
    process.env.HOME ? join(process.env.HOME, 'Library', 'Application Support') : null,
    process.env.HOME ? join(process.env.HOME, '.config') : null
  ].filter(Boolean)
}

function firstReadable(paths) {
  for (const path of paths) {
    try {
      readFileSync(path)
      return path
    } catch {
      // не читается — пробуем следующий
    }
  }
  return null
}

export function orcaStatusFile() {
  return firstReadable(userDataBases().map((base) => join(base, 'orca', 'agent-hooks', 'last-status.json')))
}

let storeCache = null
let storeCacheAt = 0

export function loadOrcaStore(maxAgeMs = 10_000) {
  if (storeCache && Date.now() - storeCacheAt < maxAgeMs) return storeCache
  storeCache = null
  const indexFile = firstReadable(userDataBases().map((base) => join(base, 'orca', 'orca-profile-index.json')))
  const profileId = indexFile
    ? (() => {
        try {
          return JSON.parse(readFileSync(indexFile, 'utf8'))?.activeProfileId
        } catch {
          return null
        }
      })()
    : null
  if (indexFile && profileId) {
    try {
      storeCache = JSON.parse(readFileSync(join(dirname(indexFile), 'profiles', profileId, 'orca-data.json'), 'utf8'))
    } catch {
      storeCache = null
    }
  }
  storeCacheAt = Date.now()
  return storeCache
}

function pathBasename(path) {
  const segments = String(path ?? '').split(/[\\/]+/).filter(Boolean)
  return segments.length ? segments[segments.length - 1] : null
}

// Проект — репо или папка (базовое имя пути), воркспейс — его заголовок в
// Orca (displayName), а без него — имя папки.
export function describeWorktree(worktreeId, store = loadOrcaStore()) {
  const raw = String(worktreeId ?? '')
  if (raw.startsWith('folder:')) {
    const folder = (store?.folderWorkspaces ?? []).find((f) => f.id === raw.slice('folder:'.length))
    if (!folder?.name) return null
    return { project: pathBasename(folder.folderPath), workspace: folder.name }
  }
  const sep = raw.indexOf('::')
  const workspace = pathBasename(sep >= 0 ? raw.slice(sep + 2) : '')
  if (!workspace) return null
  const repo = (store?.repos ?? []).find((r) => r.id === raw.slice(0, sep))
  const meta = store?.worktreeMeta?.[raw]
  const title = typeof meta?.displayName === 'string' && meta.displayName.trim() ? meta.displayName.trim() : workspace
  return { project: (repo?.path && pathBasename(repo.path)) || null, workspace: title }
}

// ---- последнее сообщение агента --------------------------------------------

// Хост кладёт в plugin-payload только 4 поля события, отрезая
// lastAssistantMessage (ответ агента из хука Stop). Полный статус Orca
// персистит в userData/agent-hooks/last-status.json, а воркер — обычный
// Node-процесс, так что файл можно прочитать напрямую. Файл внутренний,
// может поменяться между версиями Orca — тогда просто не будет строки 💬.

const ASSISTANT_PREVIEW_MAX_CHARS = 700
const STATUS_READ_ATTEMPTS = 8
const STATUS_READ_DELAY_MS = 150

// Хост пишет файл с дебаунсом 250мс, поэтому ждём: запись считается свежей,
// когда её receivedAt догнал receivedAt события.
export async function readAssistantMessage(paneKey, receivedAt) {
  const path = orcaStatusFile()
  if (!path || !paneKey) return null
  for (let attempt = 0; attempt < STATUS_READ_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, STATUS_READ_DELAY_MS))
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const entry = parsed?.entries?.[paneKey]
      if (!entry || entry.receivedAt < receivedAt) continue
      const message = entry.payload?.lastAssistantMessage
      return typeof message === 'string' && message.trim() ? message.trim() : null
    } catch {
      continue
    }
  }
  return null
}

function previewLine(message) {
  const preview =
    message.length > ASSISTANT_PREVIEW_MAX_CHARS
      ? message.slice(0, ASSISTANT_PREVIEW_MAX_CHARS).trimEnd() + '…'
      : message
  return `💬 ${escHtml(preview)}`
}

function escHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Сообщение в формате Telegram HTML. Без шаблона — осмысленный дефис:
// эмодзи и человеческий заголовок по типу статуса, воркспейс, время, агент.
// config.template (опционально) — свой формат с подстановками
// {{emoji}} {{title}} {{worktree}} {{state}} {{time}} {{pane}}.
export function buildMessage(config, payload, now = Date.now()) {
  const language = config.language === 'ru' ? 'ru' : 'en'
  const { emoji, title } = describeState(payload.state, language)
  const time = formatTime(payload.receivedAt ?? now)
  const worktree = payload.worktreeId ? escHtml(payload.worktreeId) : null
  const pane = payload.paneKey ? escHtml(payload.paneKey) : null
  if (typeof config.template === 'string' && config.template.trim()) {
    return config.template
      .replaceAll('{{emoji}}', emoji)
      .replaceAll('{{title}}', escHtml(title))
      .replaceAll('{{worktree}}', worktree ?? '—')
      .replaceAll('{{state}}', escHtml(localizeStatus(payload.state, language)))
      .replaceAll('{{time}}', time)
      .replaceAll('{{pane}}', pane ?? '—')
  }
  const lines = [`${emoji} <b>${escHtml(title)}</b>`]
  if (worktree) lines.push(`📦 <code>${worktree}</code>`)
  let tail = `🕐 ${time}`
  if (pane) tail += ` · 🧠 <code>${pane}</code>`
  lines.push(tail)
  return lines.join('\n')
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
        parse_mode: 'HTML',
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

// Хранится в памяти воркера И дублируется в storage хоста: воркер может быть
// перезапущен между событиями, персистентный антидребезг переживает это.
const lastNotified = new Map()
let throttleLoaded = false
let setupHintShown = false
let setup = null // { url, browse, close }
let setupHeartbeat = null

async function loadThrottle(orca) {
  if (throttleLoaded) return lastNotified
  throttleLoaded = true
  const stored = await orca.host.call('storage.get', { key: 'lastNotify' }).catch(() => null)
  if (stored?.value && typeof stored.value === 'object') {
    const now = Date.now()
    for (const [key, at] of Object.entries(stored.value)) {
      if (typeof at === 'number' && now - at < 3_600_000) lastNotified.set(key, at)
    }
  }
  return lastNotified
}

async function saveThrottle(orca) {
  const value = Object.fromEntries(lastNotified)
  await orca.host.call('storage.set', { key: 'lastNotify', value }).catch(() => undefined)
}

function announceSetupProblem(orca, problem, url = null) {
  orca.log(`пропущено: ${problem}`)
  if (setupHintShown) return
  setupHintShown = true
  void orca.host
    .call('notifications.show', {
      title: 'Telegram Notifications не настроен',
      body: url
        ? `Откройте страницу настройки: ${url}`
        : 'Команда настройки — в логе плагина (кнопка Logs в карточке плагина).'
    })
    .catch(() => undefined)
}

// Поднимает страницу настройки прямо из воркера и держит её до 15 минут
// (воркер без активности хост гасит через 5 минут, поэтому в режиме страницы
// шлём heartbeat в лог каждые 60с). Вызывается командой open-settings
// и автоматически — когда конфиг не найден/не валиден.
async function ensureSetupServer(orca, { autoOpen = false } = {}) {
  if (setup) {
    if (autoOpen) setup.browse(setup.url)
    return setup.url
  }
  try {
    setup = await startSettingsServer({ portStart: 8791, portEnd: 8799, autoOpen })
  } catch (error) {
    orca.log(`не удалось поднять страницу настройки: ${String(error?.message ?? error)}`)
    return null
  }
  orca.log(`страница настройки: ${setup.url}`)
  const startedAt = Date.now()
  setupHeartbeat = setInterval(() => {
    if (Date.now() - startedAt > 15 * 60_000) {
      void closeSetupServer()
      orca.log('страница настройки закрыта (таймаут) — откройте заново командой')
      return
    }
    orca.log(`страница настройки активна: ${setup.url}`)
  }, 60_000)
  return setup.url
}

export async function closeSetupServer() {
  if (setupHeartbeat) {
    clearInterval(setupHeartbeat)
    setupHeartbeat = null
  }
  if (setup) {
    const closing = setup
    setup = null
    await closing.close()
  }
}

export default function activate(orca) {
  orca.commands.register('open-settings', async (args) => {
    // Из палитры args нет — открываем браузер. В тестах передают {autoOpen:false}.
    const autoOpen = args?.autoOpen !== false
    const url = await ensureSetupServer(orca, { autoOpen })
    if (!url) {
      await orca.host
        .call('notifications.show', {
          title: 'Telegram Notifications',
          body: 'Не удалось открыть страницу настройки — детали в логе плагина.'
        })
        .catch(() => undefined)
      return { ok: false }
    }
    await orca.host
      .call('notifications.show', {
        title: 'Telegram Notifications',
        body: `Страница настроек: ${url}`
      })
      .catch(() => undefined)
    return { ok: true, url }
  })

  async function handleEvent(payload) {
    const config = loadConfig()
    const problem = configProblem(config)
    if (problem) {
      const url = await ensureSetupServer(orca)
      announceSetupProblem(orca, problem, url)
      return
    }
    const throttle = await loadThrottle(orca)
    const decision = shouldNotify(config, payload.state, throttle, Date.now(), payload.worktreeId)
    if (!decision.notify) {
      orca.log(`тихо: ${decision.reason} (${payload.paneKey})`)
      return
    }
    const receivedAt = payload.receivedAt ?? Date.now()
    const when = formatTime(receivedAt)
    const language = config.language === 'ru' ? 'ru' : 'en'
    const statusLabel = language === 'ru' ? 'Статус агента' : 'Agent status'
    const quote = await readAssistantMessage(payload.paneKey, receivedAt)
    const worktree = describeWorktree(payload.worktreeId)
    const lines = [
      `🤖 Orca · ${when}`,
      `${statusLabel}: ${localizeStatus(payload.state, language)}`,
      worktree?.project ? escHtml(worktree.project) : null,
      // воркспейс-корень репо не дублирует строку проекта
      worktree?.workspace && worktree.workspace !== worktree.project
        ? `  ${escHtml(worktree.workspace)}`
        : null
    ].filter(Boolean)
    if (quote) lines.push('', previewLine(quote))
    const text = lines.join('\n')
    const result = await sendTelegram(config, text)
    if (result.ok) {
      await saveThrottle(orca)
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
      const url = await ensureSetupServer(orca, { autoOpen: true })
      const body = url
        ? `Открыта страница настройки: ${url}`
        : `Настройка: ${setupHint()}`
      await orca.host.call('notifications.show', { title: 'Telegram', body })
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
      config.worktrees.length ? `Воркспейсы: ${config.worktrees.join(', ')}` : 'Воркспейсы: все',
      `Антидребезг: ${config.quietSeconds}с · беззвучно: ${config.silent ? 'да' : 'нет'} · dryRun: ${config.dryRun ? 'да' : 'нет'}`
    ].join('\n')
    return sendTelegram(config, text)
  })

  orca.events.on('agent.status.changed', (payload) => {
    void handleEvent(payload)
  })

  orca.log('Telegram Notifications активен')
}
