import { ipcBridge } from '@/common';
import { useEffect, useState } from 'react';

/** Subscribe before reading so a live change wins over an older IPC response. */
export function useOfflineMode(active = true) {
  const [offline, setOffline] = useState<boolean>();

  useEffect(() => {
    if (!active) return;
    let current = true;
    const remove = ipcBridge.systemSettings.offlineModeChanged.on((enabled) => {
      current = false;
      setOffline(enabled);
    });
    void ipcBridge.systemSettings.getOfflineMode
      .invoke()
      .then((enabled) => {
        if (current) setOffline(enabled);
      })
      .catch(() => {});
    return () => {
      current = false;
      remove();
    };
  }, [active]);

  return [offline, setOffline] as const;
}
