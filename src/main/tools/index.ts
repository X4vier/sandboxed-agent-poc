import type { AgentTool } from '../agent/types';
import {
  editFileTool,
  listFilesTool,
  readFileTool,
  searchFilesTool,
  writeFileTool,
} from './fileTools';
import { runJavascriptTool } from './runJavascript';
import { createReadDocumentTool } from './documentTools';
import { createExtractorRegistry } from '../documents';

/** The complete, fixed tool set available to the agent. */
export function buildTools(): AgentTool[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listFilesTool,
    searchFilesTool,
    createReadDocumentTool(createExtractorRegistry()),
    runJavascriptTool,
  ];
}
