import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, Check, RefreshCw, Scale, ShieldCheck, Sparkles } from 'lucide-react'
import { useConfirm } from './confirm'

type DriveAccount = {
  id: string
  name: string
  email: string
  color: string
  initials: string
  used: number
  quota: number
}

type RebalanceAccount = {
  id: string
  email: string | null
  limitBytes: number
  usageBytes: number
  managedBytes: number
  movableFiles: number
  fillPercent: number
}

type RebalanceMove = {
  relativePath: string
  fromAccountId: string
  toAccountId: string
  sizeBytes: number
}

type RebalancePlan = {
  applied: boolean
  queued: number
  moves: RebalanceMove[]
  totalBytes: number
  totalFiles: number
  thresholdPercent: number
  capped: boolean
  balanced: boolean
  blockedAccountIds: string[]
  accounts: RebalanceAccount[]
  projected: RebalanceAccount[]
}

type Props = {
  accounts: DriveAccount[]
  isDemoData: boolean
  applying: boolean
  onRebalance: (options: { maxBytes: number | null }) => Promise<boolean>
}

const gib = 1024 ** 3

function formatBytes(bytes: number) {
  const tib = 1024 ** 4
  if (!Number.isFinite(bytes)) return '—'
  if (bytes >= tib) return `${(bytes / tib).toFixed(1)} TB`
  if (bytes >= gib) return `${(bytes / gib).toFixed(bytes / gib < 10 ? 1 : 0)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const capOptions: Array<{ value: string; label: string }> = [
  { value: '', label: 'No limit' },
  { value: '10', label: '10 GB' },
  { value: '25', label: '25 GB' },
  { value: '50', label: '50 GB' },
  { value: '100', label: '100 GB' },
  { value: '250', label: '250 GB' },
]

// A representative plan for demo mode, where no Drive accounts are connected.
function demoPlan(accounts: DriveAccount[]): RebalancePlan {
  const finite = accounts
    .filter((account) => account.quota > 0)
    .map((account) => ({
      id: account.id,
      email: account.email,
      limitBytes: account.quota,
      usageBytes: account.used,
      managedBytes: Math.round(account.used * 0.45),
      movableFiles: 40,
      fillPercent: (account.used / account.quota) * 100,
    }))
    .sort((first, second) => second.fillPercent - first.fillPercent)
  if (finite.length < 2) return { applied: false, queued: 0, moves: [], totalBytes: 0, totalFiles: 0, thresholdPercent: 5, capped: false, balanced: true, blockedAccountIds: [], accounts: finite, projected: finite }
  const fullest = finite[0]
  const emptiest = finite[finite.length - 1]
  const share = Math.min(fullest.usageBytes * 0.6, 6.4 * gib)
  const moves: RebalanceMove[] = [
    { relativePath: 'Backup/Japan trip — originals.zip', fromAccountId: fullest.id, toAccountId: emptiest.id, sizeBytes: share },
    { relativePath: 'Work/Q3 campaign assets', fromAccountId: fullest.id, toAccountId: emptiest.id, sizeBytes: share > 6.4 * gib ? share - 6.4 * gib : 1.8 * gib },
  ]
  const totalBytes = moves.reduce((total, move) => total + move.sizeBytes, 0)
  const projected = finite.map((account) => {
    const delta = moves.filter((move) => move.toAccountId === account.id).reduce((total, move) => total + move.sizeBytes, 0)
      - moves.filter((move) => move.fromAccountId === account.id).reduce((total, move) => total + move.sizeBytes, 0)
    const usageBytes = Math.max(0, account.usageBytes + delta)
    return { ...account, usageBytes, fillPercent: (usageBytes / account.limitBytes) * 100 }
  })
  return { applied: false, queued: 0, moves, totalBytes, totalFiles: moves.length, thresholdPercent: 5, capped: false, balanced: false, blockedAccountIds: [], accounts: finite, projected }
}

function RebalanceReport({ accounts, isDemoData, applying, onRebalance }: Props) {
  const confirm = useConfirm()
  const [plan, setPlan] = useState<RebalancePlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [capGb, setCapGb] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  const capBytes = capGb === '' ? null : Number(capGb) * gib
  const canQuery = !isDemoData && Boolean(window.uniteDrive) && accounts.length > 0
  const effectivePlan = isDemoData ? demoPlan(accounts) : plan
  const showLoading = canQuery && (loading || (!effectivePlan && !error))

  // Fetch on mount, when the cap changes, and when explicitly recalculated. All
  // state updates happen in the promise callbacks (never synchronously), so this
  // stays a pure external-system sync.
  useEffect(() => {
    if (!canQuery) return
    let cancelled = false
    window.uniteDrive!.getRebalancePlan(capBytes ? { maxBytes: capBytes } : {})
      .then((result) => { if (!cancelled) { setPlan(result); setError(''); setLoading(false) } })
      .catch((caught) => { if (!cancelled) { setPlan(null); setError(caught instanceof Error ? caught.message : 'The drives could not be analyzed for rebalancing.'); setLoading(false) } })
    return () => { cancelled = true }
  }, [canQuery, capBytes, reloadToken])

  function recalculate() {
    setLoading(true)
    setReloadToken((token) => token + 1)
  }

  const metaById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts])
  const metaFor = (account: RebalanceAccount) => metaById.get(account.id) ?? {
    id: account.id,
    name: account.email?.split('@')[0] ?? account.id,
    email: account.email ?? '',
    color: 'blue',
    initials: (account.email ?? account.id).charAt(0).toUpperCase(),
    used: account.usageBytes,
    quota: account.limitBytes,
  }

  const routes = useMemo(() => {
    if (!effectivePlan) return []
    const grouped = new Map<string, { key: string; fromAccountId: string; toAccountId: string; count: number; bytes: number; samples: string[] }>()
    for (const move of effectivePlan.moves) {
      const key = `${move.fromAccountId}->${move.toAccountId}`
      let route = grouped.get(key)
      if (!route) {
        route = { key, fromAccountId: move.fromAccountId, toAccountId: move.toAccountId, count: 0, bytes: 0, samples: [] }
        grouped.set(key, route)
      }
      route.count += 1
      route.bytes += move.sizeBytes
      if (route.samples.length < 3) route.samples.push(move.relativePath.split('/').at(-1) || move.relativePath)
    }
    return [...grouped.values()].sort((first, second) => second.bytes - first.bytes)
  }, [effectivePlan])

  async function apply() {
    if (!effectivePlan || effectivePlan.moves.length === 0 || applying) return
    const confirmed = await confirm({
      tone: 'warning',
      eyebrow: 'REBALANCE DRIVES',
      title: `Move ${effectivePlan.totalFiles} file${effectivePlan.totalFiles === 1 ? '' : 's'} (${formatBytes(effectivePlan.totalBytes)})?`,
      message: 'Each file is copied to its new drive and checked, then the original copy is permanently deleted to free space immediately. Your local folder is unchanged, so nothing is lost. Progress appears in Transfers.',
      confirmLabel: 'Rebalance now',
    })
    if (!confirmed) return
    const applied = await onRebalance({ maxBytes: capBytes })
    if (applied) recalculate()
  }

  const fullestAccount = effectivePlan && effectivePlan.accounts.length
    ? [...effectivePlan.accounts].sort((first, second) => second.fillPercent - first.fillPercent)[0]
    : undefined
  const fullestName = fullestAccount ? metaFor(fullestAccount).name : ''
  const fullestIsBlocked = Boolean(effectivePlan && fullestAccount && effectivePlan.blockedAccountIds.includes(fullestAccount.id))

  let summary
  let emptyState = ''
  if (isDemoData) {
    summary = 'This sample plan shows how files would spread across your drives. Connect real Google accounts to see and apply an actual rebalance.'
  } else if (showLoading && !effectivePlan) {
    summary = 'Reading each drive’s usage to find the best way to even them out…'
  } else if (!effectivePlan || effectivePlan.accounts.length < 2) {
    summary = 'Connect at least two Google Drive accounts with a fixed quota to move files between them.'
  } else if (effectivePlan.totalFiles > 0) {
    summary = `Moving ${formatBytes(effectivePlan.totalBytes)} from fuller drives to emptier ones would bring every drive within about ${effectivePlan.thresholdPercent}% of each other.`
  } else if (!effectivePlan.balanced && fullestIsBlocked && fullestAccount) {
    summary = `${fullestName} is ${Math.round(fullestAccount.fillPercent)}% full, but Unite Drive has no files there to move. Its space is used by Gmail, Google Photos, or files outside your sync folder — rebalancing can only relocate files inside your sync folder.`
    emptyState = `${fullestName} has no Unite Drive files to relocate, so its usage can't be rebalanced.`
  } else if (!effectivePlan.balanced) {
    summary = 'No synced file can be moved without pushing another drive past its reserve. Add a drive with more room, or lower the reserve in Settings.'
    emptyState = 'No file can be moved right now without overfilling a drive.'
  } else {
    summary = `Your drives are already balanced within ${effectivePlan.thresholdPercent}% of each other.`
    emptyState = 'Your drives are already balanced — nothing needs to move.'
  }

  return (
    <section className="storage-page-section">
      <div className="dedup-summary">
        <span className="dedup-icon balance"><Scale size={18} /></span>
        <div className="dedup-summary-copy">
          <p className="eyebrow">BALANCE YOUR SPACE</p>
          <h2>Even out your Google Drives</h2>
          <p>{summary}</p>
        </div>
      </div>

      {showLoading && !effectivePlan ? (
        <div className="dedup-empty"><RefreshCw size={18} /><p>Measuring your drives…</p></div>
      ) : error ? (
        <div className="dedup-empty"><AlertTriangle size={18} /><p>{error}</p></div>
      ) : effectivePlan && effectivePlan.accounts.length >= 2 ? (
        <>
          <div className="rebalance-grid">
            {effectivePlan.accounts.map((account) => {
              const meta = metaFor(account)
              const projected = effectivePlan.projected.find((item) => item.id === account.id) ?? account
              const trend = projected.fillPercent < account.fillPercent - 0.5 ? 'down' : projected.fillPercent > account.fillPercent + 0.5 ? 'up' : ''
              const blocked = fullestIsBlocked && account.id === fullestAccount?.id
              return (
                <article className={`rebalance-drive${blocked ? ' blocked' : ''}`} key={account.id}>
                  <div className="rebalance-drive-head">
                    <span className={`account-avatar ${meta.color}`}>{meta.initials}</span>
                    <div className="rebalance-drive-id"><strong>{meta.name}</strong><span>{meta.email}</span></div>
                    <span className={`account-health ${account.fillPercent >= 80 ? 'near-limit' : ''}`}>{Math.round(account.fillPercent)}% full</span>
                  </div>
                  <div className="capacity-track"><span className={`capacity-fill ${meta.color}`} style={{ width: `${Math.min(100, account.fillPercent)}%` }} /></div>
                  <div className="rebalance-drive-meta">
                    <span>{formatBytes(account.usageBytes)} of {formatBytes(account.limitBytes)} used</span>
                    <span className={`rebalance-trend ${trend}`}>{Math.round(projected.fillPercent)}% after</span>
                  </div>
                  <div className="rebalance-drive-managed">
                    {account.movableFiles > 0
                      ? `Unite manages ${formatBytes(account.managedBytes)} · ${account.movableFiles} movable`
                      : `Unite manages ${formatBytes(account.managedBytes)}`}
                    {blocked && <span className="rebalance-flag">nothing to move</span>}
                  </div>
                </article>
              )
            })}
          </div>

          <div className="rebalance-controls">
            <label className="rebalance-cap">
              <span>Maximum data to move</span>
              <select aria-label="Maximum data to move" value={capGb} onChange={(event) => { setLoading(true); setCapGb(event.target.value) }} disabled={applying}>
                {capOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button className="button button-secondary" onClick={recalculate} disabled={showLoading || applying}><RefreshCw size={14} /> Recalculate</button>
          </div>

          {effectivePlan.moves.length === 0 ? (
            <div className="dedup-empty"><Check size={18} /><p>{emptyState}</p></div>
          ) : (
            <div className="rebalance-routes">
              <div className="rebalance-routes-head">
                <div><strong>Proposed moves</strong><p>{effectivePlan.totalFiles} file{effectivePlan.totalFiles === 1 ? '' : 's'} · {formatBytes(effectivePlan.totalBytes)}{effectivePlan.capped ? ' · limited by your cap' : ''}</p></div>
              </div>
              <ul className="rebalance-route-list">
                {routes.map((route) => {
                  const fromAccount = effectivePlan.accounts.find((item) => item.id === route.fromAccountId)
                  const toAccount = effectivePlan.accounts.find((item) => item.id === route.toAccountId)
                  const from = metaFor(fromAccount ?? { id: route.fromAccountId, email: null, limitBytes: 0, usageBytes: 0, managedBytes: 0, movableFiles: 0, fillPercent: 0 })
                  const to = metaFor(toAccount ?? { id: route.toAccountId, email: null, limitBytes: 0, usageBytes: 0, managedBytes: 0, movableFiles: 0, fillPercent: 0 })
                  return (
                    <li className="rebalance-route" key={route.key}>
                      <span className="rebalance-route-files" title={route.samples.join(', ')}>
                        {route.samples.join(', ')}{route.count > route.samples.length ? ` +${route.count - route.samples.length} more` : ''}
                      </span>
                      <span className="rebalance-route-move">
                        <span className={`mini-drive-dot ${from.color}`} />{from.name}
                        <ArrowRight size={12} />
                        <span className={`mini-drive-dot ${to.color}`} />{to.name}
                      </span>
                      <span className="rebalance-route-size">{formatBytes(route.bytes)}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          <div className="rebalance-actions">
            <p className="rebalance-note"><ShieldCheck size={13} /> Files are copied to the new drive and verified, then the original copy is permanently deleted to free space immediately. Your local sync folder is left untouched.</p>
            <button className="button button-primary" onClick={() => void apply()} disabled={applying || effectivePlan.moves.length === 0}>
              {applying ? 'Rebalancing…' : effectivePlan.moves.length ? `Rebalance ${effectivePlan.totalFiles} file${effectivePlan.totalFiles === 1 ? '' : 's'}` : 'Already balanced'}
            </button>
          </div>
        </>
      ) : (
        <div className="dedup-empty"><Scale size={18} /><p>Connect at least two Google Drive accounts with a fixed quota to rebalance between them.</p></div>
      )}

      {isDemoData && <div className="demo-notice"><Sparkles size={15} /><span>Sample plan shown for preview. Real rebalancing copies files between your connected drives and frees space on the fuller ones.</span></div>}
    </section>
  )
}

export default RebalanceReport
