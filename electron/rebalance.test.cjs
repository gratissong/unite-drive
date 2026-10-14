const test = require('node:test')
const assert = require('node:assert/strict')
const { planRebalance } = require('./rebalance.cjs')

function account(id, usageBytes, limitBytes = 100) {
  return { id, email: `${id}@example.com`, usageBytes, limitBytes }
}

function file(relativePath, accountId, sizeBytes) {
  return {
    relative_path: relativePath,
    account_id: accountId,
    drive_file_id: `drive-${relativePath}`,
    size_bytes: sizeBytes,
    baseline_hash: `hash-${relativePath}`,
    sync_state: 'active',
  }
}

test('moves files from the fullest drive to the emptiest until they balance', () => {
  const plan = planRebalance({
    accounts: [account('full', 90), account('empty', 10)],
    files: [file('a.bin', 'full', 10), file('b.bin', 'full', 10), file('c.bin', 'full', 10), file('d.bin', 'full', 10), file('e.bin', 'full', 10)],
  })

  assert.equal(plan.balanced, true)
  assert.equal(plan.totalBytes, 40)
  assert.equal(plan.moves.length, 4)
  assert.equal(plan.moves.every((move) => move.fromAccountId === 'full' && move.toAccountId === 'empty'), true)
  const full = plan.projected.find((item) => item.id === 'full')
  const empty = plan.projected.find((item) => item.id === 'empty')
  assert.equal(full.fillPercent, 50)
  assert.equal(empty.fillPercent, 50)
})

test('leaves drives already within the threshold untouched', () => {
  const plan = planRebalance({
    accounts: [account('a', 52), account('b', 48)],
    files: [file('a.bin', 'a', 10)],
  })

  assert.equal(plan.moves.length, 0)
  assert.equal(plan.balanced, true)
  assert.equal(plan.totalBytes, 0)
})

test('does not overfill a receiver past its configured reserve', () => {
  // Receiver has only 5 bytes free once the 10% reserve is kept, so a 10-byte
  // file cannot move even though the drives are far apart.
  const plan = planRebalance({
    accounts: [account('full', 95), account('tight', 85)],
    files: [file('big.bin', 'full', 10)],
    reservePercent: 10,
  })

  assert.equal(plan.moves.length, 0)
  assert.equal(plan.balanced, false)
})

test('ignores unlimited drives that have no meaningful fill', () => {
  const plan = planRebalance({
    accounts: [account('finite', 90), { id: 'unlimited', email: 'u@example.com', usageBytes: 0, limitBytes: null }],
    files: [file('a.bin', 'finite', 10)],
  })

  assert.equal(plan.moves.length, 0)
  assert.equal(plan.balanced, true)
})

test('ignores files that are not fully synced or have no known size', () => {
  const plan = planRebalance({
    accounts: [account('full', 90), account('empty', 0)],
    files: [
      { ...file('tomb.bin', 'full', 10), sync_state: 'tombstone' },
      { ...file('nosize.bin', 'full', null), size_bytes: null },
      { relative_path: 'orphan.bin', account_id: 'full', drive_file_id: null, size_bytes: 10, sync_state: 'active' },
    ],
  })

  assert.equal(plan.moves.length, 0)
})

test('stops at the maximum number of moves and reports it as capped', () => {
  const plan = planRebalance({
    accounts: [account('full', 100), account('empty', 0)],
    files: [file('a.bin', 'full', 10), file('b.bin', 'full', 10), file('c.bin', 'full', 10), file('d.bin', 'full', 10)],
    options: { maxMoves: 2 },
  })

  assert.equal(plan.moves.length, 2)
  assert.equal(plan.capped, true)
  assert.equal(plan.balanced, false)
})

test('stops at the maximum number of bytes and reports it as capped', () => {
  const plan = planRebalance({
    accounts: [account('full', 100), account('empty', 0)],
    files: [file('a.bin', 'full', 10), file('b.bin', 'full', 10), file('c.bin', 'full', 10), file('d.bin', 'full', 10)],
    options: { maxBytes: 20 },
  })

  assert.equal(plan.totalBytes, 20)
  assert.equal(plan.moves.length, 2)
  assert.equal(plan.capped, true)
})

test('prefers the largest file that keeps the receiver under the donor', () => {
  const plan = planRebalance({
    accounts: [account('full', 80), account('empty', 0)],
    files: [file('small.bin', 'full', 10), file('huge.bin', 'full', 30), file('medium.bin', 'full', 20)],
  })

  // huge (30) moves first; medium (20) would overshoot the donor, so the smaller
  // file that lands the pair exactly even (40%-40%) is chosen instead.
  assert.deepEqual(plan.moves.map((move) => move.relativePath), ['huge.bin', 'small.bin'])
  assert.equal(plan.projected.find((item) => item.id === 'full').fillPercent, 40)
})

test('redistributes across more than two drives', () => {
  const plan = planRebalance({
    accounts: [account('a', 100), account('b', 0), account('c', 0)],
    files: [file('a1.bin', 'a', 42), file('a2.bin', 'a', 42), file('a3.bin', 'a', 6)],
    options: { thresholdPercent: 1 },
  })

  // The second 42-byte file cannot move without overshooting, so 48 bytes land on
  // b and c and a stays at 52%.
  assert.equal(plan.totalBytes, 48)
  assert.equal(plan.moves.every((move) => move.fromAccountId === 'a'), true)
  assert.deepEqual(new Set(plan.moves.map((move) => move.toAccountId)), new Set(['b', 'c']))
})

test('reports a plan with no accounts gracefully', () => {
  const plan = planRebalance({ accounts: [], files: [] })
  assert.deepEqual(plan.moves, [])
  assert.equal(plan.balanced, true)
  assert.equal(plan.capped, false)
})
