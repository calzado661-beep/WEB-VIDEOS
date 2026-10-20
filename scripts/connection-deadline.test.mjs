import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchWithConnectionDeadline, withConnectionDeadline } from '../src/lib/connectionDeadline.js'

test('una sesión bloqueada termina con un error recuperable', async () => {
  await assert.rejects(withConnectionDeadline(() => new Promise(() => {}), 10, 'Reintenta la conexión'), {
    code: 'CONNECTION_TIMEOUT', message: 'Reintenta la conexión',
  })
})

test('las operaciones completadas y los errores originales se conservan', async () => {
  assert.equal(await withConnectionDeadline(() => Promise.resolve('session'), 1000, 'timeout'), 'session')
  const error = new Error('perfil inválido')
  await assert.rejects(withConnectionDeadline(() => { throw error }, 1000, 'timeout'), (value) => value === error)
})

test('un refresco de Auth bloqueado se aborta y libera la petición', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(globalThis, 'fetch', (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const request = fetchWithConnectionDeadline('https://example.test/auth/v1/token', { method: 'POST' })
  const rejection = assert.rejects(request, { name: 'TimeoutError' })
  t.mock.timers.tick(15_000)
  await rejection
})

test('se respeta la cancelación del llamador', async (t) => {
  t.mock.method(globalThis, 'fetch', (_, { signal }) => new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const controller = new AbortController()
  const request = fetchWithConnectionDeadline(new Request('https://example.test/rest/v1/videos', { signal: controller.signal }))
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
})

test('las subidas y escrituras conservan sus opciones y no reciben el límite de lectura', async (t) => {
  const options = { method: 'POST', body: 'file' }
  t.mock.method(globalThis, 'fetch', async (_, received) => {
    assert.equal(received, options)
    return new Response('ok')
  })
  assert.equal(await (await fetchWithConnectionDeadline('https://example.test/storage/v1/object/documents/file', options)).text(), 'ok')
})
