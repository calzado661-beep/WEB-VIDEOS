import { useEffect, useState } from 'react'
import { Check, FileText, Pencil, ShieldCheck, Trash2, UploadCloud, X } from 'lucide-react'
import {
  deleteSectionDocument,
  updateSectionDocumentAudience,
  updateSectionDocumentTitle,
  uploadSectionDocument,
} from './lib/videoHubApi'

const errorMessage = (error, fallback) => error instanceof Error && error.message ? error.message : fallback
const AUDIENCE_LABELS = { operator: 'Operante', boss: 'Jefe', both: 'Ambos' }

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
  const [draft, setDraft] = useState({ title: '', sectionId: sectionId || documentSections[0]?.id || '', audience: 'both', file: null })
  const [uploading, setUploading] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [fileInputKey, setFileInputKey] = useState(0)

  useEffect(() => {
    if (documentSections.length && (sectionId || !documentSections.some((section) => section.id === draft.sectionId))) {
      const nextSectionId = sectionId || documentSections[0].id
      if (draft.sectionId !== nextSectionId) setDraft((current) => ({ ...current, sectionId: nextSectionId }))
    }
  }, [data.sections, draft.sectionId, sectionId])

  const submitDocument = async (event) => {
    event.preventDefault()
    if (!uploadsEnabled || !draft.title.trim() || !(sectionId || draft.sectionId) || !draft.file || uploading) return
    setUploading(true)
    try {
      const document = await uploadSectionDocument({
        organizationId: data.organizationId,
        sectionId: sectionId || draft.sectionId,
        title: draft.title,
        audience: draft.audience,
        file: draft.file,
      })
      setData((current) => ({ ...current, documents: [document, ...(current.documents || [])] }))
      setDraft((current) => ({ ...current, title: '', file: null }))
      setFileInputKey((value) => value + 1)
      onNotify?.('Documento “' + document.title + '” guardado correctamente.')
    } catch (error) {
      onNotify?.(errorMessage(error, 'No se pudo guardar el documento.'), { tone: 'danger' })
    } finally {
      setUploading(false)
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
    if (busyId || audience === document.audience) return
    setBusyId(document.id)
    try {
      const updated = await updateSectionDocumentAudience(document.id, audience)
      setData((current) => ({
        ...current,
        documents: (current.documents || []).map((item) => item.id === document.id ? updated : item),
      }))
      onNotify?.('Visibilidad de “' + updated.title + '” actualizada a ' + AUDIENCE_LABELS[updated.audience] + '.')
    } catch (error) {
      onNotify?.(errorMessage(error, 'No se pudo cambiar la visibilidad del documento.'), { tone: 'danger' })
    } finally {
      setBusyId(null)
    }
  }

  const documents = [...(data.documents || [])]
    .filter((document) => !sectionId || document.sectionId === sectionId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

  return (
    <div className="manager-stack">
      <section className="panel document-upload-panel">
        <div className="manager-toolbar"><div><h2>Subir un documento</h2><p>Archivos PDF, DOC o DOCX de hasta 25 MB.</p></div><span className="document-security-badge"><ShieldCheck size={15} /> Almacenamiento privado</span></div>
        {documentSections.length ? (
          <form className="document-upload-form" onSubmit={submitDocument}>
            <div className="form-group"><label>Título visible</label><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength="180" placeholder="Ej. Manual de seguridad" /></div>
            {!sectionId && <div className="form-group"><label>Sección</label><select value={draft.sectionId} onChange={(event) => setDraft({ ...draft, sectionId: event.target.value })}>{documentSections.map((section) => <option value={section.id} key={section.id}>{section.name}</option>)}</select></div>}
            <div className="form-group"><label htmlFor="document-audience">Visible para</label><select id="document-audience" value={draft.audience} onChange={(event) => setDraft({ ...draft, audience: event.target.value })}><option value="both">Ambos</option><option value="operator">Operante</option><option value="boss">Jefe</option></select></div>
            <div className="form-group document-file-field"><label>Archivo</label><input key={fileInputKey} type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => setDraft({ ...draft, file: event.target.files?.[0] || null })} /></div>
            <button className="primary-button" type="submit" disabled={!uploadsEnabled || uploading || !draft.title.trim() || !(sectionId || draft.sectionId) || !draft.file}>{uploading ? null : <UploadCloud size={17} />}{uploading ? 'Subiendo…' : uploadsEnabled ? 'Guardar documento' : 'Esperando guardado…'}</button>
          </form>
        ) : <EmptyDocuments title="Crea una sección" text="Crea una sección para poder publicar documentos." />}
      </section>

      <section className="panel document-library-panel">
        <div className="panel-heading"><div><h2>Documentos publicados</h2><p>Cambia el título o el rol, o elimina archivos. La sección también debe estar visible para ese rol.</p></div><span className="count-chip">{documents.length} archivo{documents.length === 1 ? '' : 's'}</span></div>
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
                  <label className="document-audience-control">Visible para <select value={document.audience || 'both'} onChange={(event) => changeAudience(document, event.target.value)} disabled={Boolean(busyId)} aria-label={'Visibilidad de ' + document.title}><option value="both">Ambos</option><option value="operator">Operante</option><option value="boss">Jefe</option></select></label>
                </div>
                <div className="document-admin-card__actions"><button type="button" onClick={() => { setEditingId(document.id); setEditingTitle(document.title) }} disabled={Boolean(busyId)}><Pencil size={15} /> Editar título</button><button type="button" className="danger" onClick={() => removeDocument(document)} disabled={Boolean(busyId)}><Trash2 size={15} /> Eliminar</button></div>
              </article>
            )
          })}
          {!documents.length && <EmptyDocuments title="Aún no hay documentos" text="Los documentos que subas aparecerán aquí organizados por sección." />}
        </div>
      </section>
    </div>
  )
}
