// Локальная обкатка логики воркера без Orca: подставляем stub-объект orca
// и прогоняем сценарии. Запуск: node scripts/test-local.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// Изолируем «дом» — loadConfig/resolution читает USERPROFILE/HOME на вызов.
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'tg-home-'))
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME

let failures = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`)
  if (!cond) failures++
}

// Изолированная песочница: копия main.mjs + свой config.json на сценарий.
function stageWorker(dir) {
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  copyFileSync(join(root, 'main.mjs'), join(dir, 'main.mjs'))
  copyFileSync(join(root, 'scripts', 'settings-server.mjs'), join(dir, 'scripts', 'settings-server.mjs'))
}

function freshWorker(config) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-plugin-'))
  stageWorker(dir)
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  return import(pathToFileURL(join(dir, 'main.mjs')).href)
}

// 1. shouldNotify: фильтр статусов и антидребезг
{
  const { shouldNotify, normalizeConfig } = await freshWorker({
    botToken: 'x', chatId: '1',
    states: ['done', 'attention', 'stuck'],
    quietSeconds: 60
  })
  const cfg = normalizeConfig({ botToken: 'x', chatId: '1', states: ['done', 'attention', 'stuck'], quietSeconds: 60 })
  const last = new Map()
  const t = Date.now()
  check('done — шлём', shouldNotify(cfg, 'done', last, t).notify === true)
  check('done повтор сразу — гасится', shouldNotify(cfg, 'done', last, t + 1000).notify === false)
  check('done после паузы — шлём', shouldNotify(cfg, 'done', last, t + 61_000).notify === true)
  check('attention (substring attention) — шлём', shouldNotify(cfg, 'needs-attention', last, t).notify === true)
  check('working — молчим', shouldNotify(cfg, 'working', last, t).notify === false)
  const cfgAll = normalizeConfig({ botToken: 'x', chatId: '1', notifyOnAll: true })
  check('notifyOnAll — шлём любой', shouldNotify(cfgAll, 'working', new Map(), t).notify === true)
  check('пустой статус — молчим', shouldNotify(cfg, '', new Map(), t).notify === false)
  const cfgWt = normalizeConfig({ botToken: 'x', chatId: '1', states: ['done'], worktrees: ['gt-'] })
  check('фильтр воркспейсов: совпал — шлём', shouldNotify(cfgWt, 'done', new Map(), t, 'gt-backend/fix').notify === true)
  check('фильтр воркспейсов: не совпал — молчим', shouldNotify(cfgWt, 'done', new Map(), t, 'other/x').notify === false)
  check('фильтр воркспейсов: null id — молчим', shouldNotify(cfgWt, 'done', new Map(), t, null).notify === false)
  check('без фильтра null id — шлём', shouldNotify(cfg, 'done', new Map(), t, null).notify === true)
}

// 2. normalizeConfig: дефолты и типы
{
  const { normalizeConfig } = await freshWorker({ botToken: 'x', chatId: '1' })
  const cfg = normalizeConfig({})
  check('дефолтные статусы подставлены', Array.isArray(cfg.states) && cfg.states.includes('done'))
  check('quietSeconds дефолт 60', cfg.quietSeconds === 60)
  check('chatId приводится к строке', normalizeConfig({ chatId: 42 }).chatId === '42')
  check('notifyOnAll по умолчанию false', cfg.notifyOnAll === false)
}

// 3. configProblem: отсутствующий/битый файл, без токена
{
  const dir = mkdtempSync(join(tmpdir(), 'tg-plugin-'))
  stageWorker(dir)
  // config.json намеренно не пишем, HOME пустой
  const { loadConfig, configProblem } = await import(
    pathToFileURL(join(dir, 'main.mjs')).href
  )
  const missing = loadConfig(0)
  check('нет config.json — проблема описана', (configProblem(missing) || '').includes('не найден'))
}

// 3б. Пользовательский конфиг ~/.orca-plugin-config — приоритетный источник
{
  const dir = mkdtempSync(join(tmpdir(), 'tg-plugin-'))
  stageWorker(dir)
  const userDir = join(FAKE_HOME, '.orca-plugin-config')
  mkdirSync(userDir, { recursive: true })
  writeFileSync(
    join(userDir, 'telegram-notifications.json'),
    JSON.stringify({ botToken: 'user:token', chatId: '777' })
  )
  const { loadConfig } = await import(pathToFileURL(join(dir, 'main.mjs')).href)
  const cfg = loadConfig(0)
  check(
    'пользовательский конфиг найден вне папки плагина',
    cfg.botToken === 'user:token' && cfg.chatId === '777'
  )
}

// 4. Полный activate с dryRun: команды + событие, stub orca
{
  // Своя пустая «домашняя» папка, чтобы пользовательский конфиг из 3б не мешал
  process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'tg-home-'))
  process.env.HOME = process.env.USERPROFILE
  const dir = mkdtempSync(join(tmpdir(), 'tg-plugin-'))
  stageWorker(dir)
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ botToken: 'x', chatId: '1', dryRun: true, quietSeconds: 0 })
  )
  const mod = await import(pathToFileURL(join(dir, 'main.mjs')).href)

  const logs = []
  const notifications = []
  const storageWrites = []
  const handlers = {}
  const commands = {}
  const orca = {
    log: (line) => logs.push(line),
    events: { on: (name, handler) => { handlers[name] = handler } },
    commands: { register: (id, handler) => { commands[id] = handler } },
    host: {
      call: async (method, params) => {
        if (method === 'notifications.show') notifications.push(params)
        if (method === 'storage.set') storageWrites.push(params)
        if (method === 'storage.get') return { value: null }
        return { ok: true }
      }
    }
  }
  mod.default(orca)

  check('подписан на agent.status.changed', typeof handlers['agent.status.changed'] === 'function')
  check('зарегистрированы обе команды', commands['send-test'] && commands['send-summary'])

  const testResult = await commands['send-test']()
  check('send-test ok (dryRun)', testResult.ok === true && testResult.dryRun === true)
  check('send-test показал уведомление', notifications.some((n) => (n.body || '').includes('dryRun')))

  handlers['agent.status.changed']({ worktreeId: 'wt-1', paneKey: 'pane-9', state: 'done', receivedAt: Date.now() })
  await new Promise((r) => setTimeout(r, 80))
  check('событие done дошло до лога отправки', logs.some((l) => l.includes('отправлено в Telegram: done')))
  check('антидребезг сохранён в storage', storageWrites.some((w) => w.key === 'lastNotify' && w.value && typeof w.value.done === 'number'))

  const summary = await commands['send-summary']()
  check('send-summary ok', summary.ok === true)
}

// 5. Реальная сеть выключена по умолчанию: sendTelegram без dryRun против
//    фейкового токена вернёт ошибку от Telegram (нужен интернет).
{
  const { sendTelegram, normalizeConfig } = await freshWorker({ botToken: 'x', chatId: '1' })
  const cfg = normalizeConfig({ botToken: '1:fake', chatId: '1', dryRun: false })
  const result = await sendTelegram(cfg, 'ping')
  check('фейковый токен — ошибка от Telegram API', result.ok === false, JSON.stringify(result))
}

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
