import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const token = process.env.FIXTURE_TOKEN
if (!token)
  throw new Error(
    'FIXTURE_TOKEN is required; set a disposable token in the Compose env file.',
  )
const clients = new Set()
const events = []

function send(socket, opcode, payload) {
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4)
  header[0] = 0x80 | opcode
  header[1] = payload.length < 126 ? payload.length : 126
  if (header.length === 4) header.writeUInt16BE(payload.length, 2)
  socket.write(Buffer.concat([header, payload]))
}

function deliver(client, event) {
  if (client.wanted.has(event.commit.collection)) {
    send(client.socket, 1, Buffer.from(JSON.stringify(event)))
  }
}

const server = createServer(async (request, response) => {
  const reply = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  if (request.url === '/health') return reply(200, { ok: true })
  if (request.url === '/status')
    return reply(200, {
      collections: [
        ...new Set([...clients].flatMap((client) => [...client.wanted])),
      ],
      events: events.length,
    })
  if (request.url !== '/events' || request.method !== 'POST')
    return reply(404, { error: 'not found' })
  if (request.headers.authorization !== `Bearer ${token}`)
    return reply(401, { error: 'unauthorized' })
  try {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 1_048_576)
        throw new Error('Fixture body exceeds 1 MiB; split the event batch.')
      chunks.push(chunk)
    }
    const batch = JSON.parse(Buffer.concat(chunks).toString())
    if (
      !Array.isArray(batch) ||
      batch.some(
        (event) => event.kind !== 'commit' || !event.commit?.collection,
      )
    ) {
      throw new Error(
        'Expected an array of Jetstream commit events; correct the fixture batch.',
      )
    }
    for (const event of batch) {
      events.push(event)
      for (const client of clients) deliver(client, event)
    }
    reply(202, { accepted: batch.length })
  } catch (error) {
    reply(400, { error: error.message })
  }
})

server.on('upgrade', (request, socket) => {
  const url = new URL(request.url, 'http://mock')
  const key = request.headers['sec-websocket-key']
  if (url.pathname !== '/subscribe' || typeof key !== 'string')
    return socket.destroy()
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  const client = {
    socket,
    wanted: new Set(url.searchParams.getAll('wantedCollections')),
  }
  clients.add(client)
  socket.once('close', () => clients.delete(client))
  socket.on('error', () => clients.delete(client))
  // HappyView's client may ping; process masked control frames incrementally.
  let pending = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 2) {
      const size = pending[1] & 0x7f
      const masked = (pending[1] & 0x80) !== 0
      if (size > 125) return socket.destroy()
      const offset = masked ? 6 : 2
      if (pending.length < offset + size) return
      const payload = Buffer.from(pending.subarray(offset, offset + size))
      if (masked)
        for (let index = 0; index < size; index++)
          payload[index] ^= pending[2 + (index % 4)]
      const opcode = pending[0] & 0x0f
      pending = pending.subarray(offset + size)
      if (opcode === 9) send(socket, 10, payload)
      if (opcode === 8) return socket.end()
    }
  })
  for (const event of events) deliver(client, event)
})
server.listen(8080, '0.0.0.0')
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    for (const client of clients) client.socket.destroy()
    server.close(() => process.exit(0))
  })
