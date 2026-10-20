export function getSectionLabel(section, sections) {
  const parent = section?.parentId && sections.find((item) => item.id === section.parentId)
  return parent ? `${parent.name} / ${section.name}` : section?.name || ''
}

export function getSectionTree(sections) {
  const sorted = [...sections].sort((a, b) => a.order - b.order)
  return sorted.filter((section) => !section.parentId).flatMap((parent) => [parent, ...sorted.filter((section) => section.parentId === parent.id)])
}

export function getDocumentLocations(sectionId, sections) {
  const current = sections.find((section) => section.id === sectionId)
  if (!current) return []
  const rootId = current.parentId || current.id
  const root = sections.find((section) => section.id === rootId)
  if (!root || root.parentId || root.active === false) return []
  return getSectionTree(sections).filter((section) => section.active !== false && (section.id === rootId || section.parentId === rootId))
}

export function validateSectionFolders(sections) {
  for (const section of sections) {
    if (!section.parentId) continue
    const parent = sections.find((item) => item.id === section.parentId)
    if (!parent || parent.id === section.id || parent.parentId) return 'Cada carpeta debe pertenecer a una sección principal existente.'
  }
  return ''
}

export function removeFolderFromSnapshot(snapshot, folderId) {
  const folder = snapshot.sections.find((item) => item.id === folderId && item.parentId)
  if (!folder) return snapshot
  return {
    ...snapshot,
    sections: snapshot.sections.filter((item) => item.id !== folderId),
    documents: (snapshot.documents || []).map((document) => document.sectionId === folderId ? { ...document, sectionId: folder.parentId } : document),
    videos: snapshot.videos.map((video) => ({ ...video, assignments: Object.fromEntries(Object.entries(video.assignments || {}).map(([role, sectionId]) => [role, sectionId === folderId ? folder.parentId : sectionId])) })),
  }
}
