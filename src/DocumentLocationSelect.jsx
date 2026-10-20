import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Folder, FolderOpen, X } from 'lucide-react'
import { getDocumentLocations, getSectionLabel } from './sectionFolders.js'

export default function DocumentLocationSelect({ document: item, sections, disabled, supportsFolders = true, onMove }) {
  const [open, setOpen] = useState(false)
  const [targetId, setTargetId] = useState(item.sectionId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const titleId = useId()
  const trigger = useRef(null)
  const dialog = useRef(null)
  const current = sections.find((section) => section.id === item.sectionId)
  const locations = getDocumentLocations(item.sectionId, sections)
  const folders = locations.filter((section) => section.parentId)
  const close = () => { setOpen(false); trigger.current?.focus() }

  useEffect(() => {
    if (!open) return
    dialog.current?.querySelector('input:checked, button')?.focus()
    const keyboard = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving) close() }
      if (event.key !== 'Tab') return
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
      if (!controls.length) { event.preventDefault(); return }
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => document.removeEventListener('keydown', keyboard, true)
  }, [open, saving])

  const move = async () => {
    if (disabled || saving || !locations.some((location) => location.id === targetId)) return
    setSaving(true)
    setError('')
    try {
      const result = await onMove(targetId)
      if (result?.error) setError(result.error)
      else if (result === false) setError('No se pudo mover el documento. Vuelve a intentarlo.')
      else close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo mover el documento.')
    } finally { setSaving(false) }
  }

  return <>
    <button ref={trigger} type="button" className="document-audience-select document-location-trigger" disabled={disabled || saving} aria-label={`Mover ${item.title}`} aria-haspopup="dialog" onClick={() => { setTargetId(item.sectionId); setError(''); setOpen(true) }}>
      <Folder size={14} /><span>{getSectionLabel(current, sections) || 'Elegir carpeta'}</span><ChevronDown size={14} />
    </button>
    {open && createPortal(<div className="document-location-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) close() }}>
      <section ref={dialog} className="document-location-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header><div><h2 id={titleId}>Mover documento</h2><p>{item.title}</p></div><button type="button" className="icon-button" aria-label="Cerrar ubicación" disabled={saving} onClick={close}><X size={19} /></button></header>
        <p className="document-location-help">Selecciona una subcarpeta de {locations.find((section) => !section.parentId)?.name || 'esta sección'}.</p>
        <fieldset disabled={saving}>
          <legend>Ubicación de destino</legend>
          {locations.map((location) => <label className={`document-location-option${targetId === location.id ? ' is-selected' : ''}`} key={location.id}>
            <input type="radio" name={titleId} value={location.id} checked={targetId === location.id} onChange={() => setTargetId(location.id)} />
            {location.parentId ? <Folder size={22} /> : <FolderOpen size={22} />}
            <span><strong>{location.name}</strong><small>{location.parentId ? 'Subcarpeta' : 'Directamente en la sección'}{location.id === item.sectionId ? ' · Ubicación actual' : ''}</small></span>
          </label>)}
        </fieldset>
        {!folders.length && <p className="document-location-help">{supportsFolders ? 'Esta sección aún no tiene subcarpetas. Créala desde Secciones → Archivos → Nueva carpeta y vuelve a mover el documento.' : 'Primero activa la actualización de carpetas en Supabase para poder seleccionar una subcarpeta.'}</p>}
        <p className="document-location-help">Se conservarán el archivo y su visibilidad. También se aplicarán los permisos de la carpeta de destino.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <footer><button type="button" className="secondary-button" disabled={saving} onClick={close}>Cancelar</button><button type="button" className="primary-button" disabled={disabled || saving || targetId === item.sectionId || !locations.some((location) => location.id === targetId)} onClick={move}>{saving ? 'Moviendo…' : 'Mover aquí'}</button></footer>
      </section>
    </div>, document.body)}
  </>
}
