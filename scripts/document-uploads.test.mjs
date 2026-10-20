import assert from 'node:assert/strict'
import test from 'node:test'
import { createDocumentUploads, uploadDocumentBatch } from '../src/documentUploads.js'

test('cada archivo recibe un título independiente sin su extensión', () => {
  const files = [{ name: 'Manual.PDF' }, { name: 'Proceso.docx' }, { name: 'Informe.doc' }]
  const entries = createDocumentUploads(files)
  assert.deepEqual(entries.map((entry) => entry.title), ['Manual', 'Proceso', 'Informe'])
  assert.equal(entries[1].file, files[1])
})

test('un fallo conserva los documentos confirmados y solo reintenta los pendientes', async () => {
  const entries = createDocumentUploads([{ name: 'Uno.pdf' }, { name: 'Dos.pdf' }, { name: 'Tres.pdf' }])
  const saved = [], calls = [], progress = []
  const result = await uploadDocumentBatch({ entries,
    upload: async (entry) => {
      calls.push(entry.title)
      if (entry.title === 'Dos') throw new Error('Conexión interrumpida')
      return { title: entry.title }
    },
    onUploaded: (document) => saved.push(document.title),
    onProgress: (current, total) => progress.push([current, total]),
  })
  assert.deepEqual(calls, ['Uno', 'Dos', 'Tres'])
  assert.deepEqual(saved, ['Uno', 'Tres'])
  assert.deepEqual(progress, [[0, 3], [1, 3], [2, 3], [3, 3]])
  assert.equal(result.uploadedCount, 2)
  assert.equal(result.failed[0].error, 'Conexión interrumpida')
  const retry = await uploadDocumentBatch({ entries: result.failed, upload: async (entry) => ({ title: entry.title }), onUploaded: (document) => saved.push(document.title) })
  assert.equal(retry.failed.length, 0)
  assert.deepEqual(saved, ['Uno', 'Tres', 'Dos'])
})

test('sube tres archivos simultáneamente y mantiene el límite hasta terminar el lote', async () => {
  const entries = createDocumentUploads(Array.from({ length: 8 }, (_, index) => ({ name: `${index}.pdf` })))
  const pending = [], saved = [], progress = []
  let active = 0, peak = 0
  const resultPromise = uploadDocumentBatch({ entries,
    upload: (entry) => new Promise((resolve) => {
      active += 1
      peak = Math.max(peak, active)
      pending.push(() => { active -= 1; resolve({ title: entry.title }) })
    }),
    onUploaded: (document) => saved.push(document.title),
    onProgress: (completed) => progress.push(completed),
  })
  assert.equal(active, 3, 'el lote comienza con tres subidas activas')
  assert.equal(saved.length, 0)
  assert.deepEqual(progress, [0], 'el progreso solo cuenta archivos procesados')
  while (pending.length) {
    pending.shift()()
    await new Promise(setImmediate)
    assert.ok(active <= 3)
  }
  const result = await resultPromise
  assert.equal(peak, 3)
  assert.equal(result.uploadedCount, 8)
  assert.deepEqual(result.failed, [])
  assert.equal(saved.length, 8)
  assert.deepEqual(progress, [0, 1, 2, 3, 4, 5, 6, 7, 8])
})
