export function withConnectionDeadline(operation, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message)
      error.code = 'CONNECTION_TIMEOUT'
      reject(error)
    }, timeoutMs)
  })
  return Promise.race([Promise.resolve().then(operation), timeout])
    .finally(() => clearTimeout(timer))
}

// Abort stalled reads and Auth refreshes so the SDK can release its pending
// session operations. File uploads and content writes keep their own lifetimes.
export async function fetchWithConnectionDeadline(input, options = {}) {
  const url = String(input instanceof Request ? input.url : input)
  const method = (options.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (!url.includes('/auth/v1/') && !['GET', 'HEAD'].includes(method)) return fetch(input, options)

  const controller = new AbortController()
  const signal = options.signal || (input instanceof Request ? input.signal : undefined)
  const abort = () => controller.abort(signal.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException('La conexión con Supabase tardó demasiado.', 'TimeoutError')), 15_000)
  try {
    return await fetch(input, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
