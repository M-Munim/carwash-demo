'use client';

import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';

/**
 * Demo only: after a visitor adds, edits or deletes something, the change
 * stays for 20 seconds (utils/demo/core.js, CHANGE_TTL_MS). This shows the
 * countdown and reloads the page when the sample data comes back.
 */
export default function DemoResetNotice() {
  const [resetAt, setResetAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // The data loads on the first request, after this mounts: the event brings the time.
    const onChanged = (e) => {
      setNow(Date.now());
      setResetAt(e.detail?.resetAt || 0);
    };
    const onReset = () => {
      setResetAt(0);
      window.location.reload();
    };
    window.addEventListener('washdesk-demo-changed', onChanged);
    window.addEventListener('washdesk-demo-reset', onReset);
    return () => {
      window.removeEventListener('washdesk-demo-changed', onChanged);
      window.removeEventListener('washdesk-demo-reset', onReset);
    };
  }, []);

  useEffect(() => {
    if (!resetAt) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [resetAt]);

  if (!resetAt) return null;
  const seconds = Math.max(0, Math.ceil((resetAt - now) / 1000));

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-[9999] -translate-x-1/2 flex items-center gap-2 rounded-full bg-gray-900/90 px-4 py-2 text-sm text-white shadow-lg print:hidden"
    >
      <Timer className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        Demo: your changes are cleared in <strong className="tabular-nums">{seconds}s</strong>
      </span>
    </div>
  );
}
