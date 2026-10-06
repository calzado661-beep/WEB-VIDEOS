import assert from 'node:assert/strict'
import test from 'node:test'
import { getLearningBlockReason, getQuizAttemptState, validateLearningSequence, withLearningAccess } from '../src/learningRules.js'

const sections = [{ id: 's', roles: ['operator', 'boss'] }]
const video = (id, previous = null, watched = false, passed = false) => ({
  id, title: id, assignments: { operator: 's', boss: 's' },
  prerequisites: previous ? { operator: previous } : {}, watched,
  quiz: { maxAttempts: 3 }, quizResult: { passed },
})

test('videos independientes disponibles; la secuencia es por rol', () => {
  const videos = [video('one'), video('two', 'one'), video('free')]
  const result = withLearningAccess(videos, sections, 'operator')
  assert.equal(result[0].learningLocked.operator, false)
  assert.equal(result[1].learningLocked.operator, true)
  assert.equal(result[2].learningLocked.operator, false)
  assert.equal(getLearningBlockReason(videos[1], 'boss', videos, sections), '')
})

test('ver el anterior o aprobarlo por separado no basta: se exigen ambos', () => {
  for (const [watched, passed] of [[false, false], [true, false], [false, true], [true, true]]) {
    const videos = [video('one', null, watched, passed), video('two', 'one')]
    assert.equal(Boolean(getLearningBlockReason(videos[1], 'operator', videos, sections)), !(watched && passed))
  }
})

test('revisa antecesores incluso con progreso previo en videos intermedios', () => {
  const videos = [video('one'), video('two', 'one', true, true), video('three', 'two')]
  assert.match(getLearningBlockReason(videos[2], 'operator', videos, sections), /one/)
})

test('rechaza ciclos, auto referencias y requisitos ausentes', () => {
  assert.match(validateLearningSequence([video('a', 'b'), video('b', 'a')], sections), /ciclo/)
  assert.match(validateLearningSequence([video('a', 'a')], sections), /ciclo/)
  assert.match(validateLearningSequence([video('a', 'missing')], sections), /previo/)
  assert.ok(getLearningBlockReason(video('a', 'missing'), 'operator', [], sections))
})

test('ocultar la sección del requisito bloquea el acceso sin borrar la secuencia', () => {
  const videos = [video('one', null, true, true), video('two', 'one')]
  assert.ok(getLearningBlockReason(videos[1], 'operator', videos, [{ id: 's', roles: ['boss'] }]))
})

test('el cupo adicional se consume sin reiniciar intentos; admite historiales antiguos', () => {
  assert.equal(getQuizAttemptState({ maxAttempts: 3 }, { attemptsCount: 2 }).remaining, 1)
  assert.equal(getQuizAttemptState({ maxAttempts: 3 }, { attemptsCount: 3 }).exhausted, true)
  assert.equal(getQuizAttemptState({ maxAttempts: 3 }, { attemptsCount: 3, extraAttempts: 1 }).remaining, 1)
  assert.equal(getQuizAttemptState({ maxAttempts: 3 }, { attemptsCount: 4, extraAttempts: 1 }).remaining, 0)
  assert.equal(getQuizAttemptState({ maxAttempts: 3 }, { attemptsCount: 10, extraAttempts: 8 }).remaining, 1)
})
