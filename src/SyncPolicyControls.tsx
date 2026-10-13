type ConflictPolicy = 'keep-both' | 'prefer-local' | 'prefer-remote'
type DeletionPolicy = 'propagate-to-trash' | 'keep-other-copy'

type Props = {
  conflictPolicy: ConflictPolicy
  deletionPolicy: DeletionPolicy
  onConflictPolicyChange: (policy: ConflictPolicy) => void
  onDeletionPolicyChange: (policy: DeletionPolicy) => void
}

function SyncPolicyControls({ conflictPolicy, deletionPolicy, onConflictPolicyChange, onDeletionPolicyChange }: Props) {
  return (
    <section className="policy-settings">
      <div className="policy-heading">
        <div>
          <p className="eyebrow">SYNC SAFETY</p>
          <h2>Conflicts &amp; deletions</h2>
          <p>These rules apply when Drive accounts are connected and sync is enabled.</p>
        </div>
      </div>
      <div className="policy-row">
        <div className="policy-copy">
          <strong>When both copies change</strong>
          <p>Keep both creates a timestamped conflict copy instead of silently overwriting either version.</p>
        </div>
        <select aria-label="Conflict policy" value={conflictPolicy} onChange={(event) => onConflictPolicyChange(event.target.value as ConflictPolicy)}>
          <option value="keep-both">Keep both versions</option>
          <option value="prefer-local">Prefer this PC</option>
          <option value="prefer-remote">Prefer Google Drive</option>
        </select>
      </div>
      <div className="policy-row">
        <div className="policy-copy">
          <strong>When a file is deleted</strong>
          <p>Propagate to trash is recoverable. Keep other copy restores the file from the side where it remains.</p>
        </div>
        <select aria-label="Deletion policy" value={deletionPolicy} onChange={(event) => onDeletionPolicyChange(event.target.value as DeletionPolicy)}>
          <option value="propagate-to-trash">Move other copy to trash</option>
          <option value="keep-other-copy">Keep the other copy</option>
        </select>
      </div>
    </section>
  )
}

export default SyncPolicyControls
