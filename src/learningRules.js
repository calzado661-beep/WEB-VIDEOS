export const DEFAULT_QUIZ_ATTEMPTS = 3

export function getQuizAttemptState(quiz, result) {
  const limit = quiz?.maxAttempts ?? DEFAULT_QUIZ_ATTEMPTS
  const used = result?.attemptsCount || 0
  const extra = result?.extraAttempts || 0
  const remaining = Math.max(0, limit + extra - used)
  return { limit, used, extra, remaining, exhausted: remaining === 0, passed: Boolean(result?.passed) }
}

// Evaluate the entire chain: changing a prerequisite must not let older
// progress skip an incomplete ancestor. Missing content fails closed.
export function getLearningBlockReason(video, role, videos, sections) {
  const byId = new Map(videos.map((item) => [item.id, item]))
  const visibleSections = new Set(sections.filter((section) => section.roles.includes(role)).map((section) => section.id))
  const seen = new Set([video.id])
  let previousId = video.prerequisites?.[role]
  while (previousId) {
    if (seen.has(previousId)) return 'La secuencia necesita revisión del administrador.'
    seen.add(previousId)
    const previous = byId.get(previousId)
    if (!previous || !visibleSections.has(previous.assignments?.[role]) || !previous.quiz) {
      return 'El video previo no está disponible. Contacta al administrador.'
    }
    if (!previous.watched || !previous.quizResult?.passed) {
      return `Primero completa “${previous.title}” y aprueba su cuestionario.`
    }
    previousId = previous.prerequisites?.[role]
  }
  return ''
}

export function withLearningAccess(videos, sections, role) {
  return videos.map((video) => {
    const reason = getLearningBlockReason(video, role, videos, sections)
    return { ...video, learningLocked: { [role]: Boolean(reason) }, lockReasons: { [role]: reason } }
  })
}

export function validateLearningSequence(videos, sections) {
  const byId = new Map(videos.map((video) => [video.id, video]))
  for (const video of videos) {
    for (const role of ['operator', 'boss']) {
      const seen = new Set([video.id])
      let previousId = video.prerequisites?.[role]
      while (previousId) {
        if (seen.has(previousId)) return `La secuencia de “${video.title}” forma un ciclo. Elige otro video previo.`
        seen.add(previousId)
        const previous = byId.get(previousId)
        if (!previous || !previous.assignments?.[role] || !previous.quiz) {
          return `“${video.title}” necesita un video previo con cuestionario y acceso para el mismo rol.`
        }
        // A hidden section pauses its videos; it does not erase the sequence.
        if (!sections.some((section) => section.id === previous.assignments[role])) {
          return `La sección del video previo de “${video.title}” ya no existe.`
        }
        previousId = previous.prerequisites?.[role]
      }
    }
  }
  return ''
}
