import { useState } from 'react'
import { Folder, Pencil, Plus, Trash2, X } from 'lucide-react'
import { ROLE_META, VIEWER_ROLES } from './data.js'
import { normalizeSearch } from './roleAccess.js'
import { getSectionLabel, getSectionTree } from './sectionFolders.js'

export function SectionVideoLocation({ video, section, data, setData }) {
  return <div className="section-content-video"><Folder size={17} /><div><strong>{video.title}</strong><small>{Object.entries(video.assignments || {}).filter(([, id]) => id === section.id).map(([role]) => ROLE_META[role]?.label || role).join(' · ')}</small></div>
    <label>Ubicación<select aria-label={`Mover video ${video.title}`} value={section.id} onChange={(event) => {
      const targetId = event.target.value
      setData((current) => ({ ...current, videos: current.videos.map((item) => item.id === video.id ? { ...item, assignments: Object.fromEntries(Object.entries(item.assignments || {}).map(([role, id]) => [role, id === section.id ? targetId : id])) } : item) }))
    }}>{getSectionTree(data.sections).map((location) => <option key={location.id} value={location.id}>{getSectionLabel(location, data.sections)}</option>)}</select></label>
  </div>
}

export default function SectionFoldersManager({ section, data, setData, onOpen, onRemove }) {
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState('')
  const folders = data.sections.filter((item) => item.parentId === section.id).sort((a, b) => a.order - b.order)
  const begin = (folder = null) => {
    setError('')
    setDraft(folder ? { ...folder, roles: [...folder.roles] } : { id: null, name: '', roles: VIEWER_ROLES.filter((role) => section.roles.includes(role)) })
  }
  const save = (event) => {
    event.preventDefault()
    if (!draft.name.trim()) return
    if (folders.some((folder) => folder.id !== draft.id && normalizeSearch(folder.name) === normalizeSearch(draft.name))) {
      setError('Ya existe una carpeta con ese nombre en esta sección.')
      return
    }
    const folder = { ...draft, id: draft.id || crypto.randomUUID(), parentId: section.id, name: draft.name.trim(), icon: 'folder', order: draft.order ?? data.sections.length, contentType: 'videos' }
    setData((current) => ({ ...current, sections: draft.id ? current.sections.map((item) => item.id === folder.id ? folder : item) : [...current.sections, folder] }))
    setDraft(null)
  }
  return <section className="section-folders-manager">
    <div className="section-folders-heading"><div><h3>Carpetas de la sección</h3><p>Organiza videos y documentos. Para entrar, el rol debe tener acceso a la sección y a la carpeta.</p></div><button type="button" className="secondary-button" disabled={data.supportsFolders === false} onClick={() => begin()}><Plus size={16} /> Nueva carpeta</button></div>
    {data.supportsFolders === false && <p className="form-error">Falta activar la actualización de carpetas en Supabase.</p>}
    {draft && <form className="section-folder-form" onSubmit={save}>
      <div className="form-group"><label htmlFor="folder-name">Nombre de la carpeta</label><input id="folder-name" value={draft.name} maxLength={100} onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoFocus placeholder="Ej. Manuales o capacitaciones" /></div>
      <div><span>Visible para</span><div className="role-checks">{VIEWER_ROLES.map((role) => <button type="button" aria-pressed={draft.roles.includes(role)} className={draft.roles.includes(role) ? 'selected' : ''} disabled={!section.roles.includes(role)} title={!section.roles.includes(role) ? 'Habilita este rol en la sección principal para darle acceso.' : undefined} key={role} onClick={() => setDraft({ ...draft, roles: draft.roles.includes(role) ? draft.roles.filter((item) => item !== role) : [...draft.roles, role] })}>{ROLE_META[role].label}</button>)}</div></div>
      {!draft.roles.length && <small>Sin roles seleccionados, solo estará disponible desde gestión.</small>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="section-folder-form__actions"><button className="primary-button" type="submit" disabled={!draft.name.trim()}>Guardar carpeta</button><button type="button" className="secondary-button" onClick={() => setDraft(null)}><X size={15} /> Cancelar</button></div>
    </form>}
    <div className="section-folder-grid">{folders.map((folder) => <article className="section-folder-card" key={folder.id}>
      <button type="button" className="section-folder-open" onClick={() => onOpen(folder.id)}><Folder size={23} /><span><strong>{folder.name}</strong><small>{folder.roles.filter((role) => section.roles.includes(role) && VIEWER_ROLES.includes(role)).map((role) => ROLE_META[role].label).join(', ') || 'Solo gestión'}</small></span></button>
      <div><button type="button" className="icon-button" onClick={() => begin(folder)} aria-label={`Editar carpeta ${folder.name}`}><Pencil size={15} /></button><button type="button" className="icon-button danger" onClick={() => onRemove(folder.id)} aria-label={`Eliminar carpeta ${folder.name}`}><Trash2 size={15} /></button></div>
    </article>)}</div>
    {!folders.length && !draft && <p className="section-folder-empty">Aún no hay carpetas. Puedes mantener contenido directamente en la sección o crear una carpeta.</p>}
  </section>
}
