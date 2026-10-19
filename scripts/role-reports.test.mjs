import assert from 'node:assert/strict'
import test from 'node:test'
import { ROLE_META, USER_ROLES } from '../src/data.js'
import { buildUsersWorkbook } from '../src/lib/exportUsersExcel.js'

function records(sheet) {
  const headers = sheet.getRow(1).values
  return Array.from({ length: sheet.rowCount - 1 }, (_, index) => Object.fromEntries(headers.slice(1).map((header, column) => [header, sheet.getRow(index + 2).getCell(column + 1).value])))
}

test('el Excel incluye los cinco roles con sus nombres y porcentajes reales', async () => {
  const users = USER_ROLES.map((role) => ({ userId: role, username: role, role, active: true }))
  const video = { id: 'video', title: 'Video', quiz: { questionCount: 1 } }
  const workbook = await buildUsersWorkbook({ organization: 'Demo', users, videosByRole: Object.fromEntries(USER_ROLES.map((role) => [role, [video]])), progress: [{ userId: 'salesperson', videoId: 'video', completed: true }], quizResults: [], quizAttempts: [] })
  const rows = records(workbook.getWorksheet('Usuarios'))
  assert.deepEqual(rows.map((row) => row.Rol), USER_ROLES.map((role) => ROLE_META[role].label))
  assert.equal(rows.find((row) => row.Usuario === 'salesperson')['% visto'], 100)
  assert.equal(rows.find((row) => row.Usuario === 'management')['% visto'], 0)
  assert.equal(records(workbook.getWorksheet('Videos por usuario')).length, USER_ROLES.length)
})

test('exportar una selección conserva su historial y excluye el de usuarios filtrados', async () => {
  const users = [{ userId: 'seller', username: 'venta', role: 'salesperson', active: true }]
  const catalog = [{ id: 'old', title: 'Curso anterior' }, { id: 'new', title: 'Curso actual' }]
  const attempt = { userId: 'seller', videoId: 'old', attemptNumber: 1, scorePercent: 100, passed: true, answers: [{ prompt: 'Pregunta', selectedLabel: 'Sí', isCorrect: true }] }
  const workbook = await buildUsersWorkbook({ organization: 'Demo', users, videos: catalog, videosByRole: { salesperson: [catalog[1]] }, progress: [], quizResults: [], quizAttempts: [attempt, { ...attempt, userId: 'excluded' }] })
  assert.equal(records(workbook.getWorksheet('Usuarios')).length, 1)
  for (const name of ['Intentos de cuestionario', 'Respuestas por pregunta']) {
    const rows = records(workbook.getWorksheet(name))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].Rol, 'Vendedores')
    assert.equal(rows[0].Video, 'Curso anterior')
    assert.equal(rows[0].Usuario, 'venta')
  }
})
