const test = require('node:test')
const assert = require('node:assert/strict')
const { clusterSimilar, hammingDistance } = require('./similar-scanner.cjs')

test('hammingDistance counts differing bits between two perceptual hashes', () => {
  assert.equal(hammingDistance(0n, 0n), 0)
  assert.equal(hammingDistance(0n, 1n), 1)
  // 15 low bits set
  assert.equal(hammingDistance(0n, (1n << 15n) - 1n), 15)
})

test('clusterSimilar groups near-identical hashes and keeps distinct photos apart', () => {
  const records = [
    { path: 'burst/a.jpg', hash: 0n },
    // Only the lowest bit differs -> considered the same shot.
    { path: 'burst/a2.jpg', hash: 1n },
    // 5 differing bits: well within the threshold, joins the burst.
    { path: 'burst/a3.jpg', hash: 0b0000000000011111n },
    // 15 differing bits: a clearly different photo -> its own group.
    { path: 'other/b.jpg', hash: (1n << 15n) - 1n },
  ]

  const groups = clusterSimilar(records)
  assert.equal(groups.length, 2)

  const burst = groups.find((group) => group.repr.path === 'burst/a.jpg')
  const other = groups.find((group) => group.repr.path === 'other/b.jpg')
  assert.equal(burst.files.map((record) => record.path).sort().join(','), 'burst/a.jpg,burst/a2.jpg,burst/a3.jpg')
  assert.deepEqual(other.files.map((record) => record.path), ['other/b.jpg'])
})