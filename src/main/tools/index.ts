import type { AgentTool } from '../agent/types';
import {
  editTool,
  globTool,
  grepTool,
  listFilesTool,
  readTool,
  writeTool,
} from './fileTools';
import { runJavascriptTool } from './runJavascript';
import { createReadDocumentTool } from './documentTools';
import { createExtractorRegistry } from '../documents';

/** The complete, fixed tool set available to the agent. */
export function buildTools(): AgentTool[] {
  return [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    listFilesTool,
    createReadDocumentTool(createExtractorRegistry()),
    runJavascriptTool,
  ];
}
