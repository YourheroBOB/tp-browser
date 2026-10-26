// Kept separate from daemon startup so shutdown can be tested without a browser
// or reading any user profile, token, or vault files.
export async function flushAndClose(hub) {
  let vaultSynced = false;
  let browserCloseSent = false;
  const errors = [];

  if (!hub) {
    errors.push('hub_unavailable');
  } else {
    try {
      await hub.syncVaultNow({ flush: true });
      vaultSynced = true;
    } catch {
      // Report the failed stage without exposing cookie/storage values in errors.
      errors.push('vault_sync_failed');
    }
    try {
      // Still give Chromium a chance to save its profile if the vault failed.
      await hub.cdp.send('Browser.close');
      browserCloseSent = true;
    } catch {
      errors.push('browser_close_failed');
    }
  }

  return {
    ok: vaultSynced && browserCloseSent,
    vault_synced: vaultSynced,
    browser_close_sent: browserCloseSent,
    flushed: vaultSynced,
    errors,
  };
}

export async function handleFlushAndClose(hub, res) {
  const result = await flushAndClose(hub);
  // Older launchers expect HTTP 200 even when flushing failed.
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
}
