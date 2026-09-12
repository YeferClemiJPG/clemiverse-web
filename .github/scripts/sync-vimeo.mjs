import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function readLibrary(value) {
  if (!value || !/^\d+$/.test(value.userId) || !Array.isArray(value.videos) || value.videos.length > 20000) throw new Error('Biblioteca de Vimeo inválida.');
  const seen = new Set();
  for (const video of value.videos) {
    if (!/^\d{5,15}$/.test(video.id) || seen.has(video.id) || typeof video.doctor !== 'string' || !video.doctor.trim() || video.doctor.length > 500) throw new Error('Registro de Vimeo inválido.');
    if (video.title !== undefined && (typeof video.title !== 'string' || !video.title.trim() || video.title.length > 1000)) throw new Error('Título del registro inválido.');
    if (video.hash && !/^[a-zA-Z0-9]+$/.test(video.hash)) throw new Error('Hash de Vimeo inválido.');
    seen.add(video.id);
  }
  return value;
}

export function catalogVideo(metadata, entry, userId) {
  if (String(metadata.video_id) !== entry.id || metadata.type !== 'video' || metadata.provider_name !== 'Vimeo') throw new Error('Vimeo devolvió otro video.');
  const owner = new URL(metadata.author_url);
  if (owner.hostname !== 'vimeo.com' || owner.pathname !== `/user${userId}`) throw new Error('El video no pertenece a la cuenta de CLEMI.');
  if (typeof metadata.title !== 'string' || !metadata.title.trim() || metadata.title.length > 1000) throw new Error('Título de Vimeo inválido.');
  const thumbnail = new URL(metadata.thumbnail_url);
  if (thumbnail.protocol !== 'https:' || thumbnail.hostname !== 'i.vimeocdn.com' || thumbnail.username || thumbnail.password || thumbnail.port) throw new Error('Miniatura de Vimeo inválida.');
  return {
    id: entry.id,
    title: entry.title ?? metadata.title.replace(/\.(mp4|mov|m4v|webm|mkv|avi|wmv|mpg|mpeg|mts|ogg|flv|3gp)$/i, '').trim(),
    doctor: entry.doctor,
    thumbnail: thumbnail.href,
    playerUrl: `https://player.vimeo.com/video/${entry.id}${entry.hash ? `?h=${entry.hash}` : ''}`,
  };
}

export async function getMetadata(entry) {
  const endpoint = new URL('https://vimeo.com/api/oembed.json');
  endpoint.searchParams.set('url', `https://vimeo.com/${entry.id}${entry.hash ? `/${entry.hash}` : ''}`);
  endpoint.searchParams.set('width', '960');
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`Vimeo HTTP ${response.status} para el video ${entry.id}.`);
      return await response.json();
    } catch (error) { failure = error; }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
  }
  throw failure;
}

export async function synchronize(output, library, get = getMetadata, today = new Date().toISOString().slice(0, 10)) {
  readLibrary(library);
  const videos = [];
  // A failed lookup never replaces the published library with partial data.
  for (const entry of library.videos) videos.push(catalogVideo(await get(entry), entry, library.userId));
  // The registry preserves the academic program's sequence.
  const contents = JSON.stringify({ schemaVersion: 1, provider: 'vimeo', checkedOn: today, videos }, null, 2) + '\n';
  const previous = await readFile(output, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
  if (previous === contents) return { count: videos.length, changed: false };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, contents);
  await rename(`${output}.tmp`, output);
  return { count: videos.length, changed: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(process.argv[2] || 'public/data/vimeo-videos.json');
  const library = JSON.parse(await readFile(process.argv[3] || 'lib/vimeo-library.json', 'utf8'));
  const result = await synchronize(output, library);
  console.log(`${result.count} videos de Vimeo. ${result.changed ? 'Catálogo actualizado.' : 'Sin cambios.'}`);
}
