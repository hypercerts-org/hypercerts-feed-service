import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

const path = process.argv[2]
if (!path)
  throw new Error(
    'Supply a new env-file path, for example /tmp/maearth-spike/stack.env; existing files are never overwritten.',
  )
const keys = [
  'SPIKE_DB_PASSWORD',
  'SPIKE_READER_PASSWORD',
  'SPIKE_FIXTURE_TOKEN',
  'SPIKE_SESSION_SECRET',
  'SPIKE_ENCRYPTION_KEY',
]
await writeFile(
  path,
  keys.map((key) => `${key}=${randomBytes(32).toString('hex')}`).join('\n') +
    '\n',
  { mode: 0o600, flag: 'wx' },
)
console.log(
  `Created disposable credentials in ${path}; keep this file private.`,
)
