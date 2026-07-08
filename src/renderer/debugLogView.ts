import type { AgentBridge, DebugLogStatus } from '../shared/ipc';
import type { Toast } from './dom';
import { errorMessage } from './dom';

interface DebugLogElements {
  debugLogEl: HTMLElement;
  debugLogLabel: HTMLElement;
  debugLogStopBtn: HTMLButtonElement;
}

export interface DebugLogView {
  refresh(): Promise<void>;
  refreshIfFileNamePending(): void;
}

export function createDebugLogView(
  agent: AgentBridge,
  elements: DebugLogElements,
  toast: Toast,
): DebugLogView {
  const { debugLogEl, debugLogLabel, debugLogStopBtn } = elements;
  let active = false;
  let fileName: string | null = null;

  function render(status: DebugLogStatus): void {
    active = status.active;
    fileName = status.fileName;
    debugLogEl.hidden = !status.active;
    debugLogLabel.textContent = status.fileName
      ? `● Debug log: ${status.fileName}`
      : '● Debug log: enabled';
  }

  async function refresh(): Promise<void> {
    render(await agent.debugLogStatus());
  }

  debugLogStopBtn.addEventListener('click', async () => {
    try {
      render(await agent.stopDebugLog());
    } catch (err) {
      toast.show(errorMessage(err), true);
    }
  });

  return {
    refresh,
    refreshIfFileNamePending(): void {
      if (active && fileName === null) void refresh();
    },
  };
}
