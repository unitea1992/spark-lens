import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../server/types.ts";

export type Link = "connecting" | "live" | "lost";

/**
 * Subscribes to the server's snapshot stream. EventSource reconnects on its
 * own; `link` reports whether what is on screen is current.
 */
export function useSnapshot(): { snapshot: Snapshot | null; link: Link; now: number } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [link, setLink] = useState<Link>("connecting");
  const [now, setNow] = useState(() => Date.now());
  const lastMessage = useRef(0);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onmessage = (event) => {
      try {
        setSnapshot(JSON.parse(event.data) as Snapshot);
        lastMessage.current = Date.now();
        setLink("live");
      } catch {
        // Ignore a malformed frame; the next one replaces it.
      }
    };
    source.onerror = () => setLink("lost");
    return () => source.close();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      // A stream that stays open but goes quiet (sleeping laptop, stalled
      // proxy) never fires onerror.
      if (lastMessage.current > 0 && t - lastMessage.current > 30_000) setLink("lost");
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return { snapshot, link, now };
}
