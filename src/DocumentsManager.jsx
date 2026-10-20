import { useEffect, useRef, useState } from 'react'
import { getDocumentAudienceLabel } from './documentAudience.js'
import DocumentAudienceSelect from './DocumentAudienceSelect'
import { createDocumentUploads, uploadDocumentBatch } from './documentUploads.js'
import { VIEWER_ROLES } from './data.js'
import { AdminAccessNotice, RoleOptions } from './RoleOptions'
import { canViewDocument, normalizeSearch } from './roleAccess.js'
import { Check, FileText, Pencil, Search, ShieldCheck, Trash2, UploadCloud, X } from 'lucide-react'
import {
  deleteSectionDocument,
  updateSectionDocumentAudience,
  updateSectionDocumentTitle,
  uploadSectionDocument,
} from './lib/videoHubApi'

const errorMessage = (error, fallback) => error instanceof Error && error.message ? error.message : fallback

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function EmptyDocuments({ title, text }) {
  return <div className="empty-state"><span><FileText size={24} /></span><h3>{title}</h3><p>{text}</p></div>
}

export default function DocumentsManager({ data, setData, onNotify, sectionId = null, uploadsEnabled = true }) {
  const documentSections = [...data.sections]
    .sort((a, b) => a.order - b.order)
  const [draft, setDraft] = useState({ sectionId: sectionId || documentSections[0]?.id || '', audience: 'both', files: [] })
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [fileInputKey, setFileInputKey] = useState(0)
  const fileInputRef = useRef(null)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')

  useEffect(() => {
    if (documentSections.length && (sectionId || !documentSections.some((section) => section.id === draft.sectionId))) {
      const nextSectionId = sectionId || documentSections[0].id
      if (draft.sectionId !== nextSectionId) setDraft((current) => ({ ...current, sectionId: nextSectionId }))
    }
  }, [data.sections, draft.sectionId, sectionId])

  const addFiles = (files) => {
    if (uploading) return
    const entries = createDocumentUploads(files)
    setDraft((current) => ({ ...current, files: [...current.files, ...entries] }))
    setFileInputKey((value) => value + 1)
  }

  const submitDocument = async (event) => {
    event.preventDefault()
    if (!uploadsEnabled || !(sectionId || draft.sectionId) || !draft.files.length || draft.files.some((entry) => !entry.title.trim()) || uploading) return
    setUploading(true)
    try {
      const { failed, uploadedCount } = await uploadDocumentBatch({
        entries: draft.files,
        upload: ({ file, title }) => uploadSectionDocument({
          organizationId: data.organizationId,
          sectionId: sectionId || draft.sectionId,
          title,
          audience: draft.audience,
          file,
        }),
        onUploaded: (document) => setData((current) => ({ ...current, documents: [document, ...(current.documents || [])] })),
        onProgress: (current, total) => setUploadProgress(`${current} de ${total}`),
      })
      setDraft((current) => ({ ...current, files: failed }))
      setFileInputKey((value) => value + 1)
      if (failed.length) {
        onNotify?.(`${uploadedCount} guardado(s); ${failed.length} pendiente(s). Revisa los archivos indicados y vuelve a intentar.`, { tone: 'danger' })
      } else {
        onNotify?.(`${uploadedCount} documento${uploadedCount === 1 ? '' : 's'} guardado${uploadedCount === 1 ? '' : 's'} correctamente.`)
      }
    } catch (error) {
      onNotify?.(errorMessage(error, 'No se pudo guardar el documento.'), { tone: 'danger' })
    } finally {
      setUploading(false)
      setUploadProgress('')
    }
  }

  const saveTitle = async (document) => {
    if (!editingTitle.trim() || busyId) return
    if (!window.confirm('¿Guardar el nuevo título de “' + document.title + '”?')) return
    setBusyId(document.id)
    try {
      const updated = await updateSectionDocumentTitle(document.id, editingTitle)
      setData((current) => ({
        ...current,
        documents: (current.documents || []).map((item) => item.id === document.id ? updated : item),
      }))
      setEditingId(null)
      onNotify?.('Documento “' + updated.title + '” actualizado correctamente.')
    } catch (error) {
      onNotify?.(errorMessage(error, 'No se pudo editar el documento.'), { tone: 'danger' })
    } finally {
      setBusyId(null)
    }
  }

  const removeDocument = async (document) => {
    if (busyId || !window.confirm('¿Eliminar “' + document.title + '” y su archivo de Supabase?')) return
    setBusyId(document.id)
    try {
      await deleteSectionDocument(document)
      setData((current) => ({
        ...current,
        documents: (current.documents || []).filter((item) => item.id !== document.id),
      }))
      onNotify?.('Documento “' + document.title + '” eliminado correctamente.', { tone: 'danger' })
    } catch (error) {
      onNotify?.(errorMessage(error, 'No se pudo eliminar el documento.'), { tone: 'danger' })
    } finally {
      setBusyId(null)
    }
  }

  const changeAudience = async (document, audience) => {
    if (busyId) return false
    if (audience === document.audience) return true
    setBusyId(document.id)
    try {
      const updated = await updateSectionDocumentAudience(document.id, audience)
      setData((current) => ({
        ...current,
        documents: (current.documents || []).map((item) => item.id === document.id ? updated : item),
      }))
      onNotify?.('Visibilidad de “' + updated.title + '” actualizada a ' + getDocumentAudienceLabel(updated.audience) + '.')
      return true
    } catch (error) {
      onNotify?.(errorMessage(error, 'No se pudo cambiar la visibilidad del documento.'), { tone: 'danger' })
      return false
    } finally {
      setBusyId(null)
    }
  }

  const documents = [...(data.documents || [])]
    .filter((document) => !sectionId || document.sectionId === sectionId)
    .filter((document) => normalizeSearch(document.title + ' ' + document.fileName).includes(normalizeSearch(query)))
    .filter((document) => roleFilter === 'all' || canViewDocument(document, roleFilter, data.sections))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

  return (
    <div className="manager-stack">
      <section className="panel document-upload-panel">
        <div className="manager-toolbar"><div><h2>Subir documentos</h2><p>Selecciona varios archivos PDF, DOC o DOCX. Máximo 25 MB por archivo.</p></div><span className="document-security-badge"><ShieldCheck size={15} /> Almacenamiento privado</span></div>
        {documentSections.length ? (
          <form className="document-upload-form" onSubmit={submitDocument}>
            {!sectionId && <div className="form-group"><label>Sección</label><select value={draft.sectionId} disabled={uploading} onChange={(event) => setDraft({ ...draft, sectionId: event.target.value })}>{documentSections.map((section) => <option value={section.id} key={section.id}>{section.name}</option>)}</select></div>}
            <div className="form-group"><label htmlFor="document-audience">Visible para</label><DocumentAudienceSelect id="document-audience" value={draft.audience} onChange={(audience) => setDraft((current) => ({ ...current, audience }))} disabled={uploading} /><small>Los roles seleccionados también necesitan tener visible la sección. El rol Administradores solo permite consultar contenido.</small></div>
            <div className={`document-file-dropzone${draggingFiles ? ' is-dragging' : ''}`} onDragOver={(event) => {
              event.preventDefault()
              if (!uploading) setDraggingFiles(true)
            }} onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setDraggingFiles(false)
            }} onDrop={(event) => {
              event.preventDefault()
              setDraggingFiles(false)
              addFiles(event.dataTransfer.files)
            }}>
              <UploadCloud size={28} aria-hidden="true" />
              <strong>Arrastra varios documentos aquí</strong>
              <span>PDF, DOC o DOCX · Hasta 25 MB por archivo</span>
              <button type="button" className="secondary-button" disabled={uploading} onClick={() => fileInputRef.current?.click()}>Seleccionar varios archivos</button>
              <small>En la ventana de archivos, usa Ctrl + clic o Shift para seleccionar varios. Puedes añadir más antes de guardar.</small>
              <input ref={fileInputRef} id="document-files" key={fileInputKey} type="file" multiple hidden disabled={uploading} accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => addFiles(event.target.files || [])} />
              <span aria-live="polite">{draft.files.length ? `${draft.files.length} archivo${draft.files.length === 1 ? '' : 's'} seleccionado${draft.files.length === 1 ? '' : 's'}` : 'Puedes seleccionar todos tus documentos de una vez'}</span>
            </div>
            <button className="primary-button" type="submit" disabled={!uploadsEnabled || uploading || !(sectionId || draft.sectionId) || !draft.files.length || draft.files.some((entry) => !entry.title.trim())}>{uploading ? null : <UploadCloud size={17} />}{uploading ? `Subiendo ${uploadProgress}…` : uploadsEnabled ? `Guardar documentos${draft.files.length ? ` (${draft.files.length})` : ''}` : 'Esperando guardado…'}</button>
            {uploading && <div className="document-upload-progress" role="status"><span>Procesados: {uploadProgress}. Subiendo hasta 3 documentos a la vez.</span></div>}
            {draft.files.length > 0 && <div className="document-upload-queue" aria-live="polite">
              {draft.files.map((entry, index) => <div className="document-upload-queue__item" key={index}>
                <div><span>{entry.file.name} · {formatFileSize(entry.file.size)}</span><label htmlFor={`document-title-${index}`}>Título visible</label><input id={`document-title-${index}`} value={entry.title} maxLength={180} disabled={uploading} onChange={(event) => setDraft((current) => ({ ...current, files: current.files.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item) }))} />{entry.error && <small className="form-error">{entry.error}</small>}</div>
                <button type="button" className="secondary-button" disabled={uploading} aria-label={`Quitar ${entry.file.name}`} onClick={() => setDraft((current) => ({ ...current, files: current.files.filter((_, itemIndex) => itemIndex !== index) }))}><X size={16} /></button>
              </div>)}
            </div>}
          </form>
        ) : <EmptyDocuments title="Crea una sección" text="Crea una sección para poder publicar documentos." />}
      </section>

      <AdminAccessNotice />

      <section className="panel document-library-panel">
        <div className="panel-heading"><div><h2>Documentos publicados</h2><p>Cambia el título o los roles, o elimina archivos. La sección también debe estar visible para los roles seleccionados.</p></div><span className="count-chip">{documents.length} archivo{documents.length === 1 ? '' : 's'}</span></div>
        <div className="progress-filters"><label className="search-field progress-filters__search"><Search size={16} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar documento…" aria-label="Buscar documento" /></label><label className="progress-filters__select"><span>Acceso por rol</span><select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="all">Todos los roles</option><RoleOptions roles={VIEWER_ROLES} /></select></label></div>
        <div className="document-admin-grid">
          {documents.map((document) => {
            const section = data.sections.find((item) => item.id === document.sectionId)
            const typeLabel = document.mimeType.includes('word') ? 'WORD' : 'PDF'
            return (
              <article className="document-admin-card" key={document.id}>
                <div className="document-admin-card__icon"><FileText size={25} /><span>{typeLabel}</span></div>
                <div className="document-admin-card__body">
                  <small>{section?.name || 'Sección'} · {formatFileSize(document.fileSize)}</small>
                  {editingId === document.id ? <div className="document-title-edit"><input value={editingTitle} maxLength="180" onChange={(event) => setEditingTitle(event.target.value)} autoFocus /><button type="button" onClick={() => saveTitle(document)} disabled={busyId === document.id}><Check size={15} /></button><button type="button" onClick={() => setEditingId(null)}><X size={15} /></button></div> : <h3>{document.title}</h3>}
                  <p>{document.fileName}</p>
                  <div className="document-audience-control"><span>Visible para</span><DocumentAudienceSelect value={document.audience || 'both'} onChange={(audience) => changeAudience(document, audience)} disabled={Boolean(busyId)} label={'Visibilidad de ' + document.title} /></div>
                </div>
                <div className="document-admin-card__actions"><button type="button" onClick={() => { setEditingId(document.id); setEditingTitle(document.title) }} disabled={Boolean(busyId)}><Pencil size={15} /> Editar título</button><button type="button" className="danger" onClick={() => removeDocument(document)} disabled={Boolean(busyId)}><Trash2 size={15} /> Eliminar</button></div>
              </article>
            )
          })}
          {!documents.length && <EmptyDocuments title={query || roleFilter !== 'all' ? 'No encontramos documentos' : 'Aún no hay documentos'} text={query || roleFilter !== 'all' ? 'Prueba otra búsqueda o cambia el filtro de rol.' : 'Los documentos que subas aparecerán aquí organizados por sección.'} />}
        </div>
      </section>
    </div>
  )
}
