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
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]])
  assert.equal(result.uploadedCount, 2)
  assert.equal(result.failed[0].error, 'Conexión interrumpida')
  const retry = await uploadDocumentBatch({ entries: result.failed, upload: async (entry) => ({ title: entry.title }), onUploaded: (document) => saved.push(document.title) })
  assert.equal(retry.failed.length, 0)
  assert.deepEqual(saved, ['Uno', 'Tres', 'Dos'])
})
