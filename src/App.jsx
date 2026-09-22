import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import VimeoPlayer from '@vimeo/player'
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  BriefcaseBusiness,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  ClipboardCheck,
  ClipboardList,
  Clock3,
  Download,
  Eye,
  EyeOff,
  Film,
  FileText,
  FolderCog,
  Home,
  ImageIcon,
  KeyRound,
  Layers3,
  LayoutDashboard,
  Lightbulb,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  UploadCloud,
  User,
  UsersRound,
  Video,
  X,
} from 'lucide-react'
import { ROLE_META } from './data'
import {
  createUser,
  deleteVideoQuiz,
  getAdminVideoQuiz,
  getCurrentAccessContext,
  getCurrentSession,
  getPlayableVideoQuiz,
  getQuizAttemptPhotoUrl,
  listAllQuizAttempts,
  listManagedUsers,
  listQuizAttemptsForUser,
  listVideoQuizResults,
  listWatchProgress,
  loadVideoHubSnapshot,
  loginWithCredentials as authenticateWithCredentials,
  onAuthStateChange,
  queueDriveVideoImports,
  recordVideoProgress,
  getSectionDocumentViewUrl,
  saveAdminSnapshot,
  saveVideoQuiz,
  setSectionContentType,
  signOut,
  submitVideoQuizAttempt,
  updateUser,
  uploadQuizAttemptPhoto,
} from './lib/videoHubApi'
import { createAdminSaveRevisionTracker } from './lib/adminSaveRevision'
import { downloadUsersExcel } from './lib/exportUsersExcel'
import DocumentsManager from './DocumentsManager'
import {
  getSourceAccent,
  getThumbnailSeekTime,
  getVideoSource,
  getVideoThumbnailUrl,
  parseDurationSeconds,
  resolveVideoThumbnail,
} from './videoUtils'

const EMPTY_DATA = {
  organization: 'Almacén de Remates',
  organizationId: '',
  settings: null,
  sections: [],
  videos: [],
  documents: [],
}
const SAVE_DELAY_MS = 700

const ICONS = {
  home: Home,
  layers: Layers3,
  shield: ShieldCheck,
  briefcase: BriefcaseBusiness,
  sparkles: Sparkles,
  book: BookOpen,
  film: Film,
  lightbulb: Lightbulb,
}

const SECTION_ICON_OPTIONS = [
  { value: 'layers', label: 'Capas' },
  { value: 'shield', label: 'Seguridad' },
  { value: 'briefcase', label: 'Trabajo' },
  { value: 'sparkles', label: 'Novedades' },
  { value: 'book', label: 'Formación' },
  { value: 'film', label: 'Videos' },
  { value: 'lightbulb', label: 'Ideas' },
]

const VIEWER_ROLES = ['operator', 'boss']

const AUDIENCE_META = {
  operator: { label: 'Operante', groupLabel: 'Operante', description: 'Videos exclusivos para el rol Operante' },
  boss: { label: 'Jefe', groupLabel: 'Jefe', description: 'Videos exclusivos para el rol Jefe' },
  both: { label: 'Ambos', groupLabel: 'Todos', description: 'Videos destinados a Operante y Jefe' },
  none: { label: 'Sin asignar', groupLabel: 'Sin asignar', description: 'Videos que necesitan una audiencia y una sección' },
}

const isVideoAssignedTo = (video, role) => Boolean(video.assignments?.[role])
const isVideoLockedFor = (video, role) => isVideoAssignedTo(video, role) && Boolean(video.locked?.[role])

function getVideoAudience(video) {
  const forOperator = isVideoAssignedTo(video, 'operator')
  const forBoss = isVideoAssignedTo(video, 'boss')
  if (forOperator && forBoss) return 'both'
  if (forOperator) return 'operator'
  if (forBoss) return 'boss'
  return 'none'
}

function getPersistedVideoSource(video) {
  const source = getVideoSource(video?.url || '')
  const originalProvider = video?.source?.metadata?.originalProvider

  if (
    video?.source?.provider === 'supabase_storage'
    && originalProvider === 'google_drive'
    && source.type === 'video'
  ) {
    return { ...source, label: 'Google Drive', originalProvider }
  }

  return source
}

function editableSnapshotFingerprint(snapshot) {
  if (!snapshot) return ''
  return JSON.stringify({
    organization: snapshot.organization || '',
    settings: snapshot.settings || null,
    sections: (snapshot.sections || []).map((section) => ({
      id: section.id,
      name: section.name,
      slug: section.slug || '',
      icon: section.icon,
      roles: [...(section.roles || [])].sort(),
      order: section.order,
    })),
    videos: (snapshot.videos || []).map((video) => ({
      id: video.id,
      title: video.title,
      description: video.description,
      url: video.url,
      thumbnailUrl: video.thumbnailUrl || '',
      duration: video.duration,
      assignments: video.assignments || {},
      locked: video.locked || {},
      featured: Boolean(video.featured),
      createdAt: video.createdAt,
      source: video.source || null,
    })),
  })
}

function getErrorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback
}

function App() {
  const [theme, setTheme] = useState('light')
  const [data, setData] = useState(null)
  const [session, setSession] = useState(undefined)
  const [accessContext, setAccessContext] = useState(null)
  const [loadingData, setLoadingData] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saveState, setSaveState] = useState({ status: 'idle', error: '' })
  const [saveRetry, setSaveRetry] = useState(0)
  const [loggingOut, setLoggingOut] = useState(false)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const loadEpochRef = useRef(0)
  const lastSavedFingerprintRef = useRef('')
  const latestDataRef = useRef(null)
  const saveTimerRef = useRef(null)
  const saveQueueRef = useRef(Promise.resolve())
  const saveRevisionRef = useRef(0)
  const contentRevisionTrackerRef = useRef(null)
  const backgroundRefreshRef = useRef(false)
  const driveImportRequestKeyRef = useRef('')
  const sessionUserIdRef = useRef(null)
  const loginInProgressRef = useRef(false)
  // IDs de video que Supabase ya confirmó (existen de verdad en la tabla
  // videos), separado de `data.videos` porque ese último también incluye
  // ediciones optimistas que todavía no terminaron de guardarse.
  const persistedVideoIdsRef = useRef(new Set())

  if (!contentRevisionTrackerRef.current) {
    contentRevisionTrackerRef.current = createAdminSaveRevisionTracker()
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const clearAuthenticatedState = useCallback(() => {
    loadEpochRef.current += 1
    saveRevisionRef.current += 1
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    setSession(null)
    sessionUserIdRef.current = null
    setAccessContext(null)
    setTermsAccepted(false)
    setData(null)
    latestDataRef.current = null
    persistedVideoIdsRef.current = new Set()
    lastSavedFingerprintRef.current = ''
    driveImportRequestKeyRef.current = ''
    contentRevisionTrackerRef.current.reset()
    setLoadingData(false)
    setLoadError('')
    setSaveState({ status: 'idle', error: '' })
  }, [])

  const hydrateSession = useCallback(async (nextSession, knownContext = null) => {
    if (!nextSession) {
      clearAuthenticatedState()
      return null
    }

    const epoch = ++loadEpochRef.current
    sessionUserIdRef.current = nextSession.user?.id || null
    setSession(nextSession)
    setLoadingData(true)
    setLoadError('')

    try {
      const context = knownContext || await getCurrentAccessContext()
      const snapshot = await loadVideoHubSnapshot({ context })
      if (epoch !== loadEpochRef.current) return null

      contentRevisionTrackerRef.current.reset(snapshot.revision)
      lastSavedFingerprintRef.current = editableSnapshotFingerprint(snapshot)
      latestDataRef.current = snapshot
      persistedVideoIdsRef.current = new Set(snapshot.videos.map((video) => video.id))
      setAccessContext(context)
      setData(snapshot)
      setSaveState({ status: 'saved', error: '' })
      return snapshot
    } catch (error) {
      if (epoch === loadEpochRef.current) {
        setAccessContext(null)
        setData(null)
        setLoadError(getErrorMessage(error, 'No se pudieron cargar los datos de Supabase.'))
      }
      throw error
    } finally {
      if (epoch === loadEpochRef.current) setLoadingData(false)
    }
  }, [clearAuthenticatedState])

  useEffect(() => {
    let active = true

    getCurrentSession()
      .then((currentSession) => {
        if (!active) return null
        return hydrateSession(currentSession)
      })
      .catch((error) => {
        if (!active) return
        setSession(null)
        setLoadingData(false)
        setLoadError(getErrorMessage(error, 'No se pudo iniciar la conexión con Supabase.'))
      })

    const unsubscribe = onAuthStateChange((event, nextSession) => {
      if (!active) return
      if (event === 'SIGNED_OUT') {
        // Si queda una sesión vieja guardada en el navegador, Supabase intenta
        // refrescarla sola al cargar la página. Cuando ese refresco de fondo
        // falla justo mientras loginWithCredentials está estableciendo la
        // sesión nueva, dispara este mismo evento SIGNED_OUT: sin este guard,
        // limpiaba el estado recién creado (vía el epoch de hydrateSession) y
        // el usuario volvía a ver el formulario de acceso en el primer
        // intento, aunque sus credenciales fueran correctas.
        if (loginInProgressRef.current) return
        clearAuthenticatedState()
      } else if (nextSession && ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event)) {
        if (event === 'SIGNED_IN') {
          // setSession() emite SIGNED_IN antes de que loginWithCredentials
          // termine de validar el contexto y cargar los datos. Durante ese
          // acceso controlado, hydrateSession es la única operación que debe
          // publicar la sesión; hacerlo aquí desmontaba el formulario en el
          // primer intento y dejaba la interfaz en un estado intermedio.
          if (loginInProgressRef.current) return

          if (nextSession.user?.id !== sessionUserIdRef.current) {
            window.setTimeout(() => hydrateSession(nextSession).catch(() => undefined), 0)
          } else {
            setSession(nextSession)
          }
          return
        }

        setSession(nextSession)
      }
    })

    return () => {
      active = false
      loadEpochRef.current += 1
      unsubscribe()
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [clearAuthenticatedState, hydrateSession])

  useEffect(() => {
    latestDataRef.current = data
  }, [data])

  useEffect(() => {
    if (
      accessContext
      && accessContext.role !== 'admin'
      && data?.settings?.allowLightMode === false
      && theme !== 'dark'
    ) setTheme('dark')
  }, [accessContext, data?.settings?.allowLightMode, theme])

  useEffect(() => {
    if (!data || loadingData || accessContext?.role !== 'admin') return undefined

    const fingerprint = editableSnapshotFingerprint(data)
    if (fingerprint === lastSavedFingerprintRef.current) return undefined

    const revision = ++saveRevisionRef.current
    setSaveState({ status: 'pending', error: '' })
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)

    saveTimerRef.current = window.setTimeout(() => {
      const snapshot = data
      const context = accessContext
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (revision < saveRevisionRef.current) return
          setSaveState({ status: 'saving', error: '' })
          const savedSnapshot = await saveAdminSnapshot(
            contentRevisionTrackerRef.current.rebase(snapshot),
            { context },
          )
          contentRevisionTrackerRef.current.confirm(savedSnapshot.revision)
          persistedVideoIdsRef.current = new Set(savedSnapshot.videos.map((video) => video.id))
          if (revision === saveRevisionRef.current) {
            const savedFingerprint = editableSnapshotFingerprint(savedSnapshot)
            lastSavedFingerprintRef.current = savedFingerprint
            latestDataRef.current = savedSnapshot
            setData(savedSnapshot)
            setSaveState({ status: 'saved', error: '' })
          } else {
            lastSavedFingerprintRef.current = fingerprint
          }
        })
        .catch((error) => {
          if (revision === saveRevisionRef.current) {
            setSaveState({
              status: 'error',
              error: getErrorMessage(error, 'No se pudieron guardar los cambios.'),
              code: error?.code || '',
            })
          }
        })
    }, SAVE_DELAY_MS)

    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [accessContext, data, loadingData, saveRetry])

  useEffect(() => {
    if (!session?.user?.id || !accessContext) return undefined
    let active = true

    const refreshFromSupabase = async () => {
      if (!active || document.visibilityState === 'hidden' || backgroundRefreshRef.current) return
      const currentData = latestDataRef.current
      const hadPendingAdminChanges = (
        accessContext.role === 'admin'
        && currentData
        && editableSnapshotFingerprint(currentData) !== lastSavedFingerprintRef.current
      )

      const epoch = loadEpochRef.current
      backgroundRefreshRef.current = true
      try {
        const freshContext = await getCurrentAccessContext()
        if (!freshContext.active || freshContext.userId !== accessContext.userId) {
          await signOut().catch(() => undefined)
          clearAuthenticatedState()
          return
        }
        const accessChanged = (
          freshContext.role !== accessContext.role
          || freshContext.organizationId !== accessContext.organizationId
        )
        if (hadPendingAdminChanges && !accessChanged) return
        const snapshot = await loadVideoHubSnapshot({
          context: freshContext,
          previousSnapshot: latestDataRef.current,
        })
        if (!active || epoch !== loadEpochRef.current) return

        const latestData = latestDataRef.current
        if (
          freshContext.role === 'admin'
          && !accessChanged
          && latestData
          && editableSnapshotFingerprint(latestData) !== lastSavedFingerprintRef.current
        ) return

        contentRevisionTrackerRef.current.reset(snapshot.revision)
        lastSavedFingerprintRef.current = editableSnapshotFingerprint(snapshot)
        latestDataRef.current = snapshot
        persistedVideoIdsRef.current = new Set(snapshot.videos.map((video) => video.id))
        if (
          freshContext.role !== accessContext.role
          || freshContext.organizationId !== accessContext.organizationId
        ) setAccessContext(freshContext)
        setData(snapshot)
      } catch (error) {
        if (error?.code === 'PROFILE_NOT_FOUND') {
          await signOut().catch(() => undefined)
          clearAuthenticatedState()
        }
        // Una interrupción temporal no reemplaza los datos que ya están visibles.
      } finally {
        backgroundRefreshRef.current = false
      }
    }

    const handleFocus = () => { refreshFromSupabase() }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshFromSupabase()
    }
    // 90s en vez de 15s: en un proyecto de Supabase con compute chico, un
    // sondeo cada 15 segundos por cada pestaña abierta es una carga base
    // innecesariamente alta. La revisión al enfocar la pestaña/ventana ya
    // cubre el caso de "me fui y volví"; este intervalo es solo respaldo.
    const interval = window.setInterval(refreshFromSupabase, 90_000)
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [accessContext, clearAuthenticatedState, session?.user?.id])

  useEffect(() => {
    if (accessContext?.role !== 'admin' || !data?.videos?.length) return

    const driveVideos = data.videos.filter((video) => video.source?.provider === 'google_drive')
    const requestKey = driveVideos
      .map((video) => `${video.id}:${video.source?.sourceRef || ''}`)
      .sort()
      .join('|')

    if (!requestKey) {
      driveImportRequestKeyRef.current = ''
      return
    }
    if (driveImportRequestKeyRef.current === requestKey) return

    driveImportRequestKeyRef.current = requestKey
    queueDriveVideoImports(driveVideos.map((video) => video.id)).catch(() => {
      // Netlify reintenta las ejecuciones fallidas; el enlace Drive se conserva.
      if (driveImportRequestKeyRef.current === requestKey) {
        driveImportRequestKeyRef.current = ''
      }
    })
  }, [accessContext?.role, data?.videos])

  useEffect(() => {
    const warnBeforeLeaving = (event) => {
      if (accessContext?.role !== 'admin' || !data) return
      if (editableSnapshotFingerprint(data) === lastSavedFingerprintRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [accessContext?.role, data])

  const toggleTheme = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))

  const loginWithCredentials = async (username, password) => {
    loginInProgressRef.current = true
    try {
      const result = await authenticateWithCredentials(username, password)
      await hydrateSession(result.session, result.context)
      return true
    } finally {
      loginInProgressRef.current = false
    }
  }

  const retryLoad = () => {
    if (session) hydrateSession(session).catch(() => undefined)
  }

  const retrySave = () => {
    if (saveState.code === 'STALE_SNAPSHOT') {
      const confirmed = window.confirm(
        'Hay cambios más recientes en Supabase. ¿Quieres descartar esta copia y recargar la versión guardada?',
      )
      if (confirmed && session) hydrateSession(session).catch(() => undefined)
      return
    }
    lastSavedFingerprintRef.current = `retry-${Date.now()}`
    setSaveRetry((value) => value + 1)
  }

  const logout = async () => {
    if (loggingOut) return
    setLoggingOut(true)
    setLoadError('')

    // Un guardado atascado (por ejemplo, varias pestañas de admin guardando
    // a la vez) nunca debe impedir cerrar sesión indefinidamente: se espera
    // un tiempo razonable y, si no termina, se cierra la sesión igual.
    const LOGOUT_SAVE_TIMEOUT_MS = 8000
    const withTimeout = (promise) => Promise.race([
      promise,
      new Promise((resolve) => window.setTimeout(resolve, LOGOUT_SAVE_TIMEOUT_MS)),
    ])

    try {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      saveRevisionRef.current += 1
      await withTimeout(saveQueueRef.current.catch(() => undefined))

      const currentData = latestDataRef.current
      if (
        accessContext?.role === 'admin'
        && currentData
        && editableSnapshotFingerprint(currentData) !== lastSavedFingerprintRef.current
      ) {
        setSaveState({ status: 'saving', error: '' })
        const savedSnapshot = await withTimeout(saveAdminSnapshot(
          contentRevisionTrackerRef.current.rebase(currentData),
          { context: accessContext },
        ))
        if (savedSnapshot) {
          contentRevisionTrackerRef.current.confirm(savedSnapshot.revision)
          lastSavedFingerprintRef.current = editableSnapshotFingerprint(savedSnapshot)
        }
      }

      await signOut()
      clearAuthenticatedState()
    } catch (error) {
      setSaveState({
        status: 'error',
        error: getErrorMessage(error, 'No se pudo guardar o cerrar la sesión.'),
        code: error?.code || '',
      })
    } finally {
      setLoggingOut(false)
    }
  }

  if (session === undefined || (session && loadingData)) {
    return <AppStatusScreen title="Conectando con Supabase" text="Estamos cargando tu contenido y permisos." />
  }

  if (!session) {
    return <LoginScreen data={EMPTY_DATA} theme={theme} toggleTheme={toggleTheme} onLogin={loginWithCredentials} serviceError={loadError} />
  }

  if (loadError || !data || !accessContext) {
    return (
      <AppStatusScreen
        error
        title="No se pudo cargar la plataforma"
        text={loadError || 'La sesión no tiene un perfil activo en Supabase.'}
        actions={<><button className="primary-button" onClick={retryLoad}>Reintentar</button><button className="secondary-button" onClick={logout}>Cerrar sesión</button></>}
      />
    )
  }

  if (accessContext.role === 'admin') {
    return (
      <AdminApp
        data={data}
        setData={setData}
        theme={theme}
        toggleTheme={toggleTheme}
        saveState={saveState}
        persistedVideoIdsRef={persistedVideoIdsRef}
        onRetrySave={retrySave}
        onCreateUser={createUser}
        onUpdateUser={updateUser}
        loggingOut={loggingOut}
        onLogout={logout}
      />
    )
  }

  if (!termsAccepted) {
    return (
      <TermsScreen
        data={data}
        theme={theme}
        toggleTheme={toggleTheme}
        onAccept={() => setTermsAccepted(true)}
        onDecline={logout}
        loggingOut={loggingOut}
      />
    )
  }

  return (
    <ViewerApp
      role={accessContext.role}
      userId={accessContext.userId}
      data={data}
      theme={theme}
      toggleTheme={toggleTheme}
      onLogout={logout}
    />
  )
}

function AppStatusScreen({ title, text, actions = null, error = false }) {
  return (
    <main className={`app-status-screen ${error ? 'app-status-screen--error' : ''}`}>
      <CompanyLogo />
      <span className="app-status-screen__icon">{error ? <CircleHelp size={26} /> : <span className="loading-spinner" />}</span>
      <h1>{title}</h1>
      <p>{text}</p>
      {actions && <div className="app-status-screen__actions">{actions}</div>}
    </main>
  )
}

function CompanyLogo({ compact = false }) {
  return (
    <div className={`company-brand ${compact ? 'company-brand--compact' : ''}`}>
      <span className="company-brand__plate">
        <img src="/brand/almacen-remates-web.png" alt="Almacén de Remates" />
      </span>
      {!compact && (
        <span className="company-brand__product">
          <strong>PORTAL PRIVADO</strong>
          <small>VIDEO HUB</small>
        </span>
      )}
    </div>
  )
}

function ThemeToggle({ theme, onToggle, label = true }) {
  return (
    <button className="theme-toggle" type="button" onClick={onToggle} aria-label="Cambiar tema">
      <span className="theme-toggle__icon">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</span>
      {label && <span>{theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}</span>}
    </button>
  )
}

function VideoThumbnail({ video, className = '' }) {
  const source = getPersistedVideoSource(video)
  const preferredThumbnail = video?.thumbnailUrl?.trim() || source.thumbnailUrl || ''
  const [thumbnailUrl, setThumbnailUrl] = useState(preferredThumbnail)
  const [videoFailed, setVideoFailed] = useState(false)
  const [frameReady, setFrameReady] = useState(false)

  useEffect(() => {
    let active = true
    setThumbnailUrl(preferredThumbnail)
    setVideoFailed(false)
    setFrameReady(false)

    if (!preferredThumbnail && source.provider === 'vimeo') {
      resolveVideoThumbnail(video.url).then((url) => {
        if (active) setThumbnailUrl(url)
      })
    }

    return () => { active = false }
  }, [preferredThumbnail, source.provider, video?.url])

  if (thumbnailUrl) {
    return (
      <img
        className={`video-thumbnail-media ${className}`}
        src={thumbnailUrl}
        alt={`Miniatura de ${video.title || 'video'}`}
        loading="lazy"
        onError={() => setThumbnailUrl('')}
      />
    )
  }

  if (source.type === 'video' && !videoFailed) {
    const frameUrl = getVideoThumbnailUrl(source.embedUrl)
    const revealFrameIfReady = (element) => {
      const target = getThumbnailSeekTime(element.duration)
      if (!element.seeking && Math.abs(element.currentTime - target) <= 0.15) {
        setFrameReady(true)
      }
    }

    return (
      <video
        key={frameUrl}
        className={`video-thumbnail-media video-thumbnail-media--frame ${frameReady ? 'is-ready' : ''} ${className}`}
        src={frameUrl}
        preload="metadata"
        muted
        playsInline
        aria-label={`Miniatura de ${video.title || 'video'}`}
        onLoadedMetadata={(event) => {
          const element = event.currentTarget
          const target = getThumbnailSeekTime(element.duration)

          if (Math.abs(element.currentTime - target) <= 0.05) {
            setFrameReady(true)
            return
          }

          element.currentTime = target
        }}
        onLoadedData={(event) => revealFrameIfReady(event.currentTarget)}
        onCanPlay={(event) => revealFrameIfReady(event.currentTarget)}
        onSeeked={(event) => revealFrameIfReady(event.currentTarget)}
        onError={() => setVideoFailed(true)}
      />
    )
  }

  return null
}

function LoginScreen({ data, theme, toggleTheme, onLogin, serviceError = '' }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    if (!username.trim()) {
      setError('Escribe tu usuario para continuar.')
      return
    }
    if (!password) {
      setError('Escribe tu contraseña para continuar.')
      return
    }
    setLoading(true)
    try {
      await onLogin(username, password)
    } catch (loginError) {
      setError(getErrorMessage(loginError, 'El usuario o la contraseña no son válidos. Compruébalos e inténtalo nuevamente.'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <div className="login-page__glow login-page__glow--one" />
      <div className="login-page__glow login-page__glow--two" />
      <div className="login-grid" aria-hidden="true" />

      <header className="login-header">
        <CompanyLogo />
        <ThemeToggle theme={theme} onToggle={toggleTheme} label={false} />
      </header>

      <section className="login-shell">
        <div className="login-intro">
          <span className="eyebrow"><Sparkles size={14} /> Conocimiento que impulsa</span>
          <h1>Todo lo que necesitas aprender, <em>en un solo lugar.</em></h1>
          <p>Accede a videos, procesos y recursos seleccionados especialmente para tu función.</p>
          <div className="login-proof">
            <div className="avatar-stack" aria-hidden="true">
              <span>AM</span><span>CL</span><span>JR</span>
            </div>
            <div><strong>Contenido privado</strong><small>Organizado y siempre disponible</small></div>
          </div>
        </div>

        <div className="login-card-wrap">
          <div className="login-card">
            <div className="login-card__icon"><LockKeyhole size={23} /></div>
            <div className="login-card__heading">
              <span>ACCESO PRIVADO</span>
              <h2>Bienvenido</h2>
              <p>Ingresa el usuario y la contraseña que te proporcionó tu administrador.</p>
            </div>

            <form onSubmit={submit}>
              <label htmlFor="login-username">Usuario</label>
              <div className={`code-field ${error ? 'code-field--error' : ''}`}>
                <User size={19} />
                <input
                  id="login-username"
                  type="text"
                  value={username}
                  onChange={(event) => { setUsername(event.target.value); setError('') }}
                  placeholder="usuario"
                  autoComplete="username"
                  autoFocus
                  disabled={loading}
                />
              </div>
              <label htmlFor="login-password">Contraseña</label>
              <div className={`code-field ${error ? 'code-field--error' : ''}`}>
                <KeyRound size={19} />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => { setPassword(event.target.value); setError('') }}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  disabled={loading}
                />
                <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {error && <p className="form-error">{error}</p>}
              {!error && serviceError && <p className="form-error">{serviceError}</p>}
              <button className="primary-button primary-button--wide" type="submit" disabled={loading}>
                <span>{loading ? 'Verificando…' : 'Ingresar a la plataforma'}</span>
                {!loading && <ArrowRight size={18} />}
              </button>
            </form>

            <div className="secure-note"><ShieldCheck size={15} /> Acceso seguro y contenido protegido</div>

          </div>
        </div>
      </section>

      <footer className="login-footer"><span>© 2026 {data.organization}</span><span>Aprende · Crece · Lidera</span></footer>
    </main>
  )
}

function TermsScreen({ data, theme, toggleTheme, onAccept, onDecline, loggingOut }) {
  const [checked, setChecked] = useState(false)

  return (
    <main className="login-page terms-page">
      <div className="login-page__glow login-page__glow--one" />
      <div className="login-page__glow login-page__glow--two" />
      <div className="login-grid" aria-hidden="true" />

      <header className="login-header">
        <CompanyLogo />
        <ThemeToggle theme={theme} onToggle={toggleTheme} label={false} />
      </header>

      <section className="terms-shell">
        <div className="terms-card">
          <div className="terms-card__icon"><ClipboardCheck size={23} /></div>
          <div className="terms-card__heading">
            <span>ANTES DE CONTINUAR</span>
            <h1>Términos y condiciones de uso</h1>
            <p>Para acceder a {data.organization}, lee y acepta las siguientes condiciones de uso de la plataforma.</p>
          </div>

          <div className="terms-body">
            <article>
              <h3><ShieldCheck size={15} /> Uso de la cuenta</h3>
              <p>El acceso a esta plataforma es personal e intransferible. Eres responsable de mantener la confidencialidad de tu usuario y contraseña, así como de toda actividad realizada desde tu sesión.</p>
            </article>
            <article>
              <h3><Camera size={15} /> Captura de fotografía y datos de actividad</h3>
              <p>Al aceptar estos términos autorizas a la plataforma a tomar una fotografía mediante la cámara de tu dispositivo cuando se te solicite —por ejemplo, al iniciar un cuestionario o evaluación— con fines de verificación de identidad y control de calidad. Asimismo, autorizas el registro de tu progreso de visualización, tus intentos de evaluación y demás información de uso asociada a tu cuenta.</p>
            </article>
            <article>
              <h3><LockKeyhole size={15} /> Protección de la información</h3>
              <p>La información recopilada se almacena de forma segura y se utiliza exclusivamente con fines internos de capacitación, seguimiento y control de acceso. Solo el personal administrador autorizado de tu organización puede consultarla; no se comparte con terceros ajenos a ella.</p>
            </article>
          </div>

          <label className="terms-check">
            <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} disabled={loggingOut} />
            <span>He leído y acepto los términos y condiciones descritos anteriormente.</span>
          </label>

          <div className="terms-actions">
            <button type="button" className="secondary-button" onClick={onDecline} disabled={loggingOut}>
              <CircleAlert size={15} /> {loggingOut ? 'Cerrando sesión…' : 'No estoy de acuerdo'}
            </button>
            <button type="button" className="primary-button" onClick={onAccept} disabled={!checked || loggingOut}>
              <Check size={16} /> Acepto los términos
            </button>
          </div>
        </div>
      </section>

      <footer className="login-footer"><span>© 2026 {data.organization}</span><span>Aprende · Crece · Lidera</span></footer>
    </main>
  )
}

const ADMIN_NAV = [
  { id: 'overview', label: 'Resumen', icon: LayoutDashboard },
  { id: 'sections', label: 'Secciones', icon: FolderCog },
  { id: 'videos', label: 'Biblioteca', icon: Video },
  { id: 'documents', label: 'Documentos', icon: FileText },
  { id: 'settings', label: 'Configuración', icon: Settings2 },
  { id: 'users', label: 'Usuarios', icon: UsersRound },
  { id: 'progress', label: 'Progreso', icon: BarChart3 },
  { id: 'preview', label: 'Vista por rol', icon: Eye },
]

function AdminApp({
  data,
  setData,
  theme,
  toggleTheme,
  saveState,
  persistedVideoIdsRef,
  onRetrySave,
  onCreateUser,
  onUpdateUser,
  loggingOut,
  onLogout,
}) {
  const [page, setPage] = useState('overview')
  const [menuOpen, setMenuOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [toast, setToast] = useState(null)

  // Requiere presionar "Continuar" en vez de autoocultarse: el aviso debe
  // confirmarse a propósito, no perderse de un vistazo.
  const notify = useCallback((message, { tone = 'success', onConfirm } = {}) => {
    setToast({ id: Date.now(), message, tone, onConfirm })
  }, [])

  const dismissToast = () => {
    const onConfirm = toast?.onConfirm
    setToast(null)
    onConfirm?.()
  }

  const navigate = (nextPage) => {
    setPage(nextPage)
    setMenuOpen(false)
  }

  const removeSection = (sectionId) => {
    const sectionName = data.sections.find((section) => section.id === sectionId)?.name || 'esta sección'
    const documentCount = (data.documents || []).filter((document) => document.sectionId === sectionId).length
    if (documentCount) {
      notify(`Elimina primero los ${documentCount} documento(s) de “${sectionName}”.`, { tone: 'danger' })
      return
    }
    if (!window.confirm(`¿Eliminar ${sectionName}? También se quitarán sus asignaciones de video.`)) return
    setData((current) => ({
      ...current,
      sections: current.sections.filter((section) => section.id !== sectionId),
      videos: current.videos.map((video) => {
        const assignments = Object.fromEntries(Object.entries(video.assignments).filter(([, value]) => value !== sectionId))
        const locked = Object.fromEntries(Object.entries(video.locked || {}).filter(([role]) => assignments[role]))
        return { ...video, assignments, locked }
      }),
    }))
    notify(`Sección "${sectionName}" eliminada correctamente`, { tone: 'danger' })
  }

  const titles = {
    overview: ['Resumen general', 'Todo bajo control, en un solo lugar.'],
    sections: ['Secciones y navegación', 'Define lo que aparece en el menú de cada rol.'],
    videos: ['Biblioteca de videos', 'Publica contenido y decide quién puede verlo.'],
    documents: ['Biblioteca de documentos', 'Sube y administra archivos PDF o Word por sección.'],
    settings: ['Configuración general', 'Personaliza los textos y preferencias de la plataforma.'],
    users: ['Usuarios', 'Crea, edita y deshabilita las cuentas de operante y jefe.'],
    progress: ['Progreso de usuarios', 'Qué tanto ha avanzado cada persona en su contenido asignado.'],
    preview: ['Vista por rol', 'Comprueba la experiencia antes de compartirla.'],
  }

  return (
    <div className={`app-layout ${sidebarCollapsed ? 'app-layout--sidebar-collapsed' : ''} ${loggingOut ? 'app-layout--busy' : ''}`}>
      <AdminToast toast={toast} onDismiss={dismissToast} />
      {loggingOut && <div className="app-saving-overlay"><span className="loading-spinner" /><strong>Guardando y cerrando sesión…</strong></div>}
      <button className={`mobile-overlay ${menuOpen ? 'is-visible' : ''}`} onClick={() => setMenuOpen(false)} aria-label="Cerrar menú" />
      <aside className={`sidebar admin-sidebar ${sidebarCollapsed && !menuOpen ? 'sidebar--collapsed' : ''} ${menuOpen ? 'is-open' : ''}`}>
        <div className="sidebar__top">
          <CompanyLogo compact />
          <button className="sidebar-close" onClick={() => setMenuOpen(false)}><X size={20} /></button>
        </div>
        <button
          type="button"
          className="sidebar-collapse"
          onClick={() => setSidebarCollapsed((value) => !value)}
          aria-label={sidebarCollapsed ? 'Expandir barra lateral' : 'Contraer barra lateral'}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? 'Expandir barra lateral' : 'Contraer barra lateral'}
        >
          {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
        <div className="role-pill"><span>AD</span><div><strong>Administrador</strong><small>Control total</small></div></div>
        <nav className="sidebar-nav" aria-label="Administración">
          <small className="sidebar-label">GESTIÓN</small>
          {ADMIN_NAV.map((item) => {
            const Icon = item.icon
            return (
              <button className={page === item.id ? 'active' : ''} key={item.id} onClick={() => navigate(item.id)} title={sidebarCollapsed ? item.label : undefined}>
                <Icon size={19} /><span>{item.label}</span>{page === item.id && <ChevronRight className="nav-chevron" size={15} />}
              </button>
            )
          })}
        </nav>
        <div className="sidebar__bottom">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button className="sidebar-action" onClick={onLogout} disabled={loggingOut} title={sidebarCollapsed ? 'Cerrar sesión' : undefined}><LogOut size={18} /><span>{loggingOut ? 'Guardando…' : 'Cerrar sesión'}</span></button>
        </div>
      </aside>

      <section className="main-shell">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMenuOpen(true)}><Menu size={21} /></button>
          <div className="topbar__title"><small>ADMINISTRACIÓN</small><strong>{titles[page][0]}</strong></div>
          <div className="topbar__right">
            <span className={`status-dot status-dot--${saveState.status}`} title={saveState.error || undefined}>
              <i />
              {saveState.status === 'pending' && 'Cambios pendientes'}
              {saveState.status === 'saving' && 'Guardando en Supabase…'}
              {saveState.status === 'saved' && 'Guardado en Supabase'}
              {saveState.status === 'error' && 'Error al guardar'}
              {saveState.status === 'idle' && 'Conectado a Supabase'}
            </span>
            {saveState.status === 'error' && <button className="save-retry-button" type="button" onClick={onRetrySave}>{saveState.code === 'STALE_SNAPSHOT' ? 'Recargar' : 'Reintentar'}</button>}
            <div className="admin-avatar">AD</div>
          </div>
        </header>
        <main className="content-area">
          <div className="page-heading">
            <div><span className="eyebrow eyebrow--plain">PANEL DE CONTROL</span><h1>{titles[page][0]}</h1><p>{titles[page][1]}</p></div>
          </div>
          {page === 'overview' && <AdminOverview data={data} onNavigate={navigate} />}
          {page === 'sections' && <SectionsManager data={data} setData={setData} saveState={saveState} onRemove={removeSection} onNotify={notify} />}
          {page === 'videos' && <VideosManager data={data} setData={setData} saveState={saveState} persistedVideoIdsRef={persistedVideoIdsRef} onNotify={notify} />}
          {page === 'documents' && <DocumentsManager data={data} setData={setData} onNotify={notify} />}
          {page === 'settings' && <SettingsManager data={data} setData={setData} />}
          {page === 'users' && <UsersManager onCreateUser={onCreateUser} onUpdateUser={onUpdateUser} onNotify={notify} />}
          {page === 'progress' && <ProgressManager data={data} />}
          {page === 'preview' && <RolePreview data={data} />}
          {saveState.status === 'error' && <div className="save-error-banner"><CircleHelp size={17} /><span>{saveState.error}</span><button type="button" onClick={onRetrySave}>{saveState.code === 'STALE_SNAPSHOT' ? 'Recargar desde Supabase' : 'Reintentar'}</button></div>}
        </main>
      </section>
    </div>
  )
}

function AdminToast({ toast, onDismiss }) {
  if (!toast) return null
  const isDanger = toast.tone === 'danger'
  return (
    <div className="admin-notice-overlay" key={toast.id} role="presentation">
      <div className={`admin-notice ${isDanger ? 'admin-notice--danger' : ''}`} role="alertdialog" aria-modal="true" aria-live="assertive">
        <span className="admin-notice__icon">{isDanger ? <Trash2 size={30} /> : <CircleCheck size={30} />}</span>
        <p>{toast.message}</p>
        <button type="button" className="primary-button admin-notice__button" onClick={onDismiss} autoFocus>Continuar</button>
      </div>
    </div>
  )
}

function SettingsManager({ data, setData }) {
  const settings = data.settings || {
    productName: 'Video Hub',
    welcomeTitle: 'Todo lo que necesitas aprender, en un solo lugar.',
    welcomeMessage: '',
    supportMessage: 'Contacta a tu administrador',
    allowLightMode: true,
    requireQuizPhoto: false,
  }

  const updateSetting = (key, value) => {
    setData((current) => ({
      ...current,
      settings: { ...settings, ...(current.settings || {}), [key]: value },
    }))
  }

  return (
    <div className="manager-stack">
      <section className="panel settings-panel">
        <div className="panel-heading"><div><h2>Identidad y experiencia</h2><p>Estos cambios se guardan en Supabase y se aplican a las vistas de los roles.</p></div></div>
        <div className="general-settings-form">
          <div className="form-group"><label>Nombre de la organización</label><input value={data.organization || ''} onChange={(event) => setData((current) => ({ ...current, organization: event.target.value }))} maxLength="120" /></div>
          <div className="form-group"><label>Nombre del portal</label><input value={settings.productName} onChange={(event) => updateSetting('productName', event.target.value)} maxLength="80" /></div>
          <div className="form-group general-settings-form__wide"><label>Título de bienvenida</label><input value={settings.welcomeTitle} onChange={(event) => updateSetting('welcomeTitle', event.target.value)} maxLength="180" /></div>
          <div className="form-group general-settings-form__wide"><label>Mensaje de bienvenida</label><textarea value={settings.welcomeMessage} onChange={(event) => updateSetting('welcomeMessage', event.target.value)} rows="4" placeholder="Escribe el mensaje que verán Operante y Jefe." /></div>
          <div className="form-group general-settings-form__wide"><label>Mensaje de ayuda</label><input value={settings.supportMessage} onChange={(event) => updateSetting('supportMessage', event.target.value)} placeholder="Ej. Escribe al administrador" /></div>
          <label className="feature-check general-settings-form__wide"><input type="checkbox" checked={settings.allowLightMode !== false} onChange={(event) => updateSetting('allowLightMode', event.target.checked)} /><span><Sun size={16} /></span><div><strong>Permitir modo claro</strong><small>Los usuarios podrán alternar entre el tema oscuro y claro.</small></div></label>
          <label className="feature-check general-settings-form__wide"><input type="checkbox" checked={Boolean(settings.requireQuizPhoto)} onChange={(event) => updateSetting('requireQuizPhoto', event.target.checked)} /><span><Camera size={16} /></span><div><strong>Solicitar foto al iniciar el cuestionario</strong><small>Antes de responder, cada usuario deberá tomarse una foto con su cámara. Se guarda junto al intento para que el administrador la revise.</small></div></label>
        </div>
      </section>
      <div className="info-callout"><Settings2 size={19} /><div><strong>Guardado automático</strong><p>El indicador superior confirma cuándo la configuración ya está persistida en Supabase.</p></div></div>
    </div>
  )
}

function AdminOverview({ data, onNavigate }) {
  const visibleSectionIds = (role) => new Set(data.sections.filter((section) => section.roles.includes(role)).map((section) => section.id))
  const operatorSections = visibleSectionIds('operator')
  const bossSections = visibleSectionIds('boss')
  const operatorVideos = data.videos.filter((video) => operatorSections.has(video.assignments.operator)).length
  const bossVideos = data.videos.filter((video) => bossSections.has(video.assignments.boss)).length
  const operatorBlocked = data.videos.filter((video) => operatorSections.has(video.assignments.operator) && isVideoLockedFor(video, 'operator')).length
  const bossBlocked = data.videos.filter((video) => bossSections.has(video.assignments.boss) && isVideoLockedFor(video, 'boss')).length
  const stats = [
    { label: 'Videos publicados', value: data.videos.length, note: 'en la biblioteca', icon: Play, tone: 'red' },
    { label: 'Secciones activas', value: data.sections.length, note: 'entre ambos roles', icon: Layers3, tone: 'blue' },
    { label: 'Para operante', value: operatorVideos, note: `${operatorVideos - operatorBlocked} disponibles · ${operatorBlocked} bloqueados`, icon: UsersRound, tone: 'green' },
    { label: 'Para jefe', value: bossVideos, note: `${bossVideos - bossBlocked} disponibles · ${bossBlocked} bloqueados`, icon: BriefcaseBusiness, tone: 'violet' },
  ]

  return (
    <div className="admin-overview">
      <div className="stat-grid">
        {stats.map((stat) => {
          const Icon = stat.icon
          return <article className="stat-card" key={stat.label}><div className={`stat-icon stat-icon--${stat.tone}`}><Icon size={20} /></div><div><span>{stat.label}</span><strong>{stat.value}</strong><small>{stat.note}</small></div></article>
        })}
      </div>

      <div className="dashboard-grid">
        <section className="panel recent-panel">
          <div className="panel-heading"><div><h2>Contenido reciente</h2><p>Últimos videos agregados</p></div><button className="text-button" onClick={() => onNavigate('videos')}>Ver biblioteca <ArrowRight size={15} /></button></div>
          <div className="recent-list">
            {[...data.videos].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 4).map((video) => {
              const source = getPersistedVideoSource(video)
              return (
                <div className="recent-row" key={video.id}>
                  <div className="mini-thumbnail"><VideoThumbnail video={video} /><Play size={16} fill="currentColor" /></div>
                  <div className="recent-row__copy"><strong>{video.title}</strong><small><span style={{ color: getSourceAccent(source.label) }}>{source.label}</span> · {Object.keys(video.assignments).map((role) => ROLE_META[role].label).join(', ')}</small></div>
                  <span className="status-badge">Publicado</span>
                </div>
              )
            })}
          </div>
        </section>

        <aside className="panel quick-panel">
          <div className="panel-heading"><div><h2>Acciones rápidas</h2><p>Configura tu plataforma</p></div></div>
          <button onClick={() => onNavigate('videos')}><span className="quick-icon"><Plus size={18} /></span><div><strong>Agregar video</strong><small>YouTube, Drive, Vimeo o MP4</small></div><ChevronRight size={17} /></button>
          <button onClick={() => onNavigate('sections')}><span className="quick-icon"><FolderCog size={18} /></span><div><strong>Crear sección</strong><small>Ordena el contenido por tema</small></div><ChevronRight size={17} /></button>
          <button onClick={() => onNavigate('preview')}><span className="quick-icon"><Eye size={18} /></span><div><strong>Revisar permisos</strong><small>Vista de operante y jefe</small></div><ChevronRight size={17} /></button>
        </aside>
      </div>

      <section className="access-summary">
        <div className="access-summary__copy"><span className="access-summary__icon"><ShieldCheck size={22} /></span><div><h2>Acceso diferenciado por rol</h2><p>Cada usuario solo accede a las secciones y videos que tú autorizas.</p></div></div>
        <div className="access-bars">
          <div><span><b>Operante</b><small>{operatorVideos} de {data.videos.length} videos</small></span><i><em style={{ width: `${data.videos.length ? (operatorVideos / data.videos.length) * 100 : 0}%` }} /></i></div>
          <div><span><b>Jefe</b><small>{bossVideos} de {data.videos.length} videos</small></span><i><em style={{ width: `${data.videos.length ? (bossVideos / data.videos.length) * 100 : 0}%` }} /></i></div>
        </div>
      </section>
    </div>
  )
}

function SectionsManager({ data, setData, saveState, onRemove, onNotify }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: '', icon: 'layers', roles: ['operator'] })
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [changingContentId, setChangingContentId] = useState(null)

  const addSection = (event) => {
    event.preventDefault()
    if (!draft.name.trim() || !draft.roles.length) return
    const section = {
      id: crypto.randomUUID(),
      name: draft.name.trim(),
      icon: draft.icon,
      roles: draft.roles,
      order: data.sections.length,
      contentType: 'videos',
    }
    setData((current) => ({ ...current, sections: [...current.sections, section] }))
    setDraft({ name: '', icon: 'layers', roles: ['operator'] })
    setAdding(false)
    onNotify?.(`Sección "${section.name}" creada correctamente`)
  }

  const toggleRole = (sectionId, role) => {
    setData((current) => ({
      ...current,
      sections: current.sections.map((section) => section.id === sectionId
        ? { ...section, roles: section.roles.includes(role) ? section.roles.filter((item) => item !== role) : [...section.roles, role] }
        : section),
    }))
  }

  const move = (sectionId, direction) => {
    setData((current) => {
      const sorted = [...current.sections].sort((a, b) => a.order - b.order)
      const index = sorted.findIndex((section) => section.id === sectionId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= sorted.length) return current
      ;[sorted[index], sorted[target]] = [sorted[target], sorted[index]]
      return { ...current, sections: sorted.map((section, order) => ({ ...section, order })) }
    })
  }

  const saveName = (id) => {
    if (editingName.trim()) {
      if (!window.confirm('¿Guardar el nuevo nombre de esta sección?')) return
      setData((current) => ({ ...current, sections: current.sections.map((section) => section.id === id ? { ...section, name: editingName.trim() } : section) }))
      onNotify?.('Sección actualizada correctamente')
    }
    setEditingId(null)
  }

  const toggleContentType = async (section) => {
    if (changingContentId || saveState.status !== 'saved') return
    const documentCount = (data.documents || []).filter((document) => document.sectionId === section.id).length
    const videoCount = data.videos.filter((video) => Object.values(video.assignments).includes(section.id)).length
    const nextContentType = section.contentType === 'documents' ? 'videos' : 'documents'
    if (nextContentType === 'videos' && documentCount) {
      onNotify?.('Elimina primero los documentos de esta sección para volver al modo videos.', { tone: 'danger' })
      return
    }
    const warning = nextContentType === 'documents' && videoCount
      ? `Esta sección tiene ${videoCount} video(s). Al activar “Solo documentos” dejarán de mostrarse a los usuarios. ¿Continuar?`
      : `¿Cambiar “${section.name}” al modo ${nextContentType === 'documents' ? 'Solo documentos' : 'Videos'}?`
    if (!window.confirm(warning)) return
    setChangingContentId(section.id)
    try {
      await setSectionContentType({
        sectionId: section.id,
        organizationId: data.organizationId,
        contentType: nextContentType,
      })
      setData((current) => ({
        ...current,
        sections: current.sections.map((item) => item.id === section.id
          ? { ...item, contentType: nextContentType }
          : item),
      }))
      onNotify?.(`Sección “${section.name}” configurada para ${nextContentType === 'documents' ? 'solo documentos' : 'videos'}.`)
    } catch (contentError) {
      onNotify?.(getErrorMessage(contentError, 'No se pudo actualizar la sección.'), { tone: 'danger' })
    } finally {
      setChangingContentId(null)
    }
  }

  const sortedSections = [...data.sections].sort((a, b) => a.order - b.order)

  return (
    <div className="manager-stack">
      <section className="panel manager-panel">
        <div className="manager-toolbar">
          <div><h2>Menú de navegación</h2><p>Activa cada sección para operante, jefe o ambos.</p></div>
          <button className="primary-button" onClick={() => setAdding((value) => !value)}>{adding ? <X size={17} /> : <Plus size={17} />} {adding ? 'Cancelar' : 'Nueva sección'}</button>
        </div>

        {adding && (
          <form className="inline-form" onSubmit={addSection}>
            <div className="form-group grow"><label>Nombre de la sección</label><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Ej. Recursos humanos" autoFocus /></div>
            <div className="form-group"><label>Icono</label><select value={draft.icon} onChange={(event) => setDraft({ ...draft, icon: event.target.value })}>{SECTION_ICON_OPTIONS.map((icon) => <option value={icon.value} key={icon.value}>{icon.label}</option>)}</select></div>
            <div className="form-group"><label>Visible para</label><div className="role-checks">{['operator', 'boss'].map((role) => <button type="button" className={draft.roles.includes(role) ? 'selected' : ''} key={role} onClick={() => setDraft({ ...draft, roles: draft.roles.includes(role) ? draft.roles.filter((item) => item !== role) : [...draft.roles, role] })}><Check size={13} /> {ROLE_META[role].label}</button>)}</div></div>
            <button className="primary-button form-submit" type="submit" disabled={!draft.name.trim() || !draft.roles.length}>Crear</button>
          </form>
        )}

        <div className="section-list">
          <div className="section-list__head"><span>Sección</span><span>Visibilidad</span><span>Contenido</span><span>Archivos</span><span>Orden</span><span>Acciones</span></div>
          {sortedSections.map((section, index) => {
            const Icon = ICONS[section.icon] || Layers3
            const count = data.videos.filter((video) => Object.values(video.assignments).includes(section.id)).length
            const documentCount = (data.documents || []).filter((document) => document.sectionId === section.id).length
            return (
              <div className="section-row" key={section.id}>
                <div className="section-identity"><span className="section-icon"><Icon size={18} /></span>{editingId === section.id ? <div className="inline-edit"><input value={editingName} onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveName(section.id) }} autoFocus /><button onClick={() => saveName(section.id)}><Check size={15} /></button></div> : <div><strong>{section.name}</strong><small>/{section.id.split('-').slice(0, -1).join('-') || section.id}</small></div>}</div>
                <div className="role-toggles">{['operator', 'boss'].map((role) => <button className={section.roles.includes(role) ? 'on' : ''} onClick={() => toggleRole(section.id, role)} key={role}><span>{section.roles.includes(role) && <Check size={11} />}</span>{ROLE_META[role].label}</button>)}</div>
                <button type="button" className={`content-mode-toggle ${section.contentType === 'documents' ? 'on' : ''}`} disabled={changingContentId === section.id || saveState.status !== 'saved'} onClick={() => toggleContentType(section)}><span>{section.contentType === 'documents' ? <Check size={11} /> : null}</span>{section.contentType === 'documents' ? 'Solo documentos' : 'Videos'}</button>
                <span className="count-chip">{section.contentType === 'documents' ? `${documentCount} doc.` : `${count} video${count === 1 ? '' : 's'}`}</span>
                <div className="order-buttons"><button disabled={index === 0} onClick={() => move(section.id, -1)}><ChevronLeft size={16} /></button><button disabled={index === sortedSections.length - 1} onClick={() => move(section.id, 1)}><ChevronRight size={16} /></button></div>
                <div className="row-actions"><button onClick={() => { setEditingId(section.id); setEditingName(section.name) }}><Pencil size={16} /></button><button className="danger" onClick={() => onRemove(section.id)}><Trash2 size={16} /></button></div>
              </div>
            )
          })}
          {!sortedSections.length && <EmptyState icon={FolderCog} title="Aún no hay secciones" text="Crea la primera sección para organizar tus videos." />}
        </div>
      </section>
      <div className="info-callout"><Lightbulb size={19} /><div><strong>Un menú distinto para cada rol</strong><p>Si desactivas una sección para un rol, desaparecerá por completo de su barra lateral. Los videos asignados allí tampoco serán visibles.</p></div></div>
    </div>
  )
}

const emptyVideoDraft = {
  title: '',
  description: '',
  url: '',
  thumbnailUrl: '',
  duration: '',
  featured: false,
  operatorEnabled: true,
  operatorSection: '',
  operatorLocked: false,
  bossEnabled: false,
  bossSection: '',
  bossLocked: false,
}

function VideosManager({ data, setData, saveState, persistedVideoIdsRef, onNotify }) {
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [newVideoId, setNewVideoId] = useState(null)
  const [draft, setDraft] = useState(emptyVideoDraft)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [combinedSave, setCombinedSave] = useState(null)
  const quizEditorRef = useRef(null)

  const sectionsFor = (role) => [...data.sections]
    .filter((section) => section.roles.includes(role) && section.contentType !== 'documents')
    .sort((a, b) => a.order - b.order)

  const openNew = () => {
    setEditingId(null)
    setNewVideoId(crypto.randomUUID())
    setError('')
    setDraft({ ...emptyVideoDraft, operatorSection: sectionsFor('operator')[0]?.id || '', bossSection: sectionsFor('boss')[0]?.id || '' })
    setFormOpen(true)
  }

  const openEdit = (video) => {
    setEditingId(video.id)
    setNewVideoId(null)
    setError('')
    setDraft({
      title: video.title,
      description: video.description,
      url: video.url,
      thumbnailUrl: video.thumbnailUrl || '',
      duration: video.duration || '',
      featured: Boolean(video.featured),
      operatorEnabled: Boolean(video.assignments.operator),
      operatorSection: video.assignments.operator || sectionsFor('operator')[0]?.id || '',
      operatorLocked: Boolean(video.locked?.operator),
      bossEnabled: Boolean(video.assignments.boss),
      bossSection: video.assignments.boss || sectionsFor('boss')[0]?.id || '',
      bossLocked: Boolean(video.locked?.boss),
    })
    setFormOpen(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const closeForm = useCallback(() => {
    setFormOpen(false)
    setEditingId(null)
    setNewVideoId(null)
    setCombinedSave(null)
  }, [])

  const saveVideo = (event) => {
    event.preventDefault()
    const source = getVideoSource(draft.url)
    if (!draft.title.trim() || !draft.description.trim() || ['empty', 'invalid'].includes(source.type)) {
      setError('Completa el título, la descripción y un enlace de video válido.')
      return
    }
    if ((!draft.operatorEnabled || !draft.operatorSection) && (!draft.bossEnabled || !draft.bossSection)) {
      setError('Asigna el video al menos a un rol y una sección.')
      return
    }
    const assignments = {}
    if (draft.operatorEnabled && draft.operatorSection) assignments.operator = draft.operatorSection
    if (draft.bossEnabled && draft.bossSection) assignments.boss = draft.bossSection
    const locked = {}
    if (draft.operatorEnabled && draft.operatorSection) locked.operator = draft.operatorLocked
    if (draft.bossEnabled && draft.bossSection) locked.boss = draft.bossLocked
    const payload = {
      title: draft.title.trim(),
      description: draft.description.trim(),
      url: draft.url.trim(),
      thumbnailUrl: draft.thumbnailUrl.trim(),
      duration: draft.duration.trim() || 'Video',
      featured: draft.featured,
      assignments,
      locked,
    }
    if (!quizEditorRef.current?.validate()) return
    const videoId = editingId || newVideoId
    if (!videoId) return
    const currentVideo = editingId ? data.videos.find((video) => video.id === editingId) : null
    const videoChanged = !currentVideo || JSON.stringify({
      title: currentVideo.title,
      description: currentVideo.description,
      url: currentVideo.url,
      thumbnailUrl: currentVideo.thumbnailUrl || '',
      duration: currentVideo.duration,
      featured: Boolean(currentVideo.featured),
      assignments: currentVideo.assignments,
      locked: currentVideo.locked || {},
    }) !== JSON.stringify(payload)
    if (editingId) {
      setData((current) => ({ ...current, videos: current.videos.map((video) => video.id === editingId ? { ...video, ...payload } : video) }))
    } else {
      setData((current) => ({ ...current, videos: [{ ...payload, id: videoId, createdAt: new Date().toISOString() }, ...current.videos] }))
    }
    setCombinedSave({ videoId, editing: Boolean(editingId), sawPersistence: !videoChanged, finishing: false })
  }

  useEffect(() => {
    if (!combinedSave) return
    if (saveState.status === 'pending' || saveState.status === 'saving') {
      if (!combinedSave.sawPersistence) setCombinedSave((current) => current ? { ...current, sawPersistence: true } : current)
      return
    }
    if (saveState.status === 'error') {
      setError(saveState.error || 'No se pudo guardar el video.')
      setCombinedSave(null)
      return
    }
    if (saveState.status !== 'saved' || !combinedSave.sawPersistence || combinedSave.finishing || !persistedVideoIdsRef.current.has(combinedSave.videoId)) return

    setCombinedSave((current) => current ? { ...current, finishing: true } : current)
    const finishSave = async () => {
      const quizSaved = await quizEditorRef.current?.save()
      if (!quizSaved) {
        setCombinedSave(null)
        return
      }
      const message = combinedSave.editing ? 'Video y cuestionario actualizados correctamente' : 'Video y cuestionario guardados correctamente'
      setCombinedSave(null)
      onNotify?.(message, { onConfirm: closeForm })
    }
    finishSave()
  }, [closeForm, combinedSave, onNotify, persistedVideoIdsRef, saveState])

  const deleteVideo = (id) => {
    const videoTitle = data.videos.find((video) => video.id === id)?.title || 'este video'
    if (!window.confirm(`¿Eliminar “${videoTitle}” de Supabase?`)) return
    setData((current) => ({ ...current, videos: current.videos.filter((video) => video.id !== id) }))
    onNotify?.(`Video "${videoTitle}" eliminado correctamente`, { tone: 'danger' })
  }
  const source = getVideoSource(draft.url)
  const filtered = data.videos.filter((video) => video.title.toLowerCase().includes(query.toLowerCase()))
  const groupOrder = ['operator', 'boss', 'both']
  if (filtered.some((video) => getVideoAudience(video) === 'none')) groupOrder.push('none')
  const libraryGroups = groupOrder.map((audience) => ({
    id: audience,
    ...AUDIENCE_META[audience],
    videos: filtered.filter((video) => getVideoAudience(video) === audience),
  }))
  const visibleLibraryGroups = query.trim() ? libraryGroups.filter((group) => group.videos.length) : libraryGroups

  return (
    <div className="manager-stack">
      {formOpen && (
        <section className="panel video-form-panel">
          <div className="manager-toolbar"><div><span className="eyebrow eyebrow--plain">{editingId ? 'EDITAR CONTENIDO' : 'NUEVO CONTENIDO'}</span><h2>{editingId ? 'Actualizar video' : 'Agregar un video'}</h2></div><button className="icon-button" onClick={() => setFormOpen(false)}><X size={19} /></button></div>
          <form id="video-editor-form" className="video-form" onSubmit={saveVideo}>
            <div className="video-form__main">
              <div className="form-group"><label>Título del video</label><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Ej. Procedimiento de apertura" maxLength="180" /></div>
              <div className="form-group"><label>Descripción</label><textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Explica brevemente qué aprenderá la persona…" rows="4" /></div>
              <div className="form-group"><label>Enlace del video</label><div className="url-input"><UploadCloud size={18} /><input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="Pega un enlace de YouTube, Google Drive, Vimeo o MP4" maxLength="2048" /></div>{draft.url && <small className={`source-detection source-detection--${source.type}`}><i style={{ background: getSourceAccent(source.label) }} /> {source.label}</small>}<small>En Google Drive, configura el archivo como “Cualquier persona con el enlace”.</small></div>
              <div className="thumbnail-config">
                <div className="form-group"><label>Miniatura personalizada <span>(opcional)</span></label><div className="url-input"><ImageIcon size={18} /><input value={draft.thumbnailUrl} onChange={(event) => setDraft({ ...draft, thumbnailUrl: event.target.value })} placeholder="Se obtiene automáticamente; pega una imagen solo si quieres reemplazarla" maxLength="2048" /></div><small>Drive y los archivos directos muestran el fotograma del segundo 4. YouTube, Vimeo y Loom usan la imagen del proveedor.</small></div>
                <div className="thumbnail-preview"><VideoThumbnail video={{ title: draft.title || 'Vista previa', url: draft.url, thumbnailUrl: draft.thumbnailUrl }} /><span><ImageIcon size={18} /></span><small>VISTA PREVIA</small></div>
              </div>
              <div className="form-row"><div className="form-group"><label>Duración (opcional)</label><input value={draft.duration} onChange={(event) => setDraft({ ...draft, duration: event.target.value })} placeholder="Ej. 05:30" maxLength="20" /></div><label className="feature-check"><input type="checkbox" checked={draft.featured} onChange={(event) => setDraft({ ...draft, featured: event.target.checked })} /><span><Sparkles size={16} /></span><div><strong>Video destacado</strong><small>Aparecerá primero en el inicio</small></div></label></div>
            </div>
            <div className="assignment-box">
              <div><h3>Permisos y ubicación</h3><p>Elige exactamente quién lo verá y dónde aparecerá.</p></div>
              {['operator', 'boss'].map((role) => {
                const enabledKey = role === 'operator' ? 'operatorEnabled' : 'bossEnabled'
                const sectionKey = role === 'operator' ? 'operatorSection' : 'bossSection'
                const lockedKey = role === 'operator' ? 'operatorLocked' : 'bossLocked'
                const enabled = draft[enabledKey]
                return (
                  <div className={`assignment-card ${enabled ? 'enabled' : ''}`} key={role}>
                    <label className="switch-line"><span className="role-avatar">{ROLE_META[role].short}</span><div><strong>{ROLE_META[role].label}</strong><small>{enabled ? 'Puede ver este video' : 'Sin acceso'}</small></div><input type="checkbox" checked={enabled} onChange={(event) => setDraft({ ...draft, [enabledKey]: event.target.checked })} /><i /></label>
                    {enabled && <><div className="form-group"><label>Mostrar en la sección</label><select value={draft[sectionKey]} onChange={(event) => setDraft({ ...draft, [sectionKey]: event.target.value })}><option value="">Seleccionar…</option>{sectionsFor(role).map((section) => <option value={section.id} key={section.id}>{section.name}</option>)}</select></div><label className={`role-lock-toggle ${draft[lockedKey] ? 'is-locked' : ''}`}><input type="checkbox" checked={draft[lockedKey]} onChange={(event) => setDraft({ ...draft, [lockedKey]: event.target.checked })} /><span><LockKeyhole size={15} /></span><div><strong>Mostrar como bloqueado</strong><small>Verá la tarjeta, pero no podrá reproducir el video.</small></div><i /></label></>}
                  </div>
                )
              })}
            </div>
            {error && <p className="form-error form-error--box">{error}</p>}
          </form>
          {(editingId || newVideoId) && (
            <div className="quiz-panel-wrap">
              <VideoQuizEditor ref={quizEditorRef} videoId={editingId || newVideoId} videoPending={!persistedVideoIdsRef.current.has(editingId || newVideoId)} hideSaveAction />
            </div>
          )}
          <div className="video-save-floating">
            <button className="primary-button" type="submit" form="video-editor-form" disabled={Boolean(combinedSave)}>
              <Check size={18} /> {combinedSave ? 'Guardando video y cuestionario…' : editingId ? 'Guardar video y cuestionario' : 'Publicar video y cuestionario'}
            </button>
          </div>
        </section>
      )}

      <section className="panel manager-panel">
        <div className="manager-toolbar">
          <div><h2>Biblioteca organizada</h2><p>{data.videos.length} contenidos clasificados por audiencia</p></div>
          <div className="toolbar-actions"><label className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar video…" /></label><button className="primary-button" onClick={openNew}><Plus size={17} /> Agregar video</button></div>
        </div>
        <div className="video-library-groups">
          {visibleLibraryGroups.map((group) => (
            <section className={`video-role-group video-role-group--${group.id}`} key={group.id}>
              <header className="video-role-group__header">
                <div className="video-role-group__title"><span>{group.id === 'both' ? <UsersRound size={16} /> : group.id === 'none' ? <MoreHorizontal size={16} /> : ROLE_META[group.id].short}</span><div><h3>{group.groupLabel}</h3><small>{group.description}</small></div></div>
                <span className="video-role-group__count">{group.videos.length} {group.videos.length === 1 ? 'video' : 'videos'}</span>
                <i className="video-role-group__rule" />
              </header>
              {group.videos.length ? <div className="video-admin-grid video-admin-grid--group">{group.videos.map((video) => <AdminVideoCard video={video} data={data} onEdit={() => openEdit(video)} onDelete={() => deleteVideo(video.id)} key={video.id} />)}</div> : <div className="video-role-group__empty"><Film size={17} /><span>Aún no hay videos en este grupo.</span></div>}
            </section>
          ))}
          {!filtered.length && query && <EmptyState icon={Search} title="No encontramos videos" text="Prueba con otra búsqueda." />}
        </div>
      </section>
    </div>
  )
}

function emptyQuizQuestion() {
  return {
    id: `new-${crypto.randomUUID()}`,
    prompt: '',
    options: [
      { id: `new-${crypto.randomUUID()}`, label: '', isCorrect: true },
      { id: `new-${crypto.randomUUID()}`, label: '', isCorrect: false },
    ],
  }
}

const VideoQuizEditor = forwardRef(function VideoQuizEditor({ videoId, videoPending, hideSaveAction = false }, ref) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [passingScorePercent, setPassingScorePercent] = useState(70)
  const [questions, setQuestions] = useState([])
  const [hasQuiz, setHasQuiz] = useState(false)
  const [savedNote, setSavedNote] = useState('')

  useEffect(() => {
    if (videoPending) { setLoading(false); return undefined }
    let active = true
    setLoading(true)
    setError('')
    getAdminVideoQuiz(videoId)
      .then((quiz) => {
        if (!active) return
        if (quiz && quiz.questions.length) {
          setHasQuiz(true)
          setPassingScorePercent(quiz.passingScorePercent)
          setQuestions(quiz.questions)
        } else {
          setHasQuiz(false)
          setPassingScorePercent(70)
          setQuestions([])
        }
      })
      .catch((quizError) => { if (active) setError(getErrorMessage(quizError, 'No se pudo cargar el cuestionario.')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
    // videoPending se deja fuera a propósito: solo debe decidir si se omite
    // la carga la primera vez que aparece este videoId (video recién creado,
    // sin cuestionario posible todavía). Si se re-ejecutara cuando pasa a
    // "guardado", pisaría con [] las preguntas que el admin ya escribió
    // mientras esperaba.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  const updateQuestion = (questionId, patch) => {
    setQuestions((current) => current.map((question) => (question.id === questionId ? { ...question, ...patch } : question)))
  }
  const updateOption = (questionId, optionId, patch) => {
    setQuestions((current) => current.map((question) => (question.id !== questionId ? question : {
      ...question,
      options: question.options.map((option) => (option.id === optionId ? { ...option, ...patch } : option)),
    })))
  }
  const setCorrectOption = (questionId, optionId) => {
    setQuestions((current) => current.map((question) => (question.id !== questionId ? question : {
      ...question,
      options: question.options.map((option) => ({ ...option, isCorrect: option.id === optionId })),
    })))
  }
  const addQuestion = () => setQuestions((current) => [...current, emptyQuizQuestion()])
  const removeQuestion = (questionId) => setQuestions((current) => current.filter((question) => question.id !== questionId))
  const addOption = (questionId) => setQuestions((current) => current.map((question) => (question.id !== questionId ? question : {
    ...question,
    options: [...question.options, { id: `new-${crypto.randomUUID()}`, label: '', isCorrect: false }],
  })))
  const removeOption = (questionId, optionId) => setQuestions((current) => current.map((question) => {
    if (question.id !== questionId || question.options.length <= 2) return question
    const options = question.options.filter((option) => option.id !== optionId)
    if (!options.some((option) => option.isCorrect)) options[0].isCorrect = true
    return { ...question, options }
  }))

  const validate = () => {
    setError('')
    if (loading) { setError('Espera a que termine de cargar el cuestionario.'); return false }
    // El cuestionario es opcional: un formulario vacío guarda solamente el video.
    if (!questions.length) return true
    for (const question of questions) {
      if (!question.prompt.trim()) { setError('Cada pregunta necesita un enunciado.'); return false }
      if (question.options.length < 2 || question.options.some((option) => !option.label.trim())) {
        setError('Cada pregunta necesita al menos 2 opciones con texto.')
        return false
      }
      if (!question.options.some((option) => option.isCorrect)) { setError('Marca la respuesta correcta de cada pregunta.'); return false }
    }
    return true
  }

  const save = async () => {
    if (!validate()) return false
    if (videoPending) { setError('Espera a que el video termine de guardarse antes de agregar su cuestionario.'); return false }
    if (!questions.length) return true
    const actionLabel = editingUser ? 'guardar los cambios de este usuario' : 'crear este usuario'
    if (!window.confirm(`¿Confirmas que deseas ${actionLabel}?`)) return
    setSaving(true)
    try {
      await saveVideoQuiz(videoId, { passingScorePercent, questions })
      setHasQuiz(true)
      setSavedNote('Cuestionario guardado.')
      window.setTimeout(() => setSavedNote(''), 2500)
      return true
    } catch (saveError) {
      setError(getErrorMessage(saveError, 'No se pudo guardar el cuestionario.'))
      return false
    } finally {
      setSaving(false)
    }
  }

  useImperativeHandle(ref, () => ({ save, validate }))

  const remove = async () => {
    if (!window.confirm('¿Eliminar el cuestionario de este video?')) return
    setSaving(true)
    setError('')
    try {
      await deleteVideoQuiz(videoId)
      setHasQuiz(false)
      setQuestions([])
    } catch (deleteError) {
      setError(getErrorMessage(deleteError, 'No se pudo eliminar el cuestionario.'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="quiz-panel"><p>Cargando cuestionario…</p></div>

  return (
    <div className="quiz-panel">
      <div className="quiz-panel__head">
        <div><h3>Cuestionario de comprobación</h3><p>Se muestra cuando el usuario termina de ver el video al 100%.</p></div>
        {hasQuiz && <button type="button" className="icon-button danger" onClick={remove} disabled={saving}><Trash2 size={15} /></button>}
      </div>

      {videoPending && <div className="quiz-empty"><ClipboardList size={17} /><span>El video se está guardando en Supabase. Ya puedes escribir las preguntas; el botón de guardar se activará en unos segundos.</span></div>}
      {!videoPending && !questions.length && <div className="quiz-empty"><ClipboardList size={17} /><span>Este video todavía no tiene cuestionario.</span></div>}

      {questions.map((question, index) => (
        <div className="quiz-question" key={question.id}>
          <div className="quiz-question__head">
            <span>Pregunta {index + 1}</span>
            {questions.length > 1 && <button type="button" className="icon-button" onClick={() => removeQuestion(question.id)}><Trash2 size={14} /></button>}
          </div>
          <div className="form-group"><input value={question.prompt} onChange={(event) => updateQuestion(question.id, { prompt: event.target.value })} placeholder="Escribe la pregunta" maxLength="500" /></div>
          {question.options.map((option) => (
            <div className="quiz-option-row" key={option.id}>
              <input type="text" value={option.label} onChange={(event) => updateOption(question.id, option.id, { label: event.target.value })} placeholder="Texto de la opción" maxLength="240" />
              <label><input type="radio" name={`correct-${question.id}`} checked={option.isCorrect} onChange={() => setCorrectOption(question.id, option.id)} /> Correcta</label>
              {question.options.length > 2 && <button type="button" className="icon-button" onClick={() => removeOption(question.id, option.id)}><X size={14} /></button>}
            </div>
          ))}
          <button type="button" className="text-button" onClick={() => addOption(question.id)}><Plus size={14} /> Agregar opción</button>
        </div>
      ))}

      <button type="button" className="secondary-button" onClick={addQuestion}><Plus size={15} /> Agregar pregunta</button>

      <div className="form-group quiz-panel__passing">
        <label>Puntaje mínimo para aprobar</label>
        <input type="number" min="1" max="100" value={passingScorePercent} onChange={(event) => setPassingScorePercent(Math.min(100, Math.max(1, Number(event.target.value) || 1)))} />
      </div>

      {error && <p className="form-error">{error}</p>}
      {savedNote && <p className="quiz-saved-note">{savedNote}</p>}

      {!hideSaveAction && <div className="form-actions">
        <button
          type="button"
          className="primary-button"
          onClick={save}
          disabled={saving || videoPending}
          title={videoPending ? 'Espera a que el video termine de guardarse en Supabase' : undefined}
        >
          {saving ? 'Guardando…' : videoPending ? 'Esperando al video…' : 'Guardar cuestionario'}
        </button>
      </div>}
    </div>
  )
})

function AdminVideoCard({ video, data, onEdit, onDelete }) {
  const source = getPersistedVideoSource(video)
  const audience = getVideoAudience(video)
  const audienceMeta = AUDIENCE_META[audience]
  const lockedRoles = VIEWER_ROLES.filter((role) => isVideoLockedFor(video, role))
  const getSection = (id) => data.sections.find((section) => section.id === id)?.name || 'Sin sección'
  return (
    <article className="admin-video-card">
      <div className="admin-video-card__visual">
        <VideoThumbnail video={video} />
        <span className="source-badge"><i style={{ background: getSourceAccent(source.label) }} /> {source.label}</span>
        <span className={`audience-badge audience-badge--${audience}`}><UsersRound size={11} /> {audienceMeta.label}</span>
        <span className="play-orb"><Play size={20} fill="currentColor" /></span>
        {!!lockedRoles.length && <span className="role-lock-statuses">{lockedRoles.map((role) => <span className="role-lock-status" key={role}><LockKeyhole size={9} /> {ROLE_META[role].short} bloqueado</span>)}</span>}
        <small>{video.duration}</small>
      </div>
      <div className="admin-video-card__body"><div className="card-title-row"><h3>{video.title}</h3>{video.featured && <Sparkles size={15} />}</div><p>{video.description}</p><div className="assignment-tags">{Object.entries(video.assignments).map(([role, sectionId]) => <span className={isVideoLockedFor(video, role) ? 'is-locked' : ''} key={role}><b>{ROLE_META[role].short}</b>{getSection(sectionId)}{isVideoLockedFor(video, role) && <LockKeyhole size={10} />}</span>)}{video.quiz && <span><b><ClipboardList size={10} /></b>{video.quiz.questionCount} {video.quiz.questionCount === 1 ? 'pregunta' : 'preguntas'}</span>}</div></div>
      <div className="admin-video-card__actions"><button onClick={onEdit}><Pencil size={15} /> Editar</button><button className="danger" onClick={onDelete}><Trash2 size={15} /></button></div>
    </article>
  )
}

const emptyUserDraft = { username: '', displayName: '', role: 'operator', password: '', jobTitle: '', department: '' }
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/

function UsersManager({ onCreateUser, onUpdateUser, onNotify }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [draft, setDraft] = useState(emptyUserDraft)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setLoadError('')
    try {
      setUsers(await listManagedUsers())
    } catch (fetchError) {
      setLoadError(getErrorMessage(fetchError, 'No se pudieron cargar los usuarios.'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const openCreate = () => {
    setEditingUser(null)
    setDraft(emptyUserDraft)
    setError('')
    setFormOpen(true)
  }

  const openEdit = (user) => {
    setEditingUser(user)
    setDraft({ username: user.username, displayName: user.displayName, role: user.role, password: '', jobTitle: user.jobTitle || '', department: user.department || '' })
    setError('')
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditingUser(null)
  }

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    const displayName = draft.displayName.trim()
    const username = draft.username.trim().toLowerCase()
    const jobTitle = draft.jobTitle.trim()
    const department = draft.department.trim()

    if (!displayName) {
      setError('Escribe un nombre para el usuario.')
      return
    }
    if (!jobTitle) {
      setError('Escribe el cargo del usuario.')
      return
    }
    if (!department) {
      setError('Escribe el área del usuario.')
      return
    }
    if (!editingUser && !USERNAME_PATTERN.test(username)) {
      setError('El usuario debe tener entre 3 y 32 caracteres (minúsculas, números, puntos o guiones).')
      return
    }
    if (!editingUser && draft.password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.')
      return
    }
    if (editingUser && draft.password && draft.password.length < 8) {
      setError('La nueva contraseña debe tener al menos 8 caracteres.')
      return
    }

    setSaving(true)
    try {
      if (editingUser) {
        await onUpdateUser({
          userId: editingUser.userId,
          displayName,
          role: draft.role,
          newPassword: draft.password || undefined,
          jobTitle,
          department,
        })
      } else {
        await onCreateUser({ username, password: draft.password, role: draft.role, displayName, jobTitle, department })
      }
      onNotify?.(editingUser ? 'Usuario actualizado correctamente' : 'Usuario creado correctamente')
      closeForm()
      await refresh()
    } catch (saveError) {
      setError(getErrorMessage(saveError, 'No se pudo guardar el usuario.'))
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (user) => {
    if (!window.confirm(`¿${user.active ? 'Deshabilitar' : 'Habilitar'} al usuario “${user.displayName || user.username}”?`)) return
    try {
      await onUpdateUser({ userId: user.userId, active: !user.active })
      onNotify?.(`Usuario ${user.active ? 'desactivado' : 'activado'} correctamente`)
      await refresh()
    } catch (toggleError) {
      setLoadError(getErrorMessage(toggleError, 'No se pudo actualizar el usuario.'))
    }
  }

  return (
    <div className="access-layout">
      <section className="panel access-panel manager-panel">
        <div className="manager-toolbar">
          <div><h2>Usuarios operante y jefe</h2><p>Crea cuentas individuales y controla su acceso.</p></div>
          <button className="primary-button" onClick={() => (formOpen ? closeForm() : openCreate())}>{formOpen ? <X size={17} /> : <Plus size={17} />} {formOpen ? 'Cancelar' : 'Nuevo usuario'}</button>
        </div>

        {formOpen && (
          <form className="inline-form inline-form--wrap" onSubmit={submit}>
            <div className="form-group"><label>Usuario</label><input value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} placeholder="ej. jperez" disabled={!!editingUser} autoFocus={!editingUser} /></div>
            <div className="form-group grow"><label>Nombre completo</label><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} placeholder="Nombre completo" /></div>
            <div className="form-group"><label>Rol</label><select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })}><option value="operator">Operante</option><option value="boss">Jefe</option></select></div>
            <div className="form-group grow"><label>Cargo</label><input value={draft.jobTitle} onChange={(event) => setDraft({ ...draft, jobTitle: event.target.value })} placeholder="ej. Supervisor de bodega" /></div>
            <div className="form-group grow"><label>Área</label><input value={draft.department} onChange={(event) => setDraft({ ...draft, department: event.target.value })} placeholder="ej. Logística" /></div>
            <div className="form-group"><label>{editingUser ? 'Nueva contraseña' : 'Contraseña'}</label><input type="password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} placeholder={editingUser ? 'Dejar en blanco para no cambiar' : '••••••••'} autoComplete="new-password" /></div>
            <button className="primary-button form-submit" type="submit" disabled={saving}>{saving ? 'Guardando…' : editingUser ? 'Guardar cambios' : 'Crear usuario'}</button>
          </form>
        )}
        {error && <p className="form-error form-error--box access-error">{error}</p>}

        <div className="user-list">
          <div className="user-list__head"><span>Usuario</span><span>Rol</span><span>Estado</span><span>Acciones</span></div>
          {!loading && loadError && <p className="form-error access-error">{loadError}</p>}
          {!loading && !loadError && users.map((user) => (
            <div className="user-row" key={user.userId}>
              <div className="section-identity"><span className="section-icon"><User size={18} /></span><div><strong>{user.displayName || user.username}</strong><small>@{user.username} · {user.jobTitle || 'Sin cargo'} · {user.department || 'Sin área'}</small></div></div>
              <span className="status-badge">{ROLE_META[user.role]?.label || user.role}</span>
              <span className={`status-badge ${user.active ? '' : 'status-badge--off'}`}>{user.active ? 'Activo' : 'Deshabilitado'}</span>
              <div className="row-actions">
                <button onClick={() => openEdit(user)} aria-label="Editar"><Pencil size={16} /></button>
                <button className={user.active ? 'danger' : ''} onClick={() => toggleActive(user)} aria-label={user.active ? 'Deshabilitar' : 'Habilitar'}>{user.active ? <X size={16} /> : <Check size={16} />}</button>
              </div>
            </div>
          ))}
          {!loading && !loadError && !users.length && <EmptyState icon={UsersRound} title="Aún no hay usuarios" text="Crea la primera cuenta de operante o jefe." />}
        </div>
      </section>
      <aside className="security-card"><span><LockKeyhole size={22} /></span><h3>Cuentas individuales</h3><p>Cada usuario inicia sesión con su propio usuario y contraseña, administrados por Supabase Auth.</p><ul><li><Check size={14} /> Contraseñas fuera del frontend</li><li><Check size={14} /> Sesiones administradas por Supabase</li><li><Check size={14} /> Permisos RLS por rol</li></ul></aside>
    </div>
  )
}

function ProgressManager({ data }) {
  const [users, setUsers] = useState([])
  const [progress, setProgress] = useState([])
  const [quizResults, setQuizResults] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [selectedUser, setSelectedUser] = useState(null)
  const [userAttempts, setUserAttempts] = useState([])
  const [userAttemptsLoading, setUserAttemptsLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError('')
    // Los cuestionarios dependen de una migración aparte; si todavía no se
    // aplicó, se degrada a "sin cuestionarios" en vez de tumbar toda la
    // pantalla de progreso (que sí debe verse con o sin esa función).
    const quizResultsPromise = listVideoQuizResults().catch((quizError) => {
      console.warn('No se pudieron leer los cuestionarios respondidos (¿falta aplicar la migración?):', quizError?.message)
      return []
    })
    Promise.all([listManagedUsers(), listWatchProgress(), quizResultsPromise])
      .then(([usersResult, progressResult, quizResultsResult]) => {
        if (!active) return
        setUsers(usersResult)
        setProgress(progressResult)
        setQuizResults(quizResultsResult)
      })
      .catch((fetchError) => {
        if (active) setLoadError(getErrorMessage(fetchError, 'No se pudo cargar el progreso.'))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const eligibleVideoIdsByRole = useMemo(() => {
    const result = { operator: new Set(), boss: new Set() }
    for (const role of ['operator', 'boss']) {
      const visibleSectionIds = new Set(data.sections.filter((section) => section.roles.includes(role)).map((section) => section.id))
      data.videos.forEach((video) => {
        if (visibleSectionIds.has(video.assignments[role]) && !isVideoLockedFor(video, role)) {
          result[role].add(video.id)
        }
      })
    }
    return result
  }, [data.sections, data.videos])

  const quizVideoIds = useMemo(() => new Set(data.videos.filter((video) => video.quiz).map((video) => video.id)), [data.videos])

  const completedByUser = useMemo(() => {
    const map = new Map()
    progress.forEach((row) => {
      if (!row.completed) return
      if (!map.has(row.userId)) map.set(row.userId, new Set())
      map.get(row.userId).add(row.videoId)
    })
    return map
  }, [progress])

  const passedQuizzesByUser = useMemo(() => {
    const map = new Map()
    quizResults.forEach((row) => {
      if (!row.passed) return
      if (!map.has(row.userId)) map.set(row.userId, new Set())
      map.get(row.userId).add(row.videoId)
    })
    return map
  }, [quizResults])

  const attemptedQuizzesByUser = useMemo(() => {
    const map = new Map()
    quizResults.forEach((row) => {
      if (!row.attemptsCount) return
      if (!map.has(row.userId)) map.set(row.userId, new Set())
      map.get(row.userId).add(row.videoId)
    })
    return map
  }, [quizResults])

  // Base para la gráfica "Actividad por video": por cada video, cuántas de
  // las personas que pueden verlo ya lo vieron / ya respondieron su
  // cuestionario, contra cuántas todavía no.
  const videoActivityStats = useMemo(() => {
    return data.videos
      .map((video) => {
        const eligibleRoles = ['operator', 'boss'].filter((role) => eligibleVideoIdsByRole[role]?.has(video.id))
        const eligibleUsers = users.filter((user) => eligibleRoles.includes(user.role))
        const total = eligibleUsers.length
        const watchedCount = eligibleUsers.filter((user) => completedByUser.get(user.userId)?.has(video.id)).length
        const attemptedCount = eligibleUsers.filter((user) => attemptedQuizzesByUser.get(user.userId)?.has(video.id)).length
        return { id: video.id, title: video.title, hasQuiz: Boolean(video.quiz), total, watchedCount, attemptedCount }
      })
      .filter((row) => row.total > 0)
  }, [data.videos, eligibleVideoIdsByRole, users, completedByUser, attemptedQuizzesByUser])

  const openUserActivity = (user) => {
    setSelectedUser(user)
    setUserAttempts([])
    setUserAttemptsLoading(true)
    listQuizAttemptsForUser(user.userId)
      .then(setUserAttempts)
      .catch(() => setUserAttempts([]))
      .finally(() => setUserAttemptsLoading(false))
  }

  const exportExcel = async () => {
    setExporting(true)
    setExportError('')
    try {
      const allAttempts = await listAllQuizAttempts()
      const videosByRole = {
        operator: data.videos.filter((video) => eligibleVideoIdsByRole.operator.has(video.id)),
        boss: data.videos.filter((video) => eligibleVideoIdsByRole.boss.has(video.id)),
      }
      await downloadUsersExcel({
        organization: data.organization,
        users,
        videosByRole,
        progress,
        quizResults,
        quizAttempts: allAttempts,
      })
    } catch (fetchError) {
      setExportError(getErrorMessage(fetchError, 'No se pudo generar el Excel.'))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="manager-stack">
      <section className="panel manager-panel">
        <div className="manager-toolbar">
          <div><h2>Progreso por usuario</h2><p>Un video cuenta como visto al alcanzar el 100% de su duración; el cuestionario se suma como paso adicional.</p></div>
          <button className="secondary-button" type="button" onClick={exportExcel} disabled={exporting || loading}><Download size={15} /> {exporting ? 'Generando…' : 'Descargar Excel'}</button>
        </div>
        {exportError && <p className="form-error access-error">{exportError}</p>}
        <VideoActivityChart stats={videoActivityStats} />
        <div className="progress-list">
          <div className="progress-list__head"><span>Usuario</span><span>Rol</span><span>Videos vistos</span><span>Cuestionarios</span><span /></div>
          {!loading && loadError && <p className="form-error access-error">{loadError}</p>}
          {!loading && !loadError && users.map((user) => {
            const eligible = eligibleVideoIdsByRole[user.role] || new Set()
            const completed = completedByUser.get(user.userId) || new Set()
            const completedCount = [...eligible].filter((id) => completed.has(id)).length
            const total = eligible.size
            const percent = total ? Math.round((completedCount / total) * 100) : 0

            const eligibleQuizzes = [...eligible].filter((id) => quizVideoIds.has(id))
            const passedQuizzes = passedQuizzesByUser.get(user.userId) || new Set()
            const passedCount = eligibleQuizzes.filter((id) => passedQuizzes.has(id)).length
            const quizTotal = eligibleQuizzes.length

            return (
              <button type="button" className="progress-row progress-row--clickable" onClick={() => openUserActivity(user)} title="Ver videos vistos y respuestas del cuestionario" key={user.userId}>
                <div className="section-identity"><span className="section-icon"><User size={18} /></span><div><strong>{user.displayName || user.username}</strong><small>@{user.username} · {user.jobTitle || 'Sin cargo'} · {user.department || 'Sin área'}</small></div></div>
                <span className="status-badge">{ROLE_META[user.role]?.label || user.role}</span>
                <div className="progress-bar-cell">
                  <div className="progress-bar"><i style={{ width: `${percent}%` }} /></div>
                  <span>{total ? `${completedCount}/${total} · ${percent}%` : 'Sin videos asignados'}</span>
                </div>
                {quizTotal ? (
                  <span className={`quiz-status-badge ${passedCount === quizTotal ? 'quiz-status-badge--passed' : 'quiz-status-badge--pending'}`}>
                    {passedCount === quizTotal ? <ClipboardCheck size={11} /> : <CircleAlert size={11} />} {passedCount}/{quizTotal} aprobados
                  </span>
                ) : <span className="quiz-status-badge quiz-status-badge--none">Sin cuestionarios</span>}
                <span className="progress-row__detail"><ChevronRight size={16} /></span>
              </button>
            )
          })}
          {!loading && !loadError && !users.length && <EmptyState icon={BarChart3} title="Aún no hay usuarios" text="Crea usuarios de operante o jefe para ver su progreso." />}
        </div>
      </section>

      {selectedUser && (
        <UserActivityModal
          user={selectedUser}
          videos={data.videos.filter((video) => (eligibleVideoIdsByRole[selectedUser.role] || new Set()).has(video.id))}
          watchedVideoIds={completedByUser.get(selectedUser.userId) || new Set()}
          quizResults={quizResults.filter((row) => row.userId === selectedUser.userId)}
          quizAttempts={userAttempts}
          attemptsLoading={userAttemptsLoading}
          onClose={() => setSelectedUser(null)}
        />
      )}
    </div>
  )
}

function VideoActivityChart({ stats }) {
  const [metric, setMetric] = useState('watched')
  const rows = metric === 'quiz' ? stats.filter((row) => row.hasQuiz) : stats

  return (
    <div className="activity-chart">
      <div className="activity-chart__head">
        <div><h3>Actividad por video</h3><p>De las personas que pueden ver cada video, cuántas ya lo vieron o ya respondieron su cuestionario.</p></div>
        <div className="activity-chart__toggle">
          <button type="button" className={metric === 'watched' ? 'active' : ''} onClick={() => setMetric('watched')}><Eye size={13} /> Videos vistos</button>
          <button type="button" className={metric === 'quiz' ? 'active' : ''} onClick={() => setMetric('quiz')}><ClipboardList size={13} /> Cuestionarios</button>
        </div>
      </div>
      <div className="activity-chart__body">
        {!rows.length && <p className="activity-chart__empty">{metric === 'quiz' ? 'Ningún video tiene cuestionario todavía.' : 'Todavía no hay videos con usuarios asignados.'}</p>}
        {rows.map((row) => {
          const count = metric === 'watched' ? row.watchedCount : row.attemptedCount
          const percent = row.total ? Math.round((count / row.total) * 100) : 0
          return (
            <div className="activity-chart__row" key={row.id} title={`${count} de ${row.total} · ${percent}%`}>
              <span className="activity-chart__label">{row.title}</span>
              <div className="activity-chart__bar"><i style={{ width: `${percent}%` }} /></div>
              <span className="activity-chart__value">{count}/{row.total}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function UserActivityModal({ user, videos, watchedVideoIds, quizResults, quizAttempts, attemptsLoading, onClose }) {
  const [quizDefinitions, setQuizDefinitions] = useState(new Map())
  const [quizDefinitionsLoading, setQuizDefinitionsLoading] = useState(false)
  const [quizDefinitionsError, setQuizDefinitionsError] = useState('')
  const quizVideoIdsKey = videos.filter((video) => video.quiz).map((video) => video.id).sort().join(',')

  useEffect(() => {
    let active = true
    const videoIds = quizVideoIdsKey ? quizVideoIdsKey.split(',') : []
    setQuizDefinitions(new Map())
    setQuizDefinitionsError('')

    if (!videoIds.length) {
      setQuizDefinitionsLoading(false)
      return () => { active = false }
    }

    setQuizDefinitionsLoading(true)
    Promise.allSettled(videoIds.map(async (videoId) => [videoId, await getAdminVideoQuiz(videoId)]))
      .then((results) => {
        if (!active) return
        const definitions = new Map()
        let failedCount = 0
        results.forEach((result) => {
          if (result.status === 'fulfilled' && result.value[1]) definitions.set(...result.value)
          else if (result.status === 'rejected') failedCount += 1
        })
        setQuizDefinitions(definitions)
        if (failedCount) setQuizDefinitionsError('No se pudieron recuperar todas las alternativas actuales. Se muestran los datos conservados en cada intento.')
      })
      .finally(() => { if (active) setQuizDefinitionsLoading(false) })

    return () => { active = false }
  }, [quizVideoIdsKey])

  const attemptsByVideo = useMemo(() => {
    const map = new Map()
    quizAttempts.forEach((attempt) => {
      if (!map.has(attempt.videoId)) map.set(attempt.videoId, [])
      map.get(attempt.videoId).push(attempt)
    })
    return map
  }, [quizAttempts])

  const resultByVideo = useMemo(() => {
    const map = new Map()
    quizResults.forEach((row) => map.set(row.videoId, row))
    return map
  }, [quizResults])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-panel__head">
          <div>
            <h2>{user.displayName || user.username}</h2>
            <p>@{user.username} · {ROLE_META[user.role]?.label || user.role} · {user.jobTitle || 'Sin cargo'} · {user.department || 'Sin área'}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
        </div>
        <div className="modal-panel__body">
          {quizDefinitionsError && <p className="quiz-attempt-notice"><CircleAlert size={14} /> {quizDefinitionsError}</p>}
          {!videos.length && <p className="quiz-empty">No tiene videos asignados.</p>}
          {videos.map((video) => {
            const watched = watchedVideoIds.has(video.id)
            const attempts = attemptsByVideo.get(video.id) || []
            const result = resultByVideo.get(video.id)
            return (
              <div className="user-activity-video" key={video.id}>
                <div className="user-activity-video__head">
                  <strong>{video.title}</strong>
                  <div className="user-activity-video__badges">
                    {watched ? <span className="watched-badge"><CircleCheck size={11} /> Visto</span> : <span className="quiz-status-badge quiz-status-badge--none">No visto</span>}
                    {video.quiz && (
                      result?.passed
                        ? <span className="quiz-status-badge quiz-status-badge--passed"><ClipboardCheck size={11} /> Cuestionario aprobado</span>
                        : attempts.length
                          ? <span className="quiz-status-badge quiz-status-badge--pending"><CircleAlert size={11} /> Cuestionario sin aprobar</span>
                          : <span className="quiz-status-badge quiz-status-badge--none">Sin intentos de cuestionario</span>
                    )}
                  </div>
                </div>
                {video.quiz && (attemptsLoading || quizDefinitionsLoading) && <p className="quiz-attempt-loading">Cargando detalle de intentos…</p>}
                {video.quiz && !attemptsLoading && attempts.map((attempt) => (
                  <details className="quiz-attempt" key={attempt.id}>
                    <summary>
                      <span>Intento {attempt.attemptNumber}</span>
                      <span className={`quiz-attempt__score ${attempt.passed ? 'quiz-attempt__score--passed' : 'quiz-attempt__score--failed'}`}>{attempt.scorePercent}% · {attempt.passed ? 'Aprobado' : 'No aprobado'}</span>
                      <span className="quiz-attempt__date">{new Date(attempt.createdAt).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    </summary>
                    <div className="quiz-attempt__content">
                      <AttemptPhotoPreview photoPath={attempt.photoPath} attemptNumber={attempt.attemptNumber} />
                      <div className="quiz-attempt__answers">
                        {attempt.answers.map((answer, index) => {
                          const question = quizDefinitions.get(video.id)?.questions?.find((item) => item.id === answer.questionId)
                          const options = buildAttemptOptions(answer, question)
                          return (
                            <article className={`quiz-attempt-question ${answer.isCorrect ? 'is-correct' : 'is-incorrect'}`} key={answer.questionId || index}>
                              <div className="quiz-attempt-question__head">
                                <span>Pregunta {index + 1}</span>
                                <span>{answer.isCorrect ? <><CircleCheck size={12} /> Correcta</> : <><CircleAlert size={12} /> Incorrecta</>}</span>
                              </div>
                              <strong>{answer.prompt}</strong>
                              <div className="quiz-attempt-options">
                                {options.map((option) => (
                                  <div
                                    className={`quiz-attempt-option ${option.selected ? 'is-selected' : ''} ${option.correct ? 'is-correct-answer' : ''} ${option.selected && !option.correct ? 'is-selected-wrong' : ''}`}
                                    key={option.id}
                                  >
                                    <span className="quiz-attempt-option__marker">{option.selected ? <Check size={12} /> : null}</span>
                                    <span>{option.label}</span>
                                    <span className="quiz-attempt-option__badges">
                                      {option.selected && <small>Marcada por el usuario</small>}
                                      {option.correct && <small>Respuesta correcta</small>}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </article>
                          )
                        })}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function buildAttemptOptions(answer, question) {
  const options = (question?.options || []).map((option) => ({
    id: option.id,
    label: option.label,
    selected: option.id === answer.selectedOptionId || (!answer.selectedOptionId && option.label === answer.selectedLabel),
    correct: Boolean(option.isCorrect) || option.label === answer.correctLabel,
  }))

  if (answer.selectedLabel && !options.some((option) => option.selected)) {
    options.push({ id: `selected-${answer.questionId}`, label: answer.selectedLabel, selected: true, correct: answer.isCorrect })
  }
  if (answer.correctLabel && !options.some((option) => option.correct)) {
    const matchingOption = options.find((option) => option.label === answer.correctLabel)
    if (matchingOption) matchingOption.correct = true
    else options.push({ id: `correct-${answer.questionId}`, label: answer.correctLabel, selected: false, correct: true })
  }

  return options
}

function AttemptPhotoPreview({ photoPath, attemptNumber }) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(Boolean(photoPath))
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)

  const loadPhoto = useCallback(async () => {
    if (!photoPath) return
    setLoading(true)
    setError('')
    try {
      setUrl(await getQuizAttemptPhotoUrl(photoPath))
    } catch (photoError) {
      setError(getErrorMessage(photoError, 'No se pudo cargar la foto.'))
    } finally {
      setLoading(false)
    }
  }, [photoPath])

  useEffect(() => { loadPhoto() }, [loadPhoto])

  useEffect(() => {
    if (!expanded) return undefined
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event) => { if (event.key === 'Escape') setExpanded(false) }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [expanded])

  return (
    <>
      <aside className="quiz-attempt-photo">
        <div className="quiz-attempt-photo__head"><Camera size={14} /><span>Foto del intento</span></div>
        {!photoPath && <div className="quiz-attempt-photo__empty"><ImageIcon size={24} /><span>Este intento no tiene foto registrada.</span></div>}
        {photoPath && loading && <div className="quiz-attempt-photo__empty"><span className="loading-spinner" /><span>Cargando foto…</span></div>}
        {photoPath && !loading && url && (
          <button type="button" className="quiz-attempt-photo__open" onClick={() => setExpanded(true)} title="Ampliar foto">
            <img src={url} alt={`Foto tomada en el intento ${attemptNumber}`} loading="lazy" />
            <span><Eye size={13} /> Ampliar imagen</span>
          </button>
        )}
        {error && <div className="quiz-attempt-photo__empty is-error"><CircleAlert size={20} /><span>{error}</span><button type="button" onClick={loadPhoto}>Reintentar</button></div>}
      </aside>
      {expanded && createPortal(
        <div className="attempt-lightbox" role="dialog" aria-modal="true" aria-label={`Foto ampliada del intento ${attemptNumber}`} onClick={() => setExpanded(false)}>
          <div className="attempt-lightbox__content" onClick={(event) => event.stopPropagation()}>
            <div className="attempt-lightbox__head">
              <div><Camera size={16} /><span>Foto del intento {attemptNumber}</span></div>
              <button type="button" onClick={() => setExpanded(false)} aria-label="Cerrar imagen ampliada"><X size={20} /></button>
            </div>
            <img src={url} alt={`Foto ampliada tomada en el intento ${attemptNumber}`} />
            <small>Presiona Esc o haz clic fuera de la imagen para cerrar.</small>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function RolePreview({ data }) {
  const [role, setRole] = useState('operator')
  const [activeSection, setActiveSection] = useState('home')
  const [selectedVideo, setSelectedVideo] = useState(null)
  const [selectedDocument, setSelectedDocument] = useState(null)
  const [query, setQuery] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => {
    if (!selectedVideo) return
    const freshVideo = data.videos.find((video) => video.id === selectedVideo.id)
    if (!freshVideo || !isVideoAssignedTo(freshVideo, role) || isVideoLockedFor(freshVideo, role)) {
      setSelectedVideo(null)
    } else if (freshVideo !== selectedVideo) {
      setSelectedVideo(freshVideo)
    }
  }, [data.videos, role, selectedVideo])
  const sections = useMemo(() => [...data.sections].filter((section) => section.roles.includes(role)).sort((a, b) => a.order - b.order), [data.sections, role])
  const visibleSectionIds = new Set(sections.filter((section) => section.contentType !== 'documents').map((section) => section.id))
  const videos = data.videos.filter((video) => visibleSectionIds.has(video.assignments[role]))
  const visibleDocumentSectionIds = new Set(sections.filter((section) => section.contentType === 'documents').map((section) => section.id))
  const documents = (data.documents || []).filter((document) => visibleDocumentSectionIds.has(document.sectionId))
  const blockedVideos = videos.filter((video) => isVideoLockedFor(video, role))
  const availableVideos = videos.filter((video) => !isVideoLockedFor(video, role))
  const activeSectionData = sections.find((section) => section.id === activeSection)
  const featured = availableVideos.find((video) => video.featured) || availableVideos[0]
  const filtered = videos.filter((video) => {
    const belongs = activeSection === 'home' || video.assignments[role] === activeSection
    const matches = `${video.title} ${video.description}`.toLowerCase().includes(query.toLowerCase())
    return belongs && matches
  })
  const filteredDocuments = documents.filter((document) => {
    const belongs = activeSection === 'home' || document.sectionId === activeSection
    return belongs && (document.title + ' ' + document.fileName).toLowerCase().includes(query.toLowerCase())
  })

  const resetPreview = () => {
    setActiveSection('home')
    setSelectedVideo(null)
    setSelectedDocument(null)
    setQuery('')
    setNavOpen(false)
  }

  const switchRole = (nextRole) => {
    setRole(nextRole)
    resetPreview()
  }

  const navigate = (sectionId) => {
    setActiveSection(sectionId)
    setSelectedVideo(null)
    setSelectedDocument(null)
    setNavOpen(false)
  }

  const openVideo = (video) => {
    if (!video || isVideoLockedFor(video, role)) return
    setSelectedVideo(video)
  }

  return (
    <div className="manager-stack">
      <section className="preview-switcher"><div><span>Visualizando como</span><strong>{ROLE_META[role].label} · {availableVideos.length} disponibles · {blockedVideos.length} bloqueados</strong></div><div>{['operator', 'boss'].map((item) => <button className={item === role ? 'active' : ''} onClick={() => switchRole(item)} key={item}>{ROLE_META[item].short} {ROLE_META[item].label}</button>)}</div></section>
      <section className="panel role-preview-frame">
        <header className="role-preview-chrome"><div aria-hidden="true"><i /><i /><i /></div><span><Eye size={13} /> Vista interactiva: navega como lo haría este rol</span><button type="button" onClick={resetPreview}><Home size={14} /> Reiniciar vista</button></header>
        <div className="role-preview-app">
          <button className={`role-preview-overlay ${navOpen ? 'is-visible' : ''}`} onClick={() => setNavOpen(false)} aria-label="Cerrar menú de la vista previa" />
          <aside className={`role-preview-sidebar ${navOpen ? 'is-open' : ''}`}>
            <div className="role-preview-brand"><CompanyLogo compact /></div>
            <nav className="sidebar-nav viewer-nav">
              <small className="sidebar-label">EXPLORAR</small>
              <button className={activeSection === 'home' ? 'active' : ''} onClick={() => navigate('home')}><Home size={18} /><span>Inicio</span></button>
              <small className="sidebar-label sidebar-label--spaced">MI CONTENIDO</small>
              {sections.map((section) => { const isDocuments = section.contentType === 'documents'; const Icon = isDocuments ? FileText : (ICONS[section.icon] || Layers3); const count = isDocuments ? documents.filter((document) => document.sectionId === section.id).length : videos.filter((video) => video.assignments[role] === section.id).length; return <button className={activeSection === section.id ? 'active' : ''} onClick={() => navigate(section.id)} key={section.id}><Icon size={18} /><span>{section.name}</span><small>{count}</small></button> })}
            </nav>
            <div className="sidebar-help"><span><CircleHelp size={16} /></span><div><strong>¿Necesitas ayuda?</strong><small>{data.settings?.supportMessage || 'Contacta a tu administrador'}</small></div></div>
            <div className="role-preview-sidebar-foot"><Eye size={15} /> Vista simulada</div>
          </aside>

          <section className="role-preview-main">
            <header className="role-preview-topbar">
              <button className="role-preview-menu" onClick={() => setNavOpen(true)} aria-label="Abrir menú de la vista previa"><Menu size={19} /></button>
              <label className="global-search"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setSelectedVideo(null); setSelectedDocument(null) }} placeholder="Buscar videos o documentos…" /></label>
              <div className="viewer-profile"><div><span>Bienvenido</span><strong>{ROLE_META[role].label}</strong></div><span className="role-avatar">{ROLE_META[role].short}</span></div>
            </header>
            <main className="role-preview-content">
              {selectedDocument ? (
                <DocumentViewerPage document={selectedDocument} onBack={() => setSelectedDocument(null)} />
              ) : selectedVideo ? (
                <VideoPlayerPage video={selectedVideo} role={role} data={data} onBack={() => setSelectedVideo(null)} onPlay={openVideo} />
              ) : activeSection === 'home' && !query ? (
                <ViewerHome role={role} settings={data.settings} videos={videos} documents={documents} sections={sections} featured={featured} lockedCount={blockedVideos.length} onPlay={openVideo} onSection={navigate} />
              ) : activeSectionData?.contentType === 'documents' || (activeSection === 'home' && query && filteredDocuments.length) ? (
                <DocumentListing title={activeSection === 'home' ? 'Resultados de documentos' : activeSectionData?.name || 'Documentos'} subtitle="Documentos disponibles para consulta" documents={filteredDocuments} onOpen={setSelectedDocument} />
              ) : (
                <VideoListing role={role} title={activeSection === 'home' ? 'Resultados de búsqueda' : activeSectionData?.name || 'Videos'} subtitle={query ? `Resultados para “${query}”` : 'Contenido seleccionado para este perfil'} videos={filtered} onPlay={openVideo} />
              )}
            </main>
          </section>
        </div>
      </section>
      <div className="info-callout"><Eye size={19} /><div><strong>Simulación fiel y segura</strong><p>Puedes usar el menú, el buscador, las categorías y los videos. Esta simulación no modifica permisos ni datos; solo reproduce la experiencia del rol seleccionado.</p></div></div>
    </div>
  )
}

function ViewerApp({ role, userId, data, theme, toggleTheme, onLogout }) {
  const [completedVideoIds, setCompletedVideoIds] = useState(() => new Set())
  const sections = useMemo(() => [...data.sections].filter((section) => section.roles.includes(role)).sort((a, b) => a.order - b.order), [data.sections, role])
  const targetedVideos = useMemo(() => {
    const visibleSectionIds = new Set(sections.filter((section) => section.contentType !== 'documents').map((section) => section.id))
    return data.videos
      .filter((video) => visibleSectionIds.has(video.assignments[role]))
      .map((video) => completedVideoIds.has(video.id) && !video.watched ? { ...video, watched: true } : video)
  }, [completedVideoIds, data.videos, role, sections])
  const targetedDocuments = useMemo(() => {
    const visibleSectionIds = new Set(sections.filter((section) => section.contentType === 'documents').map((section) => section.id))
    return (data.documents || []).filter((document) => visibleSectionIds.has(document.sectionId))
  }, [data.documents, sections])
  const playableVideos = useMemo(() => targetedVideos.filter((video) => !isVideoLockedFor(video, role)), [role, targetedVideos])
  const [activeSection, setActiveSection] = useState('home')
  const [selectedVideo, setSelectedVideo] = useState(null)
  const [selectedDocument, setSelectedDocument] = useState(null)
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  useEffect(() => {
    if (!selectedVideo) return
    const freshVideo = data.videos.find((video) => video.id === selectedVideo.id)
    if (!freshVideo || !isVideoAssignedTo(freshVideo, role) || isVideoLockedFor(freshVideo, role)) {
      setSelectedVideo(null)
    } else if (freshVideo !== selectedVideo) {
      setSelectedVideo(freshVideo)
    }
  }, [data.videos, role, selectedVideo])

  const openVideo = (video) => {
    if (!video || isVideoLockedFor(video, role)) return
    setSelectedVideo(video)
  }

  const openDocument = (document) => {
    if (document) setSelectedDocument(document)
  }

  const markVideoCompleted = useCallback((videoId) => {
    setCompletedVideoIds((current) => {
      if (current.has(videoId)) return current
      const next = new Set(current)
      next.add(videoId)
      return next
    })
  }, [])

  const navigate = (sectionId) => {
    setActiveSection(sectionId)
    setSelectedVideo(null)
    setSelectedDocument(null)
    setMenuOpen(false)
  }

  const filtered = targetedVideos.filter((video) => {
    const belongs = activeSection === 'home' || video.assignments[role] === activeSection
    const matches = `${video.title} ${video.description}`.toLowerCase().includes(query.toLowerCase())
    return belongs && matches
  })
  const filteredDocuments = targetedDocuments.filter((document) => {
    const belongs = activeSection === 'home' || document.sectionId === activeSection
    const matches = (document.title + ' ' + document.fileName).toLowerCase().includes(query.toLowerCase())
    return belongs && matches
  })

  const activeSectionData = sections.find((section) => section.id === activeSection)
  const featured = playableVideos.find((video) => video.featured) || playableVideos[0]
  const lockedCount = targetedVideos.filter((video) => isVideoLockedFor(video, role)).length

  return (
    <div className={`app-layout viewer-layout ${sidebarCollapsed ? 'app-layout--sidebar-collapsed' : ''}`}>
      <button className={`mobile-overlay ${menuOpen ? 'is-visible' : ''}`} onClick={() => setMenuOpen(false)} aria-label="Cerrar menú" />
      <aside className={`sidebar viewer-sidebar ${sidebarCollapsed && !menuOpen ? 'sidebar--collapsed' : ''} ${menuOpen ? 'is-open' : ''}`}>
        <div className="sidebar__top"><CompanyLogo compact /><button className="sidebar-close" onClick={() => setMenuOpen(false)}><X size={20} /></button></div>
        <button
          type="button"
          className="sidebar-collapse"
          onClick={() => setSidebarCollapsed((value) => !value)}
          aria-label={sidebarCollapsed ? 'Expandir barra lateral' : 'Contraer barra lateral'}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? 'Expandir barra lateral' : 'Contraer barra lateral'}
        >
          {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
        <nav className="sidebar-nav viewer-nav">
          <small className="sidebar-label">EXPLORAR</small>
          <button className={activeSection === 'home' ? 'active' : ''} onClick={() => navigate('home')} title={sidebarCollapsed ? 'Inicio' : undefined}><Home size={19} /><span>Inicio</span></button>
          <small className="sidebar-label sidebar-label--spaced">MI CONTENIDO</small>
          {sections.map((section) => { const Icon = section.contentType === 'documents' ? FileText : (ICONS[section.icon] || Layers3); const count = section.contentType === 'documents' ? targetedDocuments.filter((document) => document.sectionId === section.id).length : targetedVideos.filter((video) => video.assignments[role] === section.id).length; return <button className={activeSection === section.id ? 'active' : ''} onClick={() => navigate(section.id)} title={sidebarCollapsed ? section.name : undefined} key={section.id}><Icon size={19} /><span>{section.name}</span><small>{count}</small></button> })}
        </nav>
        <div className="sidebar-help"><span><CircleHelp size={17} /></span><div><strong>¿Necesitas ayuda?</strong><small>{data.settings?.supportMessage || 'Contacta a tu administrador'}</small></div></div>
        <div className="sidebar__bottom">{data.settings?.allowLightMode !== false && <ThemeToggle theme={theme} onToggle={toggleTheme} />}<button className="sidebar-action" onClick={onLogout} title={sidebarCollapsed ? 'Cerrar sesión' : undefined}><LogOut size={18} /><span>Cerrar sesión</span></button></div>
      </aside>

      <section className="main-shell viewer-main">
        <header className="topbar viewer-topbar">
          <button className="mobile-menu" onClick={() => setMenuOpen(true)}><Menu size={21} /></button>
          <label className="global-search"><Search size={18} /><input value={query} onChange={(event) => { setQuery(event.target.value); setSelectedVideo(null); setSelectedDocument(null) }} placeholder="Buscar videos o documentos…" /></label>
          <div className="viewer-profile"><div><span>Bienvenido</span><strong>{ROLE_META[role].label}</strong></div><span className="role-avatar">{ROLE_META[role].short}</span></div>
        </header>

        <main className="content-area viewer-content">
          {selectedDocument ? (
            <DocumentViewerPage document={selectedDocument} onBack={() => setSelectedDocument(null)} />
          ) : selectedVideo ? (
            <VideoPlayerPage video={selectedVideo} role={role} userId={userId} data={data} onBack={() => setSelectedVideo(null)} onPlay={openVideo} onCompleted={markVideoCompleted} />
          ) : activeSection === 'home' && !query ? (
            <ViewerHome role={role} settings={data.settings} videos={targetedVideos} documents={targetedDocuments} sections={sections} featured={featured} lockedCount={lockedCount} onPlay={openVideo} onSection={navigate} />
          ) : activeSectionData?.contentType === 'documents' || (activeSection === 'home' && query && filteredDocuments.length) ? (
            <DocumentListing title={activeSection === 'home' ? 'Resultados de documentos' : activeSectionData?.name || 'Documentos'} subtitle={query ? `Resultados para “${query}”` : 'Documentos disponibles para consulta'} documents={filteredDocuments} onOpen={openDocument} />
          ) : (
            <VideoListing role={role} title={activeSection === 'home' ? 'Resultados de búsqueda' : activeSectionData?.name || 'Videos'} subtitle={query ? `Resultados para “${query}”` : 'Contenido seleccionado para tu perfil'} videos={filtered} onPlay={openVideo} />
          )}
        </main>
      </section>
    </div>
  )
}

function ViewerHome({ role, settings, videos, documents, sections, featured, lockedCount, onPlay, onSection }) {
  const recent = [...videos].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  const availableCount = videos.length - lockedCount
  return (
    <div className="viewer-home">
      <div className="viewer-welcome"><div><span className="eyebrow"><Sparkles size={14} /> {settings?.productName || 'TU ESPACIO DE APRENDIZAJE'}</span><h1>{settings?.welcomeTitle || <>Hola, <em>{ROLE_META[role].label}</em></>}</h1><p>{settings?.welcomeMessage || 'Continúa aprendiendo con el contenido preparado para ti.'}</p></div><div className="viewer-date"><Clock3 size={17} /><span>Contenido actualizado</span></div></div>
      {featured && (
        <section className="hero-video">
          <VideoThumbnail video={featured} className="hero-video__media" />
          <div className="hero-video__texture" />
          <div className="hero-video__copy"><span className="featured-label"><Sparkles size={13} /> DESTACADO</span><h2>{featured.title}</h2><p>{featured.description}</p><div><button className="light-button" onClick={() => onPlay(featured)}><Play size={17} fill="currentColor" /> Reproducir ahora</button><span><Clock3 size={15} /> {featured.duration}</span>{featured.watched && <span className="watched-badge"><CircleCheck size={11} /> Visto</span>}{featured.watched && featured.quiz && !featured.quizResult?.passed && <span className="quiz-status-badge quiz-status-badge--pending"><CircleAlert size={11} /> Falta el cuestionario</span>}</div></div>
          <button className="hero-video__play" onClick={() => onPlay(featured)} aria-label={`Reproducir ${featured.title}`}><Play size={28} fill="currentColor" /></button>
        </section>
      )}
      <div className="viewer-section-heading"><div><span className="eyebrow eyebrow--plain">RECIENTES</span><h2>Continúa explorando</h2></div><span>{availableCount} disponibles{lockedCount ? ` · ${lockedCount} bloqueados` : ''}</span></div>
      <div className="viewer-video-grid">{recent.slice(0, 6).map((video) => <ViewerVideoCard role={role} video={video} section={sections.find((item) => item.id === video.assignments[role])} onPlay={() => onPlay(video)} key={video.id} />)}</div>
      {!videos.length && <EmptyState icon={Film} title="Todavía no hay contenido" text="El administrador aún no ha habilitado videos para tu perfil." />}
      <section className="category-strip"><div className="viewer-section-heading"><div><span className="eyebrow eyebrow--plain">SECCIONES</span><h2>Explora por categoría</h2></div></div><div className="category-grid">{sections.map((section) => { const isDocuments = section.contentType === 'documents'; const Icon = isDocuments ? FileText : (ICONS[section.icon] || Layers3); const count = isDocuments ? documents.filter((document) => document.sectionId === section.id).length : videos.filter((video) => video.assignments[role] === section.id).length; return <button onClick={() => onSection(section.id)} key={section.id}><span><Icon size={20} /></span><div><strong>{section.name}</strong><small>{count} {isDocuments ? (count === 1 ? 'documento' : 'documentos') : (count === 1 ? 'video' : 'videos')}</small></div><ChevronRight size={17} /></button> })}</div></section>
      {lockedCount > 0 && <div className="locked-notice"><LockKeyhole size={18} /><div><strong>Contenido bloqueado por el administrador</strong><p>{lockedCount} {lockedCount === 1 ? 'video aparece bloqueado' : 'videos aparecen bloqueados'} en tu biblioteca. Puedes identificarlos, pero no abrirlos ni reproducirlos.</p></div></div>}
    </div>
  )
}

function VideoListing({ role, title, subtitle, videos, onPlay }) {
  return (
    <div>
      <div className="listing-heading"><span className="eyebrow eyebrow--plain">BIBLIOTECA</span><h1>{title}</h1><p>{subtitle}</p></div>
      <div className="viewer-video-grid">{videos.map((video) => <ViewerVideoCard role={role} video={video} onPlay={() => onPlay(video)} key={video.id} />)}</div>
      {!videos.length && <EmptyState icon={Search} title="No hay resultados" text="No encontramos videos con esos criterios." />}
    </div>
  )
}

function DocumentListing({ title, subtitle, documents, onOpen }) {
  return (
    <div>
      <div className="listing-heading"><span className="eyebrow eyebrow--plain">DOCUMENTOS</span><h1>{title}</h1><p>{subtitle}</p></div>
      <div className="viewer-document-grid">
        {documents.map((document) => <article className="viewer-document-card" key={document.id} onClick={() => onOpen(document)}><span className="viewer-document-card__icon"><FileText size={27} /><small>{document.mimeType.includes('word') ? 'WORD' : 'PDF'}</small></span><div><small>{formatDocumentSize(document.fileSize)}</small><h3>{document.title}</h3><p>{document.fileName}</p><button type="button" onClick={(event) => { event.stopPropagation(); onOpen(document) }}><Eye size={14} /> Visualizar documento</button></div></article>)}
      </div>
      {!documents.length && <EmptyState icon={FileText} title="No hay documentos" text="El administrador aún no ha publicado documentos en esta sección." />}
    </div>
  )
}

function formatDocumentSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Documento'
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function DocumentViewerPage({ document, onBack }) {
  const [viewUrl, setViewUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    getSectionDocumentViewUrl(document)
      .then((url) => {
        if (!active) return
        if (!url) throw new Error('No se recibió un enlace de visualización.')
        setViewUrl(url)
      })
      .catch((viewError) => {
        if (active) setError(getErrorMessage(viewError, 'No se pudo abrir el documento.'))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [document])

  const isWord = document.mimeType.includes('word') || document.mimeType.includes('officedocument')
  const embeddedUrl = isWord && viewUrl
    ? 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(viewUrl)
    : viewUrl

  return (
    <div className="document-viewer-page">
      <button type="button" className="back-button" onClick={onBack}><ArrowLeft size={16} /> Volver a documentos</button>
      <div className="document-viewer-heading"><span><FileText size={20} /></span><div><small>SOLO LECTURA · {isWord ? 'WORD' : 'PDF'} · {formatDocumentSize(document.fileSize)}</small><h1>{document.title}</h1><p>{document.fileName}</p></div></div>
      <section className="document-frame" aria-busy={loading}>
        {loading && <div className="document-frame__status"><span className="loading-spinner" /><strong>Preparando documento…</strong></div>}
        {!loading && error && <div className="document-frame__status document-frame__status--error"><CircleAlert size={28} /><strong>No se pudo mostrar el documento</strong><p>{error}</p></div>}
        {!loading && !error && embeddedUrl && <iframe src={embeddedUrl} title={document.title} referrerPolicy="no-referrer" />}
      </section>
      <div className="info-callout"><ShieldCheck size={19} /><div><strong>Vista protegida</strong><p>Este archivo se abre con un enlace temporal y solo está disponible para usuarios autorizados en esta sección.</p></div></div>
    </div>
  )
}

function ViewerVideoCard({ role, video, section, onPlay }) {
  const locked = isVideoLockedFor(video, role)
  const source = locked ? null : getPersistedVideoSource(video)
  const watched = Boolean(video.watched)
  const quizPending = watched && video.quiz && !video.quizResult?.passed
  const handlePlay = (event) => {
    event.stopPropagation()
    if (!locked) onPlay()
  }
  return (
    <article className={`viewer-video-card ${locked ? 'viewer-video-card--locked' : ''}`} onClick={locked ? undefined : onPlay} aria-disabled={locked}>
      <div className="viewer-video-card__visual">{!locked && <VideoThumbnail video={video} />}{source && <span className="source-badge"><i style={{ background: getSourceAccent(source.label) }} />{source.label}</span>}{locked ? <div className="viewer-video-card__lock"><span><LockKeyhole size={19} /></span><strong>Video bloqueado</strong></div> : <button type="button" onClick={handlePlay} aria-label={`Reproducir ${video.title}`}><Play size={19} fill="currentColor" /></button>}<small>{video.duration}</small></div>
      <div className="viewer-video-card__body">
        {section && <span>{section.name}</span>}
        <h3>{video.title}</h3>
        <p>{locked ? 'El administrador mantiene este contenido bloqueado para tu rol.' : video.description}</p>
        {!locked && (watched || quizPending) && (
          <div className="viewer-video-card__badges">
            {watched && <span className="watched-badge"><CircleCheck size={11} /> Visto</span>}
            {quizPending && <span className="quiz-status-badge quiz-status-badge--pending"><CircleAlert size={11} /> Falta el cuestionario</span>}
          </div>
        )}
        <button type="button" disabled={locked} onClick={handlePlay}>{locked ? <><LockKeyhole size={13} /> Contenido bloqueado</> : <>Ver video <ArrowRight size={14} /></>}</button>
      </div>
    </article>
  )
}

// Un intervalo corto permite guardar avance incluso en clips de pocos segundos.
const PROGRESS_REPORT_INTERVAL_SECONDS = 2
const YOUTUBE_PROGRESS_POLL_MS = 250
const PLAYBACK_END_TOLERANCE_SECONDS = 0.75

let youTubeApiPromise = null

// Carga el reproductor oficial de YouTube (script permitido en la CSP) una
// sola vez por sesión. Con él leemos currentTime/duration reales en vez de
// aproximarlos, igual que con un <video> nativo.
function loadYouTubeIframeApi() {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'))
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (youTubeApiPromise) return youTubeApiPromise

  youTubeApiPromise = new Promise((resolve, reject) => {
    const previousCallback = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.()
      resolve(window.YT)
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.onerror = () => {
      youTubeApiPromise = null
      script.remove()
      reject(new Error('No se pudo cargar el reproductor de YouTube'))
    }
    document.head.appendChild(script)
  })

  return youTubeApiPromise
}

function VideoPlayerMedia({ source, title, video, userId, onCompleted }) {
  const frameClassName = source.provider === 'google_drive'
    ? 'video-frame video-frame--google-drive'
    : 'video-frame'

  const maxProgressRef = useRef(0)
  const lastReportedRef = useRef(0)
  const completedNotifiedRef = useRef(false)
  const completionReportedRef = useRef(false)
  const iframeRef = useRef(null)
  const youtubeContainerRef = useRef(null)
  const coveredSecondsRef = useRef(new Set())
  const lastPlaybackSampleRef = useRef(null)
  const lastPlaybackSampleAtRef = useRef(null)
  // Duración real observada por el propio reproductor (metadata del <video>
  // nativo o player.getDuration() de YouTube). No es la duración que el admin
  // escribió al crear el video: esa es solo un texto opcional para mostrar en
  // pantalla y puede faltar o estar mal escrita.
  const realDurationRef = useRef(null)
  // Duración conocida por la etiqueta que escribió el admin (mm:ss), usada
  // como respaldo para detectar "100% visto" en proveedores que no exponen
  // ninguna API de progreso (Drive, Vimeo, Loom) mientras llega la próxima
  // sincronización con el servidor.
  const labelDurationSecondsRef = useRef(parseDurationSeconds(video?.duration))
  const youtubeElementId = useMemo(
    () => `youtube-player-${video?.id || 'x'}-${Math.random().toString(36).slice(2, 8)}`,
    [video?.id],
  )

  const notifyCompleted = useCallback(() => {
    if (completedNotifiedRef.current) return
    completedNotifiedRef.current = true
    onCompleted?.()
  }, [onCompleted])

  const reportProgress = useCallback((seconds, { ended = false } = {}) => {
    if (!userId || !video?.id) return
    lastReportedRef.current = seconds
    recordVideoProgress({
      videoId: video.id,
      userId,
      progressSeconds: seconds,
      durationSeconds: realDurationRef.current || undefined,
      ended,
    }).catch(() => {
      // El progreso es informativo; un fallo de red no debe interrumpir la reproducción.
    })
  }, [userId, video?.id])

  const capturePlaybackSample = useCallback((seconds, duration, playbackRate = 1) => {
    if (!Number.isFinite(seconds) || seconds < 0) return coveredSecondsRef.current.size
    const now = performance.now()
    const previous = lastPlaybackSampleRef.current
    const elapsed = lastPlaybackSampleAtRef.current === null ? 0 : (now - lastPlaybackSampleAtRef.current) / 1000
    const delta = previous === null ? 0 : seconds - previous
    const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1
    const continuous = previous === null || (delta >= -0.15 && delta <= (Math.max(0, elapsed) * rate) + 0.8)
    const start = Math.floor(continuous && previous !== null ? Math.min(previous, seconds) : seconds)
    const end = Math.floor(seconds)
    for (let second = start; second <= end; second += 1) {
      if (!Number.isFinite(duration) || second < duration) coveredSecondsRef.current.add(second)
    }
    lastPlaybackSampleRef.current = seconds
    lastPlaybackSampleAtRef.current = now
    return coveredSecondsRef.current.size
  }, [])

  const resetPlaybackSample = useCallback(() => {
    lastPlaybackSampleRef.current = null
    lastPlaybackSampleAtRef.current = null
  }, [])

  const hasFullPlaybackCoverage = useCallback((duration) => {
    if (!Number.isFinite(duration) || duration <= 0) return false
    for (let second = 0; second < Math.max(1, Math.floor(duration)); second += 1) {
      if (!coveredSecondsRef.current.has(second)) return false
    }
    return true
  }, [])

  const trackMaxProgress = useCallback((seconds) => {
    if (seconds <= maxProgressRef.current) return
    maxProgressRef.current = seconds
  }, [])

  useEffect(() => {
    maxProgressRef.current = 0
    lastReportedRef.current = 0
    realDurationRef.current = null
    completedNotifiedRef.current = false
    completionReportedRef.current = false
    coveredSecondsRef.current = new Set()
    resetPlaybackSample()
    labelDurationSecondsRef.current = parseDurationSeconds(video?.duration)
    if (!video?.id || source.type !== 'iframe') return undefined

    if (source.provider === 'youtube') {
      let player = null
      let pollInterval = null
      let cancelled = false
      const container = youtubeContainerRef.current
      if (!container) return undefined
      container.replaceChildren()
      const youtubeIframe = document.createElement('iframe')
      youtubeIframe.id = youtubeElementId
      youtubeIframe.src = `${source.embedUrl}?enablejsapi=1&playsinline=1&origin=${encodeURIComponent(window.location.origin)}`
      youtubeIframe.title = title
      youtubeIframe.referrerPolicy = 'strict-origin-when-cross-origin'
      youtubeIframe.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share'
      youtubeIframe.allowFullscreen = true
      container.appendChild(youtubeIframe)

      loadYouTubeIframeApi().then((YT) => {
        if (cancelled) return
        player = new YT.Player(youtubeIframe, {
          events: {
            onReady: () => {
              pollInterval = window.setInterval(() => {
                const current = player?.getCurrentTime?.()
                const duration = player?.getDuration?.()
                if (Number.isFinite(duration) && duration > 0) realDurationRef.current = duration
                if (Number.isFinite(current)) {
                  trackMaxProgress(current)
                  const playerState = player?.getPlayerState?.()
                  const coveredSeconds = playerState === YT.PlayerState.PLAYING
                    ? capturePlaybackSample(current, duration, player?.getPlaybackRate?.())
                    : coveredSecondsRef.current.size
                  if (playerState !== YT.PlayerState.PLAYING) resetPlaybackSample()
                  if (coveredSeconds - lastReportedRef.current >= PROGRESS_REPORT_INTERVAL_SECONDS) reportProgress(coveredSeconds)
                  // En clips muy cortos algunos navegadores desmontan o
                  // cambian el iframe antes de que llegue el evento ENDED.
                  // Estar reproduciendo dentro del último tramo confirma el
                  // final usando la duración real informada por YouTube.
                  if (
                    !completionReportedRef.current
                    && Number.isFinite(duration)
                    && duration > 0
                    && current >= duration - PLAYBACK_END_TOLERANCE_SECONDS
                    && playerState === YT.PlayerState.PLAYING
                    && hasFullPlaybackCoverage(duration)
                  ) {
                    completionReportedRef.current = true
                    reportProgress(coveredSeconds, { ended: true })
                    notifyCompleted()
                  }
                }
              }, YOUTUBE_PROGRESS_POLL_MS)
            },
            onStateChange: (event) => {
              // ENDED = 0. No esperamos al siguiente sondeo ni al desmontaje:
              // se reporta de inmediato para que "visto completo" no se pierda
              // si el usuario deja la pestaña abierta sin navegar.
              if (event.data === YT.PlayerState.ENDED) {
                const finalSeconds = Math.max(maxProgressRef.current, realDurationRef.current || 0)
                maxProgressRef.current = finalSeconds
                if (!completionReportedRef.current && hasFullPlaybackCoverage(realDurationRef.current)) {
                  completionReportedRef.current = true
                  reportProgress(coveredSecondsRef.current.size, { ended: true })
                  notifyCompleted()
                } else if (!completionReportedRef.current) {
                  reportProgress(coveredSecondsRef.current.size)
                }
              }
            },
          },
        })
      }).catch(() => {
        // Si el script de YouTube no carga (red, bloqueador de anuncios, etc.)
        // simplemente no se reporta progreso para este video.
      })

      return () => {
        cancelled = true
        if (pollInterval) window.clearInterval(pollInterval)
        player?.destroy?.()
        container.replaceChildren()
        if (coveredSecondsRef.current.size > lastReportedRef.current) reportProgress(coveredSecondsRef.current.size)
      }
    }

    if (source.provider === 'vimeo' && iframeRef.current) {
      const player = new VimeoPlayer(iframeRef.current)
      const handleVimeoTimeUpdate = ({ seconds, duration, percent }) => {
        if (Number.isFinite(duration) && duration > 0) realDurationRef.current = duration
        const coveredSeconds = Number.isFinite(seconds) ? capturePlaybackSample(seconds, duration) : coveredSecondsRef.current.size
        if (Number.isFinite(seconds)) trackMaxProgress(seconds)
        if (coveredSeconds - lastReportedRef.current >= PROGRESS_REPORT_INTERVAL_SECONDS) reportProgress(coveredSeconds)
        // Vimeo documenta timeupdate aproximadamente cada 250 ms. El umbral
        // cubre videos donde el último evento llega justo antes de percent=1.
        if (!completionReportedRef.current && Number.isFinite(percent) && percent >= 0.995 && hasFullPlaybackCoverage(duration)) {
          completionReportedRef.current = true
          reportProgress(coveredSeconds, { ended: true })
          notifyCompleted()
        }
      }
      const handleVimeoEnded = ({ seconds, duration } = {}) => {
        if (!completionReportedRef.current && hasFullPlaybackCoverage(duration || realDurationRef.current)) {
          completionReportedRef.current = true
          reportProgress(coveredSecondsRef.current.size, { ended: true })
          notifyCompleted()
        } else if (!completionReportedRef.current) {
          reportProgress(coveredSecondsRef.current.size)
        }
      }
      const handleVimeoSeeking = () => resetPlaybackSample()
      player.on('timeupdate', handleVimeoTimeUpdate)
      player.on('ended', handleVimeoEnded)
      player.on('seeking', handleVimeoSeeking)

      return () => {
        player.off('timeupdate', handleVimeoTimeUpdate)
        player.off('ended', handleVimeoEnded)
        player.off('seeking', handleVimeoSeeking)
        if (coveredSecondsRef.current.size > lastReportedRef.current) reportProgress(coveredSecondsRef.current.size)
      }
    }

    // Google Drive y Loom no exponen una API de progreso equivalente para su
    // vista previa incrustada. Se aproxima el avance con el tiempo real que el
    // reproductor permanece visible y la pestaña está activa.
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const nextProgress = maxProgressRef.current + 1
      trackMaxProgress(nextProgress)
      const knownDuration = labelDurationSecondsRef.current
      if (knownDuration && nextProgress >= knownDuration) notifyCompleted()
      if (nextProgress - lastReportedRef.current >= PROGRESS_REPORT_INTERVAL_SECONDS) reportProgress(nextProgress)
    }, 1000)

    return () => {
      window.clearInterval(interval)
        if (coveredSecondsRef.current.size > lastReportedRef.current) reportProgress(coveredSecondsRef.current.size)
    }
  }, [video?.id, userId, source.type, source.provider, source.embedUrl, title, youtubeElementId, capturePlaybackSample, hasFullPlaybackCoverage, reportProgress, resetPlaybackSample, trackMaxProgress, notifyCompleted])

  const captureRealDuration = (element) => {
    if (Number.isFinite(element.duration) && element.duration > 0) {
      realDurationRef.current = Math.round(element.duration)
    }
  }

  const handleTimeUpdate = (event) => {
    captureRealDuration(event.currentTarget)
    const current = event.currentTarget.currentTime
    trackMaxProgress(current)
    const coveredSeconds = capturePlaybackSample(current, event.currentTarget.duration, event.currentTarget.playbackRate)
    if (coveredSeconds - lastReportedRef.current >= PROGRESS_REPORT_INTERVAL_SECONDS) reportProgress(coveredSeconds)
  }

  const handlePause = (event) => {
    captureRealDuration(event.currentTarget)
    resetPlaybackSample()
    if (coveredSecondsRef.current.size > lastReportedRef.current) reportProgress(coveredSecondsRef.current.size)
  }

  const handleEnded = (event) => {
    captureRealDuration(event.currentTarget)
    const duration = realDurationRef.current || event.currentTarget.duration
    if (hasFullPlaybackCoverage(duration)) {
      reportProgress(coveredSecondsRef.current.size, { ended: true })
      notifyCompleted()
    } else {
      reportProgress(coveredSecondsRef.current.size)
    }
  }

  return (
    <div className={frameClassName} data-player-mode={source.type}>
      {source.type === 'video' ? (
        <video
          src={source.embedUrl}
          controls
          preload="metadata"
          playsInline
          onTimeUpdate={userId ? handleTimeUpdate : undefined}
          onSeeking={userId ? resetPlaybackSample : undefined}
          onPause={userId ? handlePause : undefined}
          onEnded={userId ? handleEnded : undefined}
        />
      ) : source.provider === 'youtube' ? (
        <div ref={youtubeContainerRef} className="youtube-player-host" />
      ) : source.type === 'iframe' ? (
        <iframe
          ref={iframeRef}
          src={source.embedUrl}
          title={title}
          referrerPolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      ) : (
        <div className="video-error"><Film size={32} /><p>No se pudo cargar este enlace.</p></div>
      )}
    </div>
  )
}

function VideoPlayerPage({ video, role, userId, data, onBack, onPlay, onCompleted }) {
  const [justCompleted, setJustCompleted] = useState(false)
  useEffect(() => { setJustCompleted(false) }, [video.id])

  if (!isVideoAssignedTo(video, role) || isVideoLockedFor(video, role)) {
    return <div className="player-page"><button className="back-button" onClick={onBack}><ArrowLeft size={17} /> Volver a la biblioteca</button><div className="player-blocked-state"><span><LockKeyhole size={28} /></span><h2>Este video está bloqueado</h2><p>El administrador no ha habilitado su reproducción para tu rol.</p></div></div>
  }
  const source = getPersistedVideoSource(video)
  const section = data.sections.find((item) => item.id === video.assignments[role])
  const related = data.videos.filter((item) => item.id !== video.id && item.assignments[role] === video.assignments[role] && !isVideoLockedFor(item, role)).slice(0, 3)
  const isWatched = Boolean(video.watched) || justCompleted
  const hasQuiz = Boolean(video.quiz)
  const quizPassed = Boolean(video.quizResult?.passed)
  const showQuiz = hasQuiz && !quizPassed
  return (
    <div className="player-page">
      <button className="back-button" onClick={onBack}><ArrowLeft size={17} /> Volver a la biblioteca</button>
      <div className="player-layout">
        <div>
          <VideoPlayerMedia key={video.id} source={source} title={video.title} video={video} userId={userId} onCompleted={() => { setJustCompleted(true); onCompleted?.(video.id) }} />
          <div className="player-copy">
            <div className="player-meta">
              <span>{section?.name || 'Video'}</span>
              <span><i style={{ background: getSourceAccent(source.label) }} />{source.label}</span>
              <span><Clock3 size={14} /> {video.duration}</span>
              {isWatched && <span className="watched-badge"><CircleCheck size={12} /> Visto</span>}
              {hasQuiz && quizPassed && <span className="quiz-status-badge quiz-status-badge--passed"><ClipboardCheck size={12} /> Cuestionario aprobado</span>}
            </div>
            <h1>{video.title}</h1><p>{video.description}</p>
          </div>
          {showQuiz && <PlayerQuiz video={video} userId={userId} organizationId={data.organizationId} requirePhoto={Boolean(data.settings?.requireQuizPhoto)} isWatched={isWatched} />}
        </div>
        <aside className="related-panel"><span className="eyebrow eyebrow--plain">A CONTINUACIÓN</span><h3>En esta sección</h3>{related.map((item) => <button key={item.id} onClick={() => onPlay(item)}><span><Play size={13} fill="currentColor" /></span><div><strong>{item.title}</strong><small>{item.duration}</small></div></button>)}{!related.length && <p>No hay más videos en esta sección.</p>}<div className="privacy-mini"><ShieldCheck size={17} /><span>Contenido autorizado para {ROLE_META[role].label}</span></div></aside>
      </div>
    </div>
  )
}

function PlayerQuiz({ video, userId, organizationId, requirePhoto, isWatched }) {
  const passingScore = video.quiz?.passingScorePercent ?? 70
  // 'intro' -> (si se exige foto) 'camera' -> 'quiz'
  const [phase, setPhase] = useState('intro')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [questions, setQuestions] = useState([])
  const [answers, setAnswers] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
  const [photoPath, setPhotoPath] = useState(null)
  const [cameraError, setCameraError] = useState('')
  const [capturingPhoto, setCapturingPhoto] = useState(false)
  const [quizLoadKey, setQuizLoadKey] = useState(0)
  const [cameraDevices, setCameraDevices] = useState([])
  const [selectedCameraId, setSelectedCameraId] = useState('')
  const [cameraRetryKey, setCameraRetryKey] = useState(0)
  const cameraVideoRef = useRef(null)
  const cameraStreamRef = useRef(null)

  useEffect(() => {
    setPhase('intro')
    setQuestions([])
    setAnswers({})
    setResult(null)
    setPhotoPath(null)
    setError('')
    setCameraError('')
  }, [video.id])

  useEffect(() => {
    if (phase !== 'quiz') return
    let active = true
    setLoading(true)
    setError('')
    setQuestions([])
    getPlayableVideoQuiz(video.id)
      .then((quiz) => { if (active) setQuestions(quiz?.questions || []) })
      .catch((quizError) => { if (active) setError(getErrorMessage(quizError, 'No se pudo cargar el cuestionario.')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [phase, video.id, quizLoadKey])

  useEffect(() => {
    if (phase !== 'camera') return
    let cancelled = false
    setCameraError('')
    const constraints = selectedCameraId
      ? { video: { deviceId: { exact: selectedCameraId } }, audio: false }
      : { video: { facingMode: 'user' }, audio: false }
    const cameraRequest = navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices.getUserMedia(constraints)
      : Promise.reject(Object.assign(new Error('Cámara no disponible'), { name: 'NotSupportedError' }))
    cameraRequest
      .then(async (stream) => {
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return }
        cameraStreamRef.current = stream
        if (cameraVideoRef.current) cameraVideoRef.current.srcObject = stream

        // Los nombres de cámara solo se conocen después de dar permiso, así
        // que la lista de dispositivos se arma recién aquí.
        const activeDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId || ''
        try {
          const devices = await navigator.mediaDevices.enumerateDevices()
          if (cancelled) return
          const cameras = devices.filter((device) => device.kind === 'videoinput')
          setCameraDevices(cameras)
          if (!selectedCameraId && activeDeviceId) setSelectedCameraId(activeDeviceId)
        } catch {
          // Sin lista de dispositivos igual se puede seguir usando la cámara activa.
        }
      })
      .catch((cameraAccessError) => {
        if (cancelled) return
        if (cameraAccessError?.name === 'NotAllowedError' || cameraAccessError?.name === 'SecurityError') {
          setCameraError('El navegador bloqueó el permiso de cámara. Abre el candado junto a la dirección de esta página, permite la cámara y luego pulsa “Volver a conectar”.')
        } else if (cameraAccessError?.name === 'NotFoundError' || cameraAccessError?.name === 'OverconstrainedError') {
          setCameraError('No encontramos una cámara disponible. Conecta una cámara o elige otra y pulsa “Volver a conectar”.')
        } else {
          setCameraError('No se pudo iniciar la cámara. Comprueba que ninguna otra aplicación la esté usando y pulsa “Volver a conectar”.')
        }
      })
    return () => {
      cancelled = true
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
      cameraStreamRef.current = null
    }
  }, [cameraRetryKey, phase, selectedCameraId])

  const reconnectCamera = () => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
    cameraStreamRef.current = null
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null
    setCameraError('')
    setSelectedCameraId('')
    setCameraRetryKey((key) => key + 1)
  }

  const startQuiz = () => {
    setError('')
    if (!isWatched) {
      setError('Primero debes ver el video completo para poder responder el cuestionario.')
      return
    }
    if (requirePhoto) {
      setPhase('camera')
    } else {
      setQuizLoadKey((key) => key + 1)
      setPhase('quiz')
    }
  }

  const capturePhoto = async () => {
    const videoEl = cameraVideoRef.current
    if (!videoEl || !videoEl.videoWidth) return
    setCapturingPhoto(true)
    setCameraError('')
    try {
      const canvas = document.createElement('canvas')
      canvas.width = videoEl.videoWidth
      canvas.height = videoEl.videoHeight
      canvas.getContext('2d').drawImage(videoEl, 0, 0)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
      if (!blob) throw new Error('No se pudo capturar la foto.')
      const path = await uploadQuizAttemptPhoto({ organizationId, userId, videoId: video.id, blob })
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
      setPhotoPath(path)
      setQuizLoadKey((key) => key + 1)
      setPhase('quiz')
    } catch (captureError) {
      setCameraError(getErrorMessage(captureError, 'No se pudo guardar la foto. Inténtalo de nuevo.'))
    } finally {
      setCapturingPhoto(false)
    }
  }

  const selectAnswer = (questionId, optionId) => {
    setAnswers((current) => ({ ...current, [questionId]: optionId }))
  }

  const allAnswered = questions.length > 0 && questions.every((question) => answers[question.id])

  const submit = async () => {
    if (!allAnswered || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const payload = questions.map((question) => ({ questionId: question.id, optionId: answers[question.id] }))
      setResult(await submitVideoQuizAttempt(video.id, payload, photoPath))
    } catch (submitError) {
      setError(getErrorMessage(submitError, 'No se pudo enviar el cuestionario.'))
    } finally {
      setSubmitting(false)
    }
  }

  const retry = () => {
    setResult(null)
    setAnswers({})
    setPhotoPath(null)
    setQuestions([])
    if (requirePhoto) {
      setPhase('camera')
    } else {
      setQuizLoadKey((key) => key + 1)
      setPhase('quiz')
    }
  }

  return (
    <div className="player-quiz">
      <div className="player-quiz__head">
        <span><ClipboardList size={19} /></span>
        <div>
          <h2>Cuestionario del video</h2>
          <p>Responde correctamente al menos el {passingScore}% de las preguntas para aprobar el cuestionario.</p>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      {phase === 'intro' && (
        <div className="player-quiz__intro">
          {requirePhoto && <p className="player-quiz__photo-notice"><Camera size={15} /> Al iniciar se te pedirá tomarte una foto para verificar quién responde.</p>}
          <button className="primary-button" type="button" onClick={startQuiz}>Iniciar cuestionario</button>
        </div>
      )}

      {phase === 'camera' && (
        <div className="player-quiz__camera">
          <p>Tómate una foto para comenzar el cuestionario.</p>
          {cameraError && (
            <div className="camera-reconnect-notice" role="alert">
              <CircleAlert size={18} />
              <div><strong>No pudimos conectar la cámara</strong><p>{cameraError}</p></div>
              <button className="secondary-button" type="button" onClick={reconnectCamera}><Camera size={15} /> Volver a conectar</button>
            </div>
          )}
          {cameraDevices.length > 1 && (
            <div className="form-group player-quiz__camera-select">
              <label>Cámara</label>
              <select value={selectedCameraId} onChange={(event) => setSelectedCameraId(event.target.value)}>
                {cameraDevices.map((device, index) => (
                  <option value={device.deviceId} key={device.deviceId || index}>
                    {device.label || `Cámara ${index + 1}`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <video ref={cameraVideoRef} autoPlay playsInline muted className="player-quiz__camera-preview" />
          <div className="player-quiz__actions">
            <button className="primary-button" type="button" onClick={capturePhoto} disabled={capturingPhoto || Boolean(cameraError)}>
              <Camera size={15} /> {capturingPhoto ? 'Guardando foto…' : 'Tomar foto'}
            </button>
          </div>
        </div>
      )}

      {phase === 'quiz' && (
        <>
          {loading && <p>Cargando cuestionario…</p>}

          {!loading && result && (
            <div className={`player-quiz__result player-quiz__result--${result.passed ? 'passed' : 'failed'}`}>
              {result.passed ? <CircleCheck size={20} /> : <CircleAlert size={20} />}
              <div>
                <strong>{result.passed ? '¡Aprobado!' : 'Aún no alcanzas el puntaje mínimo'}</strong>
                <p>Obtuviste {result.correctCount} de {result.totalQuestions} correctas ({result.scorePercent}%).</p>
              </div>
            </div>
          )}

          {!loading && !result && questions.map((question, index) => (
            <div className="player-quiz__question" key={question.id}>
              <strong>{index + 1}. {question.prompt}</strong>
              {question.options.map((option) => (
                <label className="player-quiz__option" key={option.id}>
                  <input
                    type="radio"
                    name={`quiz-${video.id}-${question.id}`}
                    checked={answers[question.id] === option.id}
                    onChange={() => selectAnswer(question.id, option.id)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          ))}

          {!loading && (
            <div className="player-quiz__actions">
              {result && !result.passed && <button className="secondary-button" type="button" onClick={retry}>Reintentar</button>}
              {!result && <button className="primary-button" type="button" disabled={!allAnswered || submitting} onClick={submit}>{submitting ? 'Enviando…' : 'Enviar respuestas'}</button>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function EmptyState({ icon: Icon, title, text }) {
  return <div className="empty-state"><span><Icon size={24} /></span><h3>{title}</h3><p>{text}</p></div>
}

export default App
