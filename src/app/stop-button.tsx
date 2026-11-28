import { STOP_LABEL } from "@/lib/request-stop";

export function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <button className="button secondary stop-btn" type="button" aria-label={STOP_LABEL} onClick={onStop}>
      Stop
    </button>
  );
}
