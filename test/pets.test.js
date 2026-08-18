import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PET_ID,
  PET_MOODS,
  buildRegistry,
  isValidMood,
  isValidPetId,
  parseAssetPath,
  parsePetManifest,
  resolveActive,
  upsertPet,
} from '../src/pets.js'

const ASSET_PREFIX = '/plugins/dsh-pet-remielle/assets'

const fullGifs = PET_MOODS.map((mood) => `${mood}.gif`)

function discovered(entries) {
  return entries.map(([id, gifs]) => ({ id, gifs, manifest: { offsets: {}, pics: 0 } }))
}

test('isValidPetId accepts safe directory names', () => {
  for (const id of ['remielle', 'pet-2', 'A_b', 'a1', '1', 'x'.repeat(64)]) {
    assert.equal(isValidPetId(id), true, `expected ${id} to be valid`)
  }
})

test('isValidPetId rejects traversal and unsafe names', () => {
  for (const id of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a b', '宠物', 'a.b', '-lead', '_lead']) {
    assert.equal(isValidPetId(id), false, `expected ${JSON.stringify(id)} to be invalid`)
  }
})

test('isValidMood accepts the six sticker slots only', () => {
  for (const mood of PET_MOODS) assert.equal(isValidMood(mood), true)
  for (const mood of ['00', '07', '', '01.gif']) assert.equal(isValidMood(mood), false)
})

test('upsertPet appends unknown ids and updates known ones in place', () => {
  const base = [{ id: 'remielle', name: '蕾米埃尔', enabled: true }]
  const added = upsertPet(base, { id: 'cirno', name: '琪露诺' })
  assert.deepEqual(added.map((p) => p.id), ['remielle', 'cirno'])
  assert.equal(added[1].enabled, undefined)

  const updated = upsertPet(base, { id: 'remielle', name: '蕾米', enabled: false })
  assert.equal(updated.length, 1)
  assert.equal(updated[0].name, '蕾米')
  assert.equal(updated[0].enabled, false)
  assert.equal(base[0].name, '蕾米埃尔') // immutable

  assert.throws(() => upsertPet(base, { id: '../evil' }), /invalid pet id/)
})

test('buildRegistry merges discovered dirs with configured pets', () => {
  const view = buildRegistry(
    discovered([
      ['remielle', fullGifs],
      ['cirno', fullGifs],
      ['koishi', ['01.gif', '02.gif']], // incomplete
    ]),
    [
      { id: 'remielle', name: '蕾米埃尔', enabled: true },
      { id: 'koishi', name: '古明地恋', enabled: true },
    ],
    'remielle',
  )
  assert.equal(view.activePetId, 'remielle')
  assert.deepEqual(view.pets.map((p) => p.id), ['remielle', 'cirno', 'koishi'])

  const remielle = view.pets[0]
  assert.equal(remielle.name, '蕾米埃尔')
  assert.equal(remielle.enabled, true)
  assert.equal(remielle.complete, true)
  assert.equal(remielle.available, true)

  // Unconfigured dir: disabled until the user flips it on.
  const cirno = view.pets[1]
  assert.equal(cirno.name, 'cirno')
  assert.equal(cirno.enabled, false)
  assert.equal(cirno.complete, true)

  // Incomplete dir is detected even when enabled.
  const koishi = view.pets[2]
  assert.equal(koishi.enabled, true)
  assert.equal(koishi.complete, false)
  assert.equal(koishi.gifCount, 2)
})

test('buildRegistry keeps configured pets whose dir vanished, marked unavailable', () => {
  const view = buildRegistry(
    discovered([['remielle', fullGifs]]),
    [
      { id: 'remielle', name: '蕾米埃尔', enabled: true },
      { id: 'cirno', name: '琪露诺', enabled: true },
    ],
    'remielle',
  )
  assert.deepEqual(view.pets.map((p) => p.id), ['remielle', 'cirno'])
  assert.equal(view.pets[1].available, false)
  assert.equal(view.pets[1].complete, false)
  assert.equal(view.pets[1].enabled, true)
})

test('buildRegistry ignores unsafe directory names', () => {
  const view = buildRegistry(
    discovered([
      ['remielle', fullGifs],
      ['../evil', fullGifs],
    ]),
    [],
    'remielle',
  )
  assert.deepEqual(view.pets.map((p) => p.id), ['remielle'])
})

test('resolveActive prefers the persisted active pet', () => {
  const pets = [
    { id: 'a', enabled: true, available: true, complete: true },
    { id: 'b', enabled: true, available: true, complete: true },
  ]
  assert.equal(resolveActive(pets, 'b'), 'b')
})

test('resolveActive skips disabled and incomplete pets', () => {
  const pets = [
    { id: 'a', enabled: true, available: true, complete: false },
    { id: 'b', enabled: false, available: true, complete: true },
    { id: 'c', enabled: true, available: true, complete: true },
  ]
  assert.equal(resolveActive(pets, 'a'), 'c')
})

test('resolveActive falls back to the default id when nothing is showable', () => {
  const pets = [
    { id: 'a', enabled: false, available: true, complete: true },
    { id: 'b', enabled: true, available: true, complete: false },
  ]
  assert.equal(resolveActive(pets, 'a'), DEFAULT_PET_ID)
})

test('parseAssetPath accepts well-formed pet assets', () => {
  assert.deepEqual(parseAssetPath(`${ASSET_PREFIX}/remielle/01.gif`, ASSET_PREFIX), {
    petId: 'remielle',
    kind: 'gif',
    mood: '01',
  })
  assert.deepEqual(parseAssetPath(`${ASSET_PREFIX}/pet-2/06.gif`, ASSET_PREFIX), {
    petId: 'pet-2',
    kind: 'gif',
    mood: '06',
  })
  // Extra sticker slots beyond the six required moods are valid asset paths.
  assert.deepEqual(parseAssetPath(`${ASSET_PREFIX}/remielle/07.gif`, ASSET_PREFIX), {
    petId: 'remielle',
    kind: 'gif',
    mood: '07',
  })
  // Pic artwork: /pics/<n>.png
  assert.deepEqual(parseAssetPath(`${ASSET_PREFIX}/xiaoleimi/pics/3.png`, ASSET_PREFIX), {
    petId: 'xiaoleimi',
    kind: 'pic',
    index: 3,
  })
})

test('parseAssetPath rejects traversal, foreign files, and stray prefixes', () => {
  const bad = [
    `${ASSET_PREFIX}/..%2F..%2Fetc/passwd`,
    `${ASSET_PREFIX}/../x/01.gif`,
    `${ASSET_PREFIX}/remielle/../01.gif`,
    `${ASSET_PREFIX}/remielle/01.png`,
    `${ASSET_PREFIX}/remielle/01`,
    `${ASSET_PREFIX}/remielle/0.gif`,
    `${ASSET_PREFIX}/remielle/01.GIF`,
    `${ASSET_PREFIX}/remielle/pics/0.png`,
    `${ASSET_PREFIX}/remielle/pics/-1.png`,
    `${ASSET_PREFIX}/remielle/pics/abc.png`,
    `${ASSET_PREFIX}/remielle/pics/01.png/extra`,
    `${ASSET_PREFIX}/remielle`,
    `/plugins/dsh-pet-remielle/state`,
    `${ASSET_PREFIX}/remielle/01.gif/extra`,
  ]
  for (const pathname of bad) {
    assert.equal(parseAssetPath(pathname, ASSET_PREFIX), null, `expected ${pathname} to be rejected`)
  }
  assert.equal(parseAssetPath('', ASSET_PREFIX), null)
  assert.equal(parseAssetPath(null, ASSET_PREFIX), null)
})

test('parsePetManifest extracts offsets and pics count, tolerates garbage', () => {
  const parsed = parsePetManifest(JSON.stringify({
    offsets: { '01': { x: -39, y: 4 }, '06': { x: 0, y: 0 } },
    charH: { '01': 274, '06': 272 },
    charScale: { '01': 1.0803, '06': 0.9449 },
    pics: 15,
    extra: 'ignored',
  }))
  assert.deepEqual(parsed.offsets['01'], { x: -39, y: 4 })
  assert.deepEqual(parsed.offsets['06'], { x: 0, y: 0 })
  assert.equal(parsed.charH['01'], 274)
  assert.equal(parsed.charH['06'], 272)
  assert.equal(parsed.charScale['01'], 1.0803)
  assert.equal(parsed.charScale['06'], 0.9449)
  assert.equal(parsed.pics, 15)
  assert.equal(parsePetManifest('not json').pics, 0)
  assert.equal(parsePetManifest(undefined).pics, 0)
  assert.deepEqual(parsePetManifest('{"offsets":{"01":{"x":"a","y":1}}}').offsets, {})
})

test('buildRegistry carries per-pet offsets and pics from the manifest', () => {
  const registry = buildRegistry([
    { id: 'xiaoleimi', gifs: [...fullGifs, '07.gif'], manifest: { offsets: { '01': { x: -39, y: 4 } }, pics: 15 } },
  ], [{ id: 'xiaoleimi', name: '小蕾米', enabled: true }], 'xiaoleimi')
  assert.equal(registry.activePetId, 'xiaoleimi')
  const pet = registry.pets[0]
  assert.deepEqual(pet.offsets['01'], { x: -39, y: 4 })
  assert.equal(pet.pics, 15)
})
