import { useCallback, useRef, useState } from "react";

/** Media callbacks must observe pause/seek intent before React commits it. */
export function usePlaybackIntent() {
  const [playing, updatePlaying] = useState(false);
  const requested = useRef(false);
  const setPlaying = useCallback((next: boolean) => {
    requested.current = next;
    updatePlaying(next);
  }, []);
  return { playing, setPlaying, requested };
}
