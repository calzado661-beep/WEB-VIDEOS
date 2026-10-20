import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { ROLE_META, VIEWER_ROLES } from './data.js'
import { getDocumentAudienceLabel, getDocumentAudienceRoles, toggleDocumentAudienceRole } from './documentAudience.js'

export default function DocumentAudienceSelect({ id, value = 'both', onChange, disabled = false, label = 'Visible para' }) {
  const popupId = useId()
  const trigger = useRef(null)
  const popup = useRef(null)
  const [position, setPosition] = useState(null)
  const [selection, setSelection] = useState(value)
  const [saving, setSaving] = useState(false)

  const close = () => {
    setPosition(null)
    trigger.current?.focus()
  }

  useEffect(() => {
    if (!position) return
    popup.current?.querySelector('input')?.focus()
    const dismiss = (event) => {
      if (!saving && !popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) setPosition(null)
    }
    const escape = (event) => {
      if (event.key === 'Escape' && !saving) { event.preventDefault(); close() }
    }
    const reposition = (event) => {
      if (!saving && !popup.current?.contains(event.target)) setPosition(null)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [Boolean(position), saving])

  const open = () => {
    if (position) return close()
    const rect = trigger.current.getBoundingClientRect()
    const width = Math.min(300, window.innerWidth - 24)
    setSelection(value)
    setPosition({
      width,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      ...(window.innerHeight - rect.bottom >= 330 ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
      maxHeight: Math.max(180, Math.max(window.innerHeight - rect.bottom, rect.top) - 18),
    })
  }

  const apply = async () => {
    if (selection === value) return close()
    setSaving(true)
    try {
      if (await onChange(selection) !== false) close()
    } finally {
      setSaving(false)
    }
  }

  const roles = getDocumentAudienceRoles(selection)
  return <>
    <button ref={trigger} id={id} type="button" className="document-audience-select" onClick={open} disabled={disabled || saving} aria-label={label} aria-haspopup="dialog" aria-expanded={Boolean(position)} aria-controls={position ? popupId : undefined}>
      <span>{getDocumentAudienceLabel(value)}</span><ChevronDown size={14} />
    </button>
    {position && createPortal(<div ref={popup} id={popupId} className="document-audience-popup" role="dialog" aria-label={label} style={position} onBlur={(event) => {
      if (!saving && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) setPosition(null)
    }}>
      <strong>Selecciona los roles</strong>
      <label><input type="checkbox" checked={selection === 'both'} disabled={saving} onChange={(event) => setSelection(event.target.checked ? 'both' : 'admin')} />Todos los roles de la sección</label>
      {VIEWER_ROLES.map((role) => <label key={role}><input type="checkbox" checked={roles.includes(role)} disabled={saving} onChange={() => setSelection((current) => toggleDocumentAudienceRole(current, role))} />{ROLE_META[role].label}</label>)}
      <label className="document-audience-popup__admin"><input type="checkbox" checked disabled />Administradores <small>Acceso automático</small></label>
      <div className="document-audience-popup__actions"><button type="button" disabled={saving} onClick={close}>Cancelar</button><button type="button" className="primary-button" disabled={saving} onClick={apply}>{saving ? 'Guardando…' : 'Aplicar'}</button></div>
    </div>, document.body)}
  </>
}
