// CLI: открывает интерфейс настройки Telegram Notifications.
// node scripts/configure.mjs [--port N] [--local] [--no-open]
import { startSettingsServer } from './settings-server.mjs'

const portStart = Number(process.argv.find((a, i) => process.argv[i - 1] === '--port') ?? 8791) || 8791
const writeLocal = process.argv.includes('--local')
const autoOpen = !process.argv.includes('--no-open')

const server = await startSettingsServer({ portStart, writeLocal, autoOpen })
console.log(`Настройки Telegram Notifications: ${server.url}`)
console.log('Конфиг:', writeLocal ? 'config.json рядом с манифестом' : 'профиль пользователя (~/.orca-plugin-config/)')
console.log('Остановить: Ctrl+C')
