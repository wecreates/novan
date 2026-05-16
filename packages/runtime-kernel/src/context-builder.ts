/**
 * Context builder — assembles relevant context from memory, events, and data
 * for AI-enhanced workflow steps.
 */

export interface WorkflowContext {
  workspaceId:   string
  workflowId:    string
  runId:         string
  stepId:        string
  input:         Record<string, unknown>
  memory?:       string[]  // relevant memory snippets
  recentEvents?: string[]  // recent event summaries
}

export function buildSystemPrompt(context: WorkflowContext): string {
  const lines = [
    `You are an AI agent executing a workflow step.`,
    `Workspace: ${context.workspaceId}`,
    `Workflow: ${context.workflowId}`,
    `Step: ${context.stepId}`,
  ]
  if (context.memory?.length) {
    lines.push(`\nRelevant memory:\n${context.memory.slice(0, 5).join('\n')}`)
  }
  if (context.recentEvents?.length) {
    lines.push(`\nRecent events:\n${context.recentEvents.slice(0, 3).join('\n')}`)
  }
  return lines.join('\n')
}
