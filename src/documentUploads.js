export function createDocumentUploads(files) {
  return Array.from(files, (file) => ({ file, title: file.name.replace(/\.(pdf|docx?)$/i, '').slice(0, 180) }))
}

// Keep confirmed uploads as they finish. A retry only includes failed files.
export async function uploadDocumentBatch({ entries, upload, onUploaded, onProgress }) {
  const failed = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    onProgress?.(index + 1, entries.length)
    try {
      const document = await upload(entry)
      onUploaded(document)
    } catch (error) {
      failed.push({ ...entry, error: error instanceof Error ? error.message : 'No se pudo subir el archivo.' })
    }
  }
  return { failed, uploadedCount: entries.length - failed.length }
}
