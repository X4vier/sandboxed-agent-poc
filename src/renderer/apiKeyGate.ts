import type { AgentBridge } from '../shared/ipc';
import type { Toast } from './dom';
import { errorMessage } from './dom';

interface ApiKeyGateElements {
  gate: HTMLElement;
  gateForm: HTMLFormElement;
  gateError: HTMLElement;
  apiKeyInput: HTMLInputElement;
  changeKeyBtn: HTMLButtonElement;
}

export interface ApiKeyGate {
  check(): Promise<void>;
  open(): Promise<void>;
}

export function createApiKeyGate(
  agent: AgentBridge,
  elements: ApiKeyGateElements,
  toast: Toast,
): ApiKeyGate {
  const { gate, gateForm, gateError, apiKeyInput, changeKeyBtn } = elements;

  async function open(): Promise<void> {
    gate.hidden = false;
    gateError.hidden = true;
    apiKeyInput.value = (await agent.getEnvApiKey()) ?? '';
    apiKeyInput.focus();
    apiKeyInput.select();
  }

  gateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const key = apiKeyInput.value.trim();
    if (key.length === 0) {
      gateError.textContent = 'Enter a key to continue.';
      gateError.hidden = false;
      return;
    }
    try {
      await agent.setApiKey(key);
      apiKeyInput.value = '';
      gate.hidden = true;
      toast.show('API key set for this session.');
    } catch (err) {
      gateError.textContent = errorMessage(err);
      gateError.hidden = false;
    }
  });

  changeKeyBtn.addEventListener('click', async () => {
    await agent.clearApiKey();
    await open();
  });

  return {
    open,
    async check(): Promise<void> {
      if (!(await agent.hasApiKey())) await open();
    },
  };
}
