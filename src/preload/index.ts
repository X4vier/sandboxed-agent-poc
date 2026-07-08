import { contextBridge, ipcRenderer } from 'electron';
import type { AgentBridge, AgentEvent } from '../shared/ipc';

const bridge: AgentBridge = {
  hasApiKey: () => ipcRenderer.invoke('agent:hasApiKey'),
  setApiKey: (key) => ipcRenderer.invoke('agent:setApiKey', key),
  clearApiKey: () => ipcRenderer.invoke('agent:clearApiKey'),
  getEnvApiKey: () => ipcRenderer.invoke('agent:getEnvApiKey'),
  stageFiles: () => ipcRenderer.invoke('agent:stageFiles'),
  removeStagedFile: (path) => ipcRenderer.invoke('agent:removeStagedFile', path),
  listStagedFiles: () => ipcRenderer.invoke('agent:listStagedFiles'),
  isSeedIncluded: () => ipcRenderer.invoke('agent:isSeedIncluded'),
  setSeedIncluded: (included) => ipcRenderer.invoke('agent:setSeedIncluded', included),
  debugLogStatus: () => ipcRenderer.invoke('agent:debugLogStatus'),
  stopDebugLog: () => ipcRenderer.invoke('agent:stopDebugLog'),
  startTask: (task) => ipcRenderer.invoke('agent:startTask', task),
  cancelTask: () => ipcRenderer.invoke('agent:cancelTask'),
  onAgentEvent: (cb: (event: AgentEvent) => void) => {
    const listener = (_e: unknown, event: AgentEvent): void => cb(event);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
  listWorkspaceFiles: () => ipcRenderer.invoke('agent:listWorkspaceFiles'),
  getWorkspaceFile: (path) => ipcRenderer.invoke('agent:getWorkspaceFile', path),
  exportFile: (path) => ipcRenderer.invoke('agent:exportFile', path),
  exportAll: () => ipcRenderer.invoke('agent:exportAll'),
};

contextBridge.exposeInMainWorld('agent', bridge);
