import type { ReactNode } from "react";

/** Desktop phone-shaped (9:19.5) frame around the learn preview; fills at ≤640px (CSS). */
export function PhoneFrame({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  // Same DOM either way so toggling never remounts (reloads) the iframe.
  return (
    <div className={`cocreate-learn-fill learn-phone${enabled ? " on" : ""}`}>
      <div className="learn-phone-device">
        <div className="learn-phone-screen">{children}</div>
      </div>
    </div>
  );
}
