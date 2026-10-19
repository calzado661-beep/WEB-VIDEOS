import { ROLE_META } from '../data.js'

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' })
}

const BRAND_NAVY = 'FF1B2657'
const BRAND_BLUE = 'FF2A3A84'
const HEADER_TEXT = 'FFFFFFFF'
const STRIPE_FILL = 'FFF4F1EA'
const BORDER_COLOR = 'FFE0DED6'
const GOOD_FILL = 'FFDCEFE3'
const GOOD_TEXT = 'FF1F7A4D'
const BAD_FILL = 'FFFBE4E1'
const BAD_TEXT = 'FFB23A2A'
const GOOD_VALUES = new Set(['Sí', 'Activo', 'Aprobado'])
const BAD_VALUES = new Set(['No', 'Deshabilitado', 'No aprobado'])

const THIN_BORDER = { style: 'thin', color: { argb: BORDER_COLOR } }
const CELL_BORDER = { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER }

function addStyledSheet(workbook, name, headers, rows) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  sheet.columns = headers.map((header) => ({ header, key: header }))

  rows.forEach((row) => sheet.addRow(row))

  const headerRow = sheet.getRow(1)
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_BLUE } }
    cell.font = { color: { argb: HEADER_TEXT }, bold: true }
    cell.alignment = { vertical: 'middle' }
    cell.border = { ...CELL_BORDER, bottom: { style: 'medium', color: { argb: BRAND_NAVY } } }
  })
  headerRow.height = 22

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    row.eachCell((cell) => {
      cell.border = CELL_BORDER
      if (rowNumber % 2 === 0) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STRIPE_FILL } }
      }
      const value = cell.value
      if (GOOD_VALUES.has(value)) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOOD_FILL } }
        cell.font = { color: { argb: GOOD_TEXT }, bold: true }
      } else if (BAD_VALUES.has(value)) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAD_FILL } }
        cell.font = { color: { argb: BAD_TEXT }, bold: true }
      }
    })
  }

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } }

  headers.forEach((header, index) => {
    const longest = rows.reduce((max, row) => Math.max(max, String(row[header] ?? '').length), header.length)
    sheet.getColumn(index + 1).width = Math.min(Math.max(longest + 2, 10), 50)
  })

  return sheet
}

/**
 * Arma el reporte de usuarios en 4 hojas (en vez de una hoja por usuario,
 * que con muchas cuentas se vuelve inmanejable): un resumen general, el
 * detalle de video por usuario, el historial de intentos, y la respuesta a
 * cada pregunta de cada intento — todo en formato de tabla, fácil de
 * filtrar/ordenar en Excel.
 *
 * `exceljs` se carga con import() dinámico (no al abrir la app) porque solo
 * lo necesita el administrador, al hacer clic en "Descargar Excel".
 */
export async function buildUsersWorkbook({ organization, users, videosByRole, progress, quizResults, quizAttempts }) {
  const ExcelJS = (await import('exceljs')).default

  const usersById = new Map(users.map((user) => [user.userId, user]))
  const videosById = new Map()
  Object.values(videosByRole).forEach((videos) => {
    videos.forEach((video) => videosById.set(video.id, video))
  })

  const watchedSet = new Set(
    progress.filter((row) => row.completed).map((row) => `${row.userId}:${row.videoId}`),
  )
  const quizResultByUserVideo = new Map(
    quizResults.map((row) => [`${row.userId}:${row.videoId}`, row]),
  )

  // Hoja 1 — Usuarios
  const userRows = users.map((user) => {
    const eligible = videosByRole[user.role] || []
    const quizEligible = eligible.filter((video) => video.quiz)
    const watchedCount = eligible.filter((video) => watchedSet.has(`${user.userId}:${video.id}`)).length
    const passedCount = quizEligible.filter((video) => quizResultByUserVideo.get(`${user.userId}:${video.id}`)?.passed).length
    return {
      Usuario: user.username,
      'Nombre completo': user.displayName || '',
      Rol: ROLE_META[user.role]?.label || user.role,
      Cargo: user.jobTitle || '',
      Área: user.department || '',
      Estado: user.active ? 'Activo' : 'Deshabilitado',
      'Videos asignados': eligible.length,
      'Videos vistos': watchedCount,
      '% visto': eligible.length ? Math.round((watchedCount / eligible.length) * 100) : 0,
      'Cuestionarios asignados': quizEligible.length,
      'Cuestionarios aprobados': passedCount,
      '% cuestionarios aprobados': quizEligible.length ? Math.round((passedCount / quizEligible.length) * 100) : 0,
    }
  })
  const userHeaders = ['Usuario', 'Nombre completo', 'Rol', 'Cargo', 'Área', 'Estado', 'Videos asignados', 'Videos vistos', '% visto', 'Cuestionarios asignados', 'Cuestionarios aprobados', '% cuestionarios aprobados']

  // Hoja 2 — Videos por usuario
  const videoRows = []
  users.forEach((user) => {
    const eligible = videosByRole[user.role] || []
    eligible.forEach((video) => {
      const watched = watchedSet.has(`${user.userId}:${video.id}`)
      const result = quizResultByUserVideo.get(`${user.userId}:${video.id}`)
      videoRows.push({
        Usuario: user.username,
        'Nombre completo': user.displayName || '',
        Rol: ROLE_META[user.role]?.label || user.role,
        Video: video.title,
        Visto: watched ? 'Sí' : 'No',
        'Tiene cuestionario': video.quiz ? 'Sí' : 'No',
        Intentos: result?.attemptsCount ?? 0,
        'Mejor puntaje %': result?.bestScorePercent ?? '',
        Aprobado: video.quiz ? (result?.passed ? 'Sí' : 'No') : '',
      })
    })
  })
  const videoHeaders = ['Usuario', 'Nombre completo', 'Rol', 'Video', 'Visto', 'Tiene cuestionario', 'Intentos', 'Mejor puntaje %', 'Aprobado']

  // Hoja 3 — Intentos de cuestionario
  const attemptRows = quizAttempts.map((attempt) => {
    const user = usersById.get(attempt.userId)
    const video = videosById.get(attempt.videoId)
    return {
      Usuario: user?.username || attempt.userId,
      'Nombre completo': user?.displayName || '',
      Video: video?.title || attempt.videoId,
      Intento: attempt.attemptNumber,
      'Puntaje %': attempt.scorePercent,
      Aprobado: attempt.passed ? 'Sí' : 'No',
      Fecha: formatDate(attempt.createdAt),
    }
  })
  const attemptHeaders = ['Usuario', 'Nombre completo', 'Video', 'Intento', 'Puntaje %', 'Aprobado', 'Fecha']

  // Hoja 4 — Respuestas por pregunta
  const answerRows = []
  quizAttempts.forEach((attempt) => {
    const user = usersById.get(attempt.userId)
    const video = videosById.get(attempt.videoId)
    attempt.answers.forEach((answer) => {
      answerRows.push({
        Usuario: user?.username || attempt.userId,
        'Nombre completo': user?.displayName || '',
        Video: video?.title || attempt.videoId,
        Intento: attempt.attemptNumber,
        Pregunta: answer.prompt,
        Marcó: answer.selectedLabel || 'Sin respuesta',
        '¿Acertó?': answer.isCorrect ? 'Sí' : 'No',
        'Respuesta correcta': answer.correctLabel || '',
      })
    })
  })
  const answerHeaders = ['Usuario', 'Nombre completo', 'Video', 'Intento', 'Pregunta', 'Marcó', '¿Acertó?', 'Respuesta correcta']

  const workbook = new ExcelJS.Workbook()
  workbook.creator = organization
  workbook.created = new Date()
  workbook.title = `Reporte de usuarios — ${organization}`

  addStyledSheet(workbook, 'Usuarios', userHeaders, userRows)
  addStyledSheet(workbook, 'Videos por usuario', videoHeaders, videoRows)
  addStyledSheet(workbook, 'Intentos de cuestionario', attemptHeaders, attemptRows)
  addStyledSheet(workbook, 'Respuestas por pregunta', answerHeaders, answerRows)

  return workbook
}

export async function downloadUsersExcel(options) {
  const workbook = await buildUsersWorkbook(options)
  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const today = new Date().toISOString().slice(0, 10)
  const safeOrgName = String(options.organization || 'video-hub').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `reporte-usuarios-${safeOrgName}-${today}.xlsx`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
