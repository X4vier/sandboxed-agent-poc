import type { AgentBridge, StagedFileInfo } from '../shared/ipc';
import type { Toast } from './dom';
import { el, errorMessage, fmtBytes } from './dom';

interface StagingElements {
  stagedEl: HTMLElement;
  stagedCountEl: HTMLElement;
  addBtn: HTMLButtonElement;
}

export interface StagingView {
  refresh(): Promise<void>;
  setRunning(running: boolean): void;
}

export function createStagingView(
  agent: AgentBridge,
  elements: StagingElements,
  toast: Toast,
): StagingView {
  const { stagedEl, stagedCountEl, addBtn } = elements;
  let running = false;
  let seedIncluded = true;

  function fileRow(file: StagedFileInfo): HTMLElement {
    const row = el('div', 'staged-row');
    row.append(el('span', 'name', file.name), el('span', 'size', fmtBytes(file.size)));
    const removeBtn = el('button', 'x', '✕');
    removeBtn.title = 'Remove';
    removeBtn.disabled = running;
    removeBtn.addEventListener('click', async () => {
      render(await agent.removeStagedFile(file.path));
    });
    row.append(removeBtn);
    return row;
  }

  function renderSeedGroup(seed: StagedFileInfo[]): HTMLElement {
    const group = el('div', `seed-group${seedIncluded ? '' : ' excluded'}`);

    const header = el('label', 'seed-toggle');
    const checkbox = el('input', 'seed-checkbox') as HTMLInputElement;
    checkbox.type = 'checkbox';
    checkbox.checked = seedIncluded;
    checkbox.disabled = running;
    checkbox.addEventListener('change', async () => {
      seedIncluded = await agent.setSeedIncluded(checkbox.checked);
      await refresh();
    });
    header.append(
      checkbox,
      el('span', 'seed-title', 'Default documents'),
      el('span', 'count', `(${seed.length})`),
    );
    group.append(header);

    group.append(
      el(
        'div',
        'seed-caption',
        seedIncluded
          ? 'Bundled country reference docs — included in the workspace'
          : 'Bundled country reference docs — excluded from the workspace',
      ),
    );

    const details = el('details', 'seed-files');
    details.append(el('summary', undefined, `Show ${seed.length} files`));
    for (const file of seed) details.append(fileRow(file));
    group.append(details);
    return group;
  }

  function render(files: StagedFileInfo[]): void {
    stagedEl.replaceChildren();
    const seed = files.filter((file) => file.origin === 'seed');
    const user = files.filter((file) => file.origin === 'user');
    const effective = (seedIncluded ? seed.length : 0) + user.length;
    stagedCountEl.textContent = effective > 0 ? `(${effective})` : '';

    if (seed.length === 0 && user.length === 0) {
      stagedEl.append(el('div', 'empty', 'Nothing staged.'));
      return;
    }
    if (seed.length > 0) stagedEl.append(renderSeedGroup(seed));
    for (const file of user) stagedEl.append(fileRow(file));
  }

  async function refresh(): Promise<void> {
    const [included, files] = await Promise.all([agent.isSeedIncluded(), agent.listStagedFiles()]);
    seedIncluded = included;
    render(files);
  }

  addBtn.addEventListener('click', async () => {
    try {
      render(await agent.stageFiles());
    } catch (err) {
      toast.show(errorMessage(err), true);
      render(await agent.listStagedFiles());
    }
  });

  return {
    refresh,
    setRunning(next: boolean): void {
      running = next;
      addBtn.disabled = next;
      void refresh();
    },
  };
}
