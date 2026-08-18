/**
 * Pet registry for the dsh-pet-remielle host.
 *
 * Pure functions over the "pet directory" discovery result: a pet is a
 * directory under assets/pets/<id>/ holding the six mood stickers
 * (01.gif .. 06.gif). The host scans those directories with fs and feeds the
 * discovery into `buildRegistry`, which merges it with the persisted pets
 * config and projects the registry view served to the settings page.
 *
 * Adding a pet never touches code: drop six GIFs into assets/pets/<id>/,
 * then flip it on in Settings → 宠物管理.
 */

export const PET_MOODS = ['01', '02', '03', '04', '05', '06']
export const PET_MOOD_EXT = '.gif'
/** Optional extra sticker slots beyond the six required moods (e.g. '07'). */
export const PET_MOOD_EXTRA = ['07']
/** Manifest filename inside a pet directory (per-sticker offsets, pics count). */
export const PET_MANIFEST = 'pet-manifest.json'
/** Safe directory-name characters for a pet id (path component on disk). */
export const PET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
export const DEFAULT_PET_ID = 'remielle'
export const DEFAULT_PET_NAME = '蕾米埃尔'
export const DEFAULT_PETS = Object.freeze([
  { id: DEFAULT_PET_ID, name: DEFAULT_PET_NAME, enabled: true },
])

/** A pet id is a safe path component and therefore URL-safe. */
export function isValidPetId(value) {
  return typeof value === 'string' && PET_ID_RE.test(value)
}

/** A mood key is one of the six sticker slots. */
export function isValidMood(value) {
  return PET_MOODS.includes(value)
}

/**
 * Parse a static asset request path into `{ petId, kind, mood?, index? }`.
 *
 * Accepted shapes under the assets prefix:
 *   `<petId>/<mood>.gif`   — a mood sticker (kind 'gif', mood '01'..'99')
 *   `<petId>/pics/<n>.png` — a pic artwork (kind 'pic', index 1-based)
 * The pet id is the only variable path component and `isValidPetId` bounds
 * it, which is the path-traversal gate for both endpoints.
 * @param pathname - the URL pathname (already percent-decoded by the server).
 * @param prefix - the registered route prefix (no trailing slash).
 * @returns the parsed parts, or null when the path is not a valid pet asset.
 */
export function parseAssetPath(pathname, prefix) {
  if (typeof pathname !== 'string' || typeof prefix !== 'string') return null
  if (!pathname.startsWith(`${prefix}/`)) return null
  const rest = pathname.slice(prefix.length + 1)
  const slash = rest.indexOf('/')
  if (slash === -1) return null
  const petId = rest.slice(0, slash)
  const file = rest.slice(slash + 1)
  if (!isValidPetId(petId)) return null
  const gif = /^(\d{2})\.gif$/.exec(file)
  if (gif) return { petId, kind: 'gif', mood: gif[1] }
  const pic = /^pics\/(\d{1,3})\.png$/.exec(file)
  if (pic && Number(pic[1]) >= 1) return { petId, kind: 'pic', index: Number(pic[1]) }
  return null
}

/**
 * Upsert one pet into the configured pets array (immutable). Unknown ids are
 * appended; known ids keep their array position.
 * @param pets - the persisted pet entries.
 * @param patch - `{ id }` plus optional `name` / `enabled`.
 * @returns a new pets array.
 */
export function upsertPet(pets, patch) {
  const { id, name, enabled } = patch
  if (!isValidPetId(id)) throw new TypeError(`invalid pet id: ${String(id)}`)
  const next = Object.freeze({
    id,
    ...(name !== undefined ? { name } : {}),
    ...(enabled !== undefined ? { enabled: enabled === true } : {}),
  })
  const index = pets.findIndex((entry) => entry.id === id)
  if (index === -1) return [...pets, next]
  return pets.map((entry, i) => (i === index ? { ...entry, ...next } : entry))
}

/**
 * Parse a pet manifest: optional per-sticker alignment offsets (px) and the
 * pic artwork count. Unknown fields are ignored; a malformed manifest is
 * treated as empty rather than failing the pet.
 * @param text - raw manifest file contents.
 * @returns `{ offsets: { mood: {x,y} }, charH: { mood: number }, pics: number }`.
 */
export function parsePetManifest(text) {
  const result = { offsets: {}, charH: {}, charScale: {}, pics: 0 }
  if (typeof text !== 'string') return result
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return result
  }
  if (raw && typeof raw === 'object') {
    if (raw.offsets && typeof raw.offsets === 'object') {
      for (const [mood, value] of Object.entries(raw.offsets)) {
        if (!/^\d{2}$/.test(mood)) continue
        const x = Number(value?.x)
        const y = Number(value?.y)
        if (Number.isFinite(x) && Number.isFinite(y)) result.offsets[mood] = { x, y }
      }
    }
    const pics = Number(raw.pics)
    if (Number.isInteger(pics) && pics >= 0 && pics <= 999) result.pics = pics
    // Character body height (source pixels) per mood, used by clients to keep
    // the character the same visual size when the artwork canvases differ.
    if (raw.charH && typeof raw.charH === 'object') {
      for (const [mood, value] of Object.entries(raw.charH)) {
        if (!/^\d{2}$/.test(mood)) continue
        const h = Number(value)
        if (Number.isFinite(h) && h > 0) result.charH[mood] = h
      }
    }
    if (raw.charScale && typeof raw.charScale === 'object') {
      for (const [mood, value] of Object.entries(raw.charScale)) {
        if (!/^\d{2}$/.test(mood)) continue
        const v = Number(value)
        if (Number.isFinite(v) && v > 0) result.charScale[mood] = v
      }
    }
  }
  return result
}

/**
 * Merge discovered pet directories with the persisted config into the
 * registry view served to the settings page and the pet client.
 * @param discovered - `[{ id, gifs }]`, one entry per assets/pets/<id> dir;
 *   `gifs` lists the present mood filenames (e.g. `['01.gif', '03.gif']`).
 * @param configured - the persisted pets config array.
 * @param activePetId - the persisted active pet id (may be stale).
 * @returns the registry view.
 */
export function buildRegistry(discovered, configured, activePetId) {
  const configs = new Map((configured ?? []).map((entry) => [entry.id, entry]))
  const seen = new Set()

  const pets = []
  for (const dir of discovered) {
    if (!isValidPetId(dir.id)) continue
    seen.add(dir.id)
    const gifs = Array.isArray(dir.gifs) ? dir.gifs : []
    const manifest = dir.manifest ?? { offsets: {}, pics: 0 }
    const configuredEntry = configs.get(dir.id)
    const complete = PET_MOODS.every((mood) => gifs.includes(`${mood}${PET_MOOD_EXT}`))
    const previewMood = PET_MOODS.find((mood) => gifs.includes(`${mood}${PET_MOOD_EXT}`)) ?? PET_MOODS[0]
    pets.push({
      id: dir.id,
      name: configuredEntry?.name ?? dir.id,
      enabled: configuredEntry?.enabled === true,
      available: true,
      complete,
      gifCount: gifs.length,
      previewMood,
      offsets: manifest.offsets ?? {},
      charH: manifest.charH ?? {},
      charScale: manifest.charScale ?? {},
      pics: manifest.pics ?? 0,
    })
  }

  // Configured entries whose directory vanished stay visible (never silently
  // drop persisted config); they are marked unavailable instead.
  for (const entry of configured ?? []) {
    if (!seen.has(entry.id)) {
      pets.push({
        id: entry.id,
        name: entry.name ?? entry.id,
        enabled: entry.enabled === true,
        available: false,
        complete: false,
        gifCount: 0,
        previewMood: PET_MOODS[0],
        offsets: {},
        pics: 0,
      })
    }
  }

  const active = resolveActive(pets, activePetId)
  return { activePetId: active, pets }
}

/**
 * Resolve the pet to display: the persisted active id when that pet is
 * enabled and complete; otherwise the first enabled complete pet; otherwise
 * the default id (the client falls back to the default sticker set when the
 * resolved pet has no artwork).
 */
export function resolveActive(pets, activePetId) {
  const showable = (pet) => pet.enabled === true && pet.available === true && pet.complete === true
  return (
    pets.find((pet) => pet.id === activePetId && showable(pet))?.id
    ?? pets.find(showable)?.id
    ?? DEFAULT_PET_ID
  )
}
