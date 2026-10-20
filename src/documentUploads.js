export function createDocumentUploads(files) {
  return Array.from(files, (file) => ({ file, title: file.name.replace(/\.(pdf|docx?)$/i, '').slice(0, 180) }))
}

// Keep confirmed uploads as they finish. A retry only includes failed files.
export async function uploadDocumentBatch({ entries, upload, onUploaded, onProgress }) {
  const failed = []
  let nextIndex = 0
  let completed = 0
  onProgress?.(0, entries.length)
  const worker = async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex++
      const entry = entries[index]
      try {
        const document = await upload(entry)
        onUploaded(document)
      } catch (error) {
        failed.push({ index, entry: { ...entry, error: error instanceof Error ? error.message : 'No se pudo subir el archivo.' } })
      } finally {
        completed += 1
        onProgress?.(completed, entries.length)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, entries.length) }, worker))
  return { failed: failed.sort((a, b) => a.index - b.index).map(({ entry }) => entry), uploadedCount: entries.length - failed.length }
}
