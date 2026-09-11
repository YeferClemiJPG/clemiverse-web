import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_FOLDER_ID = '19tpxq9VORkwDb6rpfdsDOJA96hOfM-c3';
const validId = /^[\w-]{10,100}$/;

function decodeText(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (entity[0] !== '#') return entities[entity.toLowerCase()] || match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

// Read only the public folder view. No Google credentials or private Drive access.
// Fail closed if Google's markup changes; callers retain the last good catalog.
export function parseFolder(html) {
  if (!html.includes('id="flip-contents"') || !html.includes('class="flip-entries"') || !html.includes('</html>')) throw new Error('Drive no devolvió una carpeta pública completa.');
  const rowCount = (html.match(/class="flip-entry"/g) || []).length;
  if (rowCount >= 500) throw new Error('Carpeta demasiado grande para la vista pública; usar Drive API con paginación.');
  const entries = [];
  const rows = html.matchAll(/<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?(?=<div class="flip-entry" id="entry-|$)/g);
  for (const row of rows) {
    const id = row[1];
    const title = /class="flip-entry-title">([^<]*)<\/div>/.exec(row[0]);
    const link = /<a href="([^"]+)"/.exec(row[0]);
    if (!validId.test(id) || !title || !link) throw new Error('Cambió el formato del listado de Drive.');
    const url = new URL(decodeText(link[1]));
    if (url.origin !== 'https://drive.google.com') throw new Error('Enlace inesperado en la carpeta de Drive.');
    const folder = url.pathname === `/drive/folders/${id}`;
    const file = url.pathname === `/file/d/${id}/view`;
    if (!folder && !file) throw new Error('Tipo de enlace de Drive no reconocido.');
    const mime = /\/type\/(video(?:\/|%2F)[^"?\s]+)/i.exec(row[0]);
    entries.push({ id, name: decodeText(title[1]).trim(), folder, video: Boolean(mime) });
  }
  if (entries.length !== rowCount) throw new Error('El listado de Drive está incompleto.');
  return entries;
}

export function doctorName(value) {
  const name = value.replace(/^Dr(a)?\.?\s*/i, (_, a) => a ? 'Dra. ' : 'Dr. ').trim();
  const prefix = /^(Dra?\.)\s+/.exec(name);
  const rest = prefix ? name.slice(prefix[0].length) : name;
  const formatted = rest === rest.toLocaleUpperCase('es')
    ? rest.toLocaleLowerCase('es').replace(/(^|\s)(\p{L})/gu, (_, space, char) => space + char.toLocaleUpperCase('es'))
    : rest;
  return prefix ? `${prefix[1]} ${formatted}` : formatted;
}

async function getFolder(id) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`https://drive.google.com/embeddedfolderview?id=${id}`, { signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`Drive respondió HTTP ${response.status}.`);
      const html = await response.text();
      if (html.length > 3000000) throw new Error('Respuesta de Drive demasiado grande.');
      return parseFolder(html);
    } catch (error) { lastError = error; }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw lastError;
}

export async function collectVideos(listFolder = getFolder) {
  const queue = [{ id: ROOT_FOLDER_ID, doctor: '', depth: 0 }];
  const visited = new Set();
  const videos = new Map();
  while (queue.length) {
    const folder = queue.shift();
    if (visited.has(folder.id)) continue;
    if (visited.size >= 200 || folder.depth > 10) throw new Error('Biblioteca demasiado grande para esta sincronización.');
    visited.add(folder.id);
    for (const entry of await listFolder(folder.id)) {
      if (entry.folder) queue.push({ id: entry.id, doctor: folder.doctor || doctorName(entry.name), depth: folder.depth + 1 });
      else if (entry.video) videos.set(entry.id, {
        id: entry.id,
        title: entry.name.replace(/\.(mp4|mov|m4v|webm|mkv|avi|wmv|mpg|mpeg|mts|ogg|flv|3gp)$/i, ''),
        doctor: folder.doctor || 'CLEMI',
      });
    }
  }
  return [...videos.values()].sort((a, b) => a.doctor.localeCompare(b.doctor, 'es') || a.title.localeCompare(b.title, 'es') || a.id.localeCompare(b.id));
}

export async function synchronize(output, listFolder = getFolder, today = new Date().toISOString().slice(0, 10)) {
  // Read the complete tree before replacing anything, including on partial failures.
  const videos = await collectVideos(listFolder);
  const catalog = { schemaVersion: 1, folderId: ROOT_FOLDER_ID, checkedOn: today, videos };
  const contents = JSON.stringify(catalog, null, 2) + '\n';
  const previous = await readFile(output, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return ''; });
  if (previous === contents) return { changed: false, count: videos.length };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, contents);
  return { changed: true, count: videos.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(process.argv[2] || 'public/data/drive-videos.json');
  const result = await synchronize(output);
  console.log(`${result.count} videos de Drive. ${result.changed ? 'Catálogo actualizado.' : 'Sin cambios.'}`);
}
