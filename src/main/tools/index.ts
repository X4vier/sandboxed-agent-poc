import type { AgentTool } from '../agent/types';
import {
  editFileTool,
  listFilesTool,
  readFileTool,
  searchFilesTool,
  writeFileTool,
} from './fileTools';
import { runJavascriptTool } from './runJavascript';

/** The complete, fixed tool set available to the agent. */
export function buildTools(): AgentTool[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listFilesTool,
    searchFilesTool,
    runJavascriptTool,
  ];
}
