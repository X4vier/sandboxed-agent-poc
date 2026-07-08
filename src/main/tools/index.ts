import type { AgentTool } from '../agent/types';
import { readTool } from './read';
import { writeTool } from './write';
import { editTool } from './edit';
import { globTool } from './globTool';
import { grepTool } from './grep';
import { listFilesTool } from './listFiles';
import { runJavascriptTool } from './runJavascript';
import { createReadDocumentTool } from './documentTools';
import { createExtractorRegistry } from '../documents';
import { todoWriteTool } from './todoTools';
import { taskTool } from './task';

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
    todoWriteTool,
    taskTool,
  ];
}
