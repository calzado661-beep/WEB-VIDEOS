import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { grantQuizAttempt, listManagedUsers, listVideoQuizResults } from './lib/videoHubApi'
import { getQuizAttemptState } from './learningRules'

export default function QuizAttemptsManager({ videoId, maxAttempts }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyUser, setBusyUser] = useState(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    Promise.all([listManagedUsers(), listVideoQuizResults(videoId)])
      .then(([users, results]) => {
        if (!active) return
        const byId = new Map(users.map((user) => [user.userId, user]))
        setRows(results.map((result) => ({ ...result, user: byId.get(result.userId) })))
      })
      .catch((failure) => { if (active) setError(failure.message || 'No se pudieron cargar los intentos.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [videoId, refreshKey])

  const grant = useCallback(async (row) => {
    if (busyUser) return
    setBusyUser(row.userId)
    setMessage('')
    setError('')
    try {
      const updated = await grantQuizAttempt(videoId, row.userId)
      setRows((current) => current.map((item) => item.userId === row.userId ? { ...item, ...updated } : item))
      setMessage(`Se habilitó un intento adicional para ${row.user?.displayName || row.user?.username || 'este usuario'} en este cuestionario.`)
    } catch (failure) {
      setError(failure.message || 'No se pudo habilitar el intento.')
    } finally {
      setBusyUser(null)
    }
  }, [busyUser, videoId])

  const filtered = rows.filter((row) => `${row.user?.displayName || ''} ${row.user?.username || ''}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <section className="quiz-attempt-management" aria-label="Intentos de este cuestionario">
      <header><div><h3>Intentos por usuario</h3><p>Habilita un intento adicional cuando el usuario haya agotado los disponibles. Su historial se conserva.</p></div><button className="icon-button" type="button" aria-label="Actualizar intentos" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading || Boolean(busyUser)}><RefreshCw size={16} /></button></header>
      <input className="quiz-attempt-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nombre o usuario…" aria-label="Buscar usuario en este cuestionario" />
      {loading ? <p>Cargando intentos…</p> : filtered.map((row) => {
        const state = getQuizAttemptState({ maxAttempts }, row)
        return <div className="quiz-attempt-user" key={row.userId}>
          <div><strong>{row.user?.displayName || row.user?.username || 'Usuario'}</strong><small>{row.user?.username} · {state.used} intentos realizados · {state.passed ? 'Aprobado' : `${state.remaining} disponibles`}</small></div>
          <button className="secondary-button" type="button" disabled={Boolean(busyUser) || !state.exhausted || state.passed || !row.user?.active} onClick={() => grant(row)}><Plus size={14} />{busyUser === row.userId ? 'Habilitando…' : 'Habilitar 1 intento'}</button>
        </div>
      })}
      {!loading && !filtered.length && <p>{query ? 'No hay resultados para esa búsqueda.' : 'Todavía no hay intentos registrados en este cuestionario.'}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="quiz-saved-note" role="status">{message}</p>}
    </section>
  )
}
