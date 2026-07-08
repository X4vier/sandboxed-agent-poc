import type { AgentBridge, WorkspaceFileInfo } from '../shared/ipc';
import type { Toast } from './dom';
import { el, errorMessage, fmtBytes } from './dom';

interface WorkspaceElements {
  workspaceEl: HTMLElement;
  saveAllBtn: HTMLButtonElement;
  saveFileBtn: HTMLButtonElement;
  viewer: HTMLElement;
  viewerPath: HTMLElement;
  viewerBody: HTMLElement;
}

export interface WorkspaceView {
  clearSelection(): void;
  refresh(): Promise<void>;
}

export function createWorkspaceView(
  agent: AgentBridge,
  elements: WorkspaceElements,
  toast: Toast,
): WorkspaceView {
  const { workspaceEl, saveAllBtn, saveFileBtn, viewer, viewerPath, viewerBody } = elements;
  let selectedPath: string | null = null;

  function render(files: WorkspaceFileInfo[]): void {
    workspaceEl.replaceChildren();
    saveAllBtn.disabled = files.length === 0;
    if (files.length === 0) {
      workspaceEl.append(el('div', 'empty', 'No files yet.'));
      return;
    }
    for (const file of files) {
      const row = el('div', 'ws-row');
      if (file.path === selectedPath) row.classList.add('selected');
      row.append(
        el('span', `badge ${file.status}`, file.status),
        el('span', 'name', file.path),
        el('span', 'size', fmtBytes(file.size)),
      );
      row.addEventListener('click', () => void openFile(file.path));
      workspaceEl.append(row);
    }
  }

  async function refresh(): Promise<void> {
    render(await agent.listWorkspaceFiles());
  }

  async function openFile(path: string): Promise<void> {
    selectedPath = path;
    try {
      const content = await agent.getWorkspaceFile(path);
      viewer.hidden = false;
      viewerPath.textContent = path;
      viewerBody.textContent = content;
    } catch (err) {
      toast.show(errorMessage(err), true);
    }
    await refresh();
  }

  saveFileBtn.addEventListener('click', async () => {
    if (!selectedPath) return;
    try {
      const result = await agent.exportFile(selectedPath);
      if (result.saved) toast.show(`Saved to ${result.path}`);
    } catch (err) {
      toast.show(errorMessage(err), true);
    }
  });

  saveAllBtn.addEventListener('click', async () => {
    try {
      const result = await agent.exportAll();
      if (result.saved) toast.show(`Saved ${result.count} file(s) to ${result.dir}`);
    } catch (err) {
      toast.show(errorMessage(err), true);
    }
  });

  return {
    clearSelection(): void {
      selectedPath = null;
      viewer.hidden = true;
    },
    refresh,
  };
}
