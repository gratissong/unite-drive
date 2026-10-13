type DriveAccountInfo = {
  id: string
  email: string
  usedBytes: number
  limitBytes: number | null
  connected?: boolean
  readWriteAccess?: boolean
}

type Props = {
  clientId: string
  hasOAuthSecret: boolean
  connectionStatus: string
  isConnecting: boolean
  syncEnabled: boolean
  folderSelected: boolean
  accounts: DriveAccountInfo[]
  reservePercent: number
  onImportOAuthConfig: () => void
  onConnectAccount: () => void
  onRemoveAccount: (account: DriveAccountInfo) => void
  onSyncEnabledChange: (enabled: boolean) => void
  onReserveChange: (value: number) => void
  onResetSyncState: () => void
}

function GoogleConnectionControls({
  clientId,
  hasOAuthSecret,
  connectionStatus,
  isConnecting,
  syncEnabled,
  folderSelected,
  accounts,
  reservePercent,
  onImportOAuthConfig,
  onConnectAccount,
  onRemoveAccount,
  onSyncEnabledChange,
  onReserveChange,
  onResetSyncState,
}: Props) {
  return (
    <section className="google-settings">
      <div className="policy-heading">
        <div>
          <p className="eyebrow">GOOGLE DRIVE</p>
          <h2>Accounts &amp; sync</h2>
          <p>Sign in with your Google account. Credentials are encrypted by Windows on this device.</p>
        </div>
      </div>
      <div className="client-id-row">
        <label htmlFor="google-client-id">Google Desktop app credentials</label>
        <div className="client-id-actions">
          <input id="google-client-id" value={clientId || 'No Desktop credentials imported'} readOnly aria-label="Imported Google OAuth client ID" />
          <button className="button button-secondary" onClick={onImportOAuthConfig}>Import credentials JSON</button>
          <button className="button button-primary" onClick={onConnectAccount} disabled={!clientId.trim() || !hasOAuthSecret || isConnecting}>
            {isConnecting ? 'Connecting...' : 'Connect Google Drive'}
          </button>
        </div>
        <p className="settings-note oauth-note">Choose the JSON downloaded for a Google OAuth Desktop app. The client secret is encrypted locally and never displayed.</p>
        {connectionStatus && <p className={`connection-status ${connectionStatus.includes('failed') ? 'error' : ''}`} role="status">{connectionStatus}</p>}
      </div>
      <div className="connected-accounts">
        <div className="policy-copy"><strong>Connected accounts</strong><p>{accounts.length ? 'Drive quota is read from each signed-in account.' : 'No Google Drive accounts connected yet.'}</p></div>
        {accounts.length > 0 && <div className="connected-account-list">{accounts.map((account) => <div className="connected-account" key={account.id}><span className={`connection-dot ${account.connected && account.readWriteAccess ? 'online' : ''}`} /><span>{account.email}</span><span className={`connection-status-text ${account.connected && account.readWriteAccess ? 'ok' : account.connected ? 'warn' : ''}`}>{account.connected && account.readWriteAccess ? 'Connected' : account.connected ? 'Reconnect for two-way sync' : 'Reconnect required'}</span>{!(account.connected && account.readWriteAccess) && <button className="connection-reconnect" onClick={onConnectAccount} disabled={isConnecting}>{isConnecting ? 'Connecting...' : 'Reconnect'}</button>}<button className="connection-remove" onClick={() => onRemoveAccount(account)} disabled={isConnecting}>Remove</button></div>)}</div>}
      </div>
      <div className="setting-row">
        <div><strong>Minimum free space</strong><p>Keep this percentage unused on each account.</p></div>
        <label className="reserve-control"><input type="number" min="0" max="50" value={reservePercent} onChange={(event) => onReserveChange(Number(event.target.value))} /><span>%</span></label>
      </div>
      <div className="setting-row sync-enable-row">
        <div><strong>Keep this folder synced</strong><p>{folderSelected ? 'Changes are watched locally and checked against Drive periodically.' : 'Choose a local folder before enabling sync.'}</p></div>
        <button className={`toggle ${syncEnabled ? 'on' : ''}`} role="switch" aria-checked={syncEnabled} aria-label="Keep this folder synced" disabled={!folderSelected || accounts.length === 0} onClick={() => onSyncEnabledChange(!syncEnabled)}><span /></button>
      </div>
      <div className="reset-sync-row">
        <div><strong>Start a fresh sync scan</strong><p>Clears local file mappings and queued work. Files in Google Drive are left untouched.</p></div>
        <button className="button button-secondary" onClick={onResetSyncState}>Reset sync state</button>
      </div>
    </section>
  )
}

export default GoogleConnectionControls
