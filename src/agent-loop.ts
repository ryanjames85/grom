/**
 * agent-loop.ts
 *
 * The agentic execution loop — runs tool calls until the model produces a final answer.
 *
 * AgentLoop is constructed with a set of dependency callbacks so it stays decoupled from
 * provider.ts. Provider owns the webview, session state, and approval UI; AgentLoop only
 * knows how to stream, detect tool calls, execute them, and feed results back.
 *
 * Flow per round:
 *   1. Stream model response, watching for a JSON tool-call block
 *   2. If no tool call → final answer, stream prose to webview and return
 *   3. If tool call → validate, request approval if destructive, execute, feed result back
 *   4. Repeat up to MAX_ROUNDS
 *
 * NOTE: This file uses vscode only for config reading and active editor detection.
 * All webview communication goes through the postMessage callback.
 */

import * as vscode from 'vscode';
import { LocalLLMClient, ChatMessage } from './client';
import { McpManager, parseToolCall, buildToolSystemPrompt } from './mcp';
import { BUILTIN_TOOLS, isBuiltinTool, executeBuiltinTool } from './builtin-tools';
import { parseComposerResponse, applyComposerPatches } from './editor';
import { findRelevantContext, resolveMentions, resolveWebSearch, resolveSlashCommand } from './context';
import { RagIndex } from './rag';
import { DocsIndex } from './docs-index';
import { ChatSession } from './session';
import { estimateHistoryTokens, getNonSystemMessages } from './utils';

/** Tools that modify state and require user approval before execution. */
const DESTRUCTIVE_TOOLS = new Set(['write_file', 'delete_file', 'run_terminal']);

export interface AgentLoopDeps {
  mcp: McpManager;
  rag?: RagIndex;
  docs?: DocsIndex;
  /** Posts a message to the webview. */
  postMessage: (msg: any) => void;
  /** Pauses the loop and asks the user for Allow / Allow All / Deny. */
  requestApproval: (id: string, tool: string, args: Record<string, any>) => Promise<'allow' | 'allowAll' | 'deny'>;
  /** Records a completed tool call in the session task log. */
  appendTaskLog: (sessionId: string, tool: string, args: Record<string, any>, result: string) => void;
  /** Returns the user's persistent memory string. */
  getMemory: () => string;
}

export class AgentLoop {
  private _client?: LocalLLMClient;
  private _abortController?: AbortController;

  constructor(private readonly deps: AgentLoopDeps) {}

  /** Aborts any in-progress stream. */
  abort() { this._abortController?.abort(); }

  /**
   * Resolves context, builds the message list, then runs the agentic loop for a single user turn.
   * Writes streaming chunks and status updates via deps.postMessage.
   */
  async run(
    rawText: string,
    images: string[] | undefined,
    mode: 'plan' | 'build',
    session: ChatSession,
    saveState: () => void,
    updateUsageDisplay: () => void
  ): Promise<void> {
    // Web search and slash commands take priority over normal message processing
    const webSearchResult = await resolveWebSearch(rawText);
    const text = webSearchResult ?? await resolveSlashCommand(rawText);

    this._abortController?.abort();
    this._abortController = new AbortController();

    const config = vscode.workspace.getConfiguration('grom');
    const apiUrl = config.get<string>('apiUrl') || 'http://127.0.0.1:11434';
    const baseModel = config.get<string>('model') || 'qwen2.5-coder';
    const activeLang = vscode.window.activeTextEditor?.document.languageId || '';
    const chatLangModels = config.get<Record<string, string>>('chatLanguageModels', {});
    const fallbackLangModels = config.get<Record<string, string>>('languageModels', {});
    const model = chatLangModels[activeLang] || fallbackLangModels[activeLang] || baseModel;
    const useOllamaFormat = config.get<boolean>('useOllamaFormat') || false;
    this._client = new LocalLLMClient(apiUrl, model, useOllamaFormat);

    // Assemble context from RAG, @ mentions, and the active file
    const usedFiles = new Set<string>();
    const autoContext = await findRelevantContext(text, usedFiles);
    const manualContext = await resolveMentions(text, usedFiles, this.deps.docs);
    const editor = vscode.window.activeTextEditor;
    let activeFileContext = '';
    if (editor) {
      const name = editor.document.fileName.split(/[\\\/]/).pop() || '';
      usedFiles.add(name);
      const content = editor.document.getText();
      const lines = content.split('\n');
      const truncated = lines.length > 300 ? lines.slice(0, 300).join('\n') + '\n[...truncated]' : content;
      activeFileContext = `[Currently open file — use as reference/context: ${name}]\n${truncated}\n`;
    }
    this.deps.postMessage({ type: 'filesUsed', files: [...usedFiles].map(name => ({ name, tokens: 0 })) });

    const planInstructions = 'You are in PLAN mode. Your job is to understand, scope, and plan the user\'s request — not to execute it. Respond with analysis, architecture, and step-by-step plans. Do NOT write files, execute commands, or call any tools. When the plan is ready or the user asks to implement it, tell them to switch to BUILD mode using the toggle at the top of the chat.';
    const buildInstructions = 'You are in BUILD mode. Use tools to read files, write code, and execute tasks. Prefer action over explanation. IMPORTANT: before modifying or appending to an existing file, always call read_file first to get its current content — never assume you know what is already in the file.';
    const modeInstructions = mode === 'build' ? buildInstructions : planInstructions;

    // Inject or patch system prompt every turn
    const memory = this.deps.getMemory();
    const memorySection = memory.trim() ? `\n\nUSER MEMORY:\n${memory.trim()}` : '';
    const customSection = session.systemPrompt?.trim() ? `\n\nSESSION INSTRUCTIONS:\n${session.systemPrompt.trim()}` : '';
    const sysIdx = session.history.findIndex(m => m.role === 'system' && m.content !== '__compacted__');
    if (sysIdx === -1) {
      // No system message — inject at front (handles new sessions and old corrupted sessions)
      session.history.unshift({ role: 'system', content: modeInstructions + memorySection + customSection });
    } else {
      // Patch mode instructions when user switches modes mid-session
      const sys = session.history[sysIdx];
      const stripped = sys.content.replace(/^(You are in (PLAN|BUILD) mode\..*?(?=\n\n|$))/s, '').trimStart();
      session.history[sysIdx] = { ...sys, content: modeInstructions + (stripped ? '\n\n' + stripped : '') };
    }

    const ragContext = this.deps.rag?.isIndexed() ? await this.deps.rag.queryAsync(text) : '';
    const contextPrompt = `CONTEXT:\n${ragContext ? `CODEBASE:\n${ragContext}\n\n` : ''}${autoContext}\n${manualContext}\n${activeFileContext}\n\nUSER: ${text}`;
    // Strip any empty-content messages — they cause jinja template errors on some models (e.g. gemma-4)
    let messagesForApi: ChatMessage[] = ([...session.history, { role: 'user' as const, content: contextPrompt, images }])
      .filter(m => m.content.trim().length > 0);

    // Auto-compact the stored session history if over 90% of the context window
    const pricing = config.get<Record<string, any>>('modelPricing') || {};
    const modelKey = Object.keys(pricing).find(k => model.toLowerCase().includes(k.toLowerCase()));
    const p = modelKey ? pricing[modelKey] : { context: 8192 };
    const limit = (p.context || 8192) * 0.9;
    const estimatedTokens = JSON.stringify(messagesForApi).length / 4;
    if (estimatedTokens > limit && session.history.length > 3) {
      // Compact the real session history so the next turn starts fresh
      const sys = session.history.find(m => m.role === 'system' && m.content !== '__compacted__');
      const lastMessages = getNonSystemMessages(session.history).slice(-4);
      const marker: ChatMessage = { role: 'system', content: '__compacted__' };
      session.history = sys ? [sys, marker, ...lastMessages] : [marker, ...lastMessages];
      session.tokens.input = estimateHistoryTokens(session.history);
      session.tokens.output = 0;
      messagesForApi = [...session.history, { role: 'user', content: contextPrompt, images }];
      this.deps.postMessage({ type: 'compacting' });
      saveState();
    }
    session.history.push({ role: 'user', content: rawText, images });
    saveState();
    updateUsageDisplay();

    const agentEnabled = config.get<boolean>('agentEnabled', true);
    const mcpTools = this.deps.mcp.getAllTools();
    const allTools = (agentEnabled && mode === 'build') ? [...BUILTIN_TOOLS, ...mcpTools] : mcpTools;
    const isCompose = text.trimStart().startsWith('/compose');

    // Simple stream — no tools configured, or plan mode (tools suppressed)
    if (!allTools.length || mode === 'plan') {
      try {
        const fullText = await this._client.streamChatWithCallback(messagesForApi, (chunk) => {
          this.deps.postMessage({ type: 'chunk', text: chunk });
        }, this._abortController.signal);
        if (isCompose) {
          const patches = parseComposerResponse(fullText);
          if (patches.length > 0) await applyComposerPatches(patches);
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          this.deps.postMessage({ type: 'chunk', text: '\n\n*Cancelled.*' });
        } else {
          const msg: string = e.message || String(e);
          const isContextOverflow = /n_keep|n_ctx|context.*(length|size|window)|too many tokens|context_length_exceeded/i.test(msg);
          this.deps.postMessage({ type: 'chunk', text: isContextOverflow
            ? `**Context too large for this model.**\n\nThe model's context window is too small. Try:\n- A model with larger context\n- \`/compact\` to trim history\n- Fewer \`@file\` mentions`
            : `\n\n**Error:** ${msg}` });
        }
      }
      this.deps.postMessage({ type: 'status', text: 'Ready' });
      return;
    }

    // Agentic loop — tools available
    try {
      let toolMessages = [...messagesForApi];
      const toolSuffix = buildToolSystemPrompt(allTools);
      if (toolMessages[0]?.role === 'system') {
        toolMessages[0] = { ...toolMessages[0], content: toolMessages[0].content + toolSuffix };
      } else {
        toolMessages = [{ role: 'system', content: toolSuffix.trimStart() }, ...toolMessages];
      }

      const MAX_ROUNDS = config.get<number>('agentMaxIterations', 20);
      let consecutiveNoOp = 0;
      let toolCallMade = false;
      let repromptsLeft = 1;
      let trustAll = false;

      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (this._abortController.signal.aborted) break;

        const { fullText, proseStreamed } = await this._streamWithToolDetection(toolMessages, toolCallMade);
        const parsed = parseToolCall(fullText);

        if (!parsed) {
          // Model wrote prose without calling a tool — nudge it once, but ONLY on the very first
          // turn before any tool has been called. After a tool succeeds, prose = task complete.
          if (!toolCallMade && repromptsLeft > 0 && fullText.trim()) {
            repromptsLeft--;
            toolMessages = [...toolMessages,
              { role: 'assistant', content: fullText },
              { role: 'user', content: `You need to use a tool to complete this task. Do not explain — call a tool now. Available tools: ${allTools.map(t => t.name).join(', ')}.` }
            ];
            continue;
          }
          if (!proseStreamed && fullText.trim()) {
            this.deps.postMessage({ type: 'chunk', text: fullText });
          }
          if (isCompose) {
            const patches = parseComposerResponse(fullText);
            if (patches.length > 0) await applyComposerPatches(patches);
          }
          this.deps.postMessage({ type: 'status', text: 'Ready' });
          return;
        }

        // Unknown tool — tell the model and retry once
        const toolKnown = isBuiltinTool(parsed.tool) || mcpTools.some(t => t.name === parsed.tool);
        if (!toolKnown) {
          consecutiveNoOp++;
          if (consecutiveNoOp >= 2) break;
          toolMessages = [...toolMessages,
            { role: 'assistant', content: fullText },
            { role: 'user', content: `Tool "${parsed.tool}" does not exist. Available: ${allTools.map(t => t.name).join(', ')}. Try again or answer without tools.` }
          ];
          continue;
        }
        consecutiveNoOp = 0;

        // Request approval for destructive tools and all MCP tools (unless user said Allow All)
        const needsApproval = !trustAll && (DESTRUCTIVE_TOOLS.has(parsed.tool) || !isBuiltinTool(parsed.tool));
        if (needsApproval) {
          const approvalId = `${Date.now()}-${round}`;
          const signal = this._abortController!.signal;
          const abortPromise = new Promise<'deny'>(res => signal.addEventListener('abort', () => res('deny'), { once: true }));
          const decision = await Promise.race([this.deps.requestApproval(approvalId, parsed.tool, parsed.args), abortPromise]);
          if (signal.aborted) break;
          if (decision === 'allowAll') { trustAll = true; }
          if (decision === 'deny') {
            toolMessages = [...toolMessages,
              { role: 'assistant', content: fullText },
              { role: 'user', content: `The user denied \`${parsed.tool}\`. Do not retry this action. Ask the user what they'd like to do instead, or try a different approach.` }
            ];
            this.deps.postMessage({ type: 'toolDenied', tool: parsed.tool });
            continue;
          }
        }

        this.deps.postMessage({ type: 'toolCall', tool: parsed.tool });

        let rawResult: string;
        try {
          rawResult = isBuiltinTool(parsed.tool)
            ? await executeBuiltinTool(parsed.tool, parsed.args)
            : await this.deps.mcp.callTool(parsed.tool, parsed.args);
        } catch (e: any) {
          rawResult = `Error: ${e.message}`;
        }

        toolCallMade = true;
        this.deps.appendTaskLog(session.id, parsed.tool, parsed.args, rawResult);

        toolMessages = [...toolMessages,
          { role: 'assistant', content: fullText },
          { role: 'user', content: `Tool \`${parsed.tool}\` returned:\n\`\`\`\n${rawResult}\n\`\`\`` }
        ];
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        const msg: string = e.message || String(e);
        const isContextOverflow = /n_keep|n_ctx|context.*(length|size|window)|too many tokens|context_length_exceeded/i.test(msg);
        const display = isContextOverflow
          ? `**Context too large for this model.**\n\nThe model's context window is too small for the current conversation or context. Try:\n- A model with a larger context (e.g. set a higher context in LM Studio)\n- Using \`/compact\` to trim history\n- Removing large \`@file\` mentions`
          : `\n*Error: ${msg}*\n`;
        this.deps.postMessage({ type: 'chunk', text: display });
      }
    }

    this.deps.postMessage({ type: 'status', text: 'Ready' });
  }

  /**
   * Streams a model response and returns the full text once complete.
   * Thinking blocks (<think>...</think>) are posted to the UI as they arrive.
   * Everything else is buffered — tool-call detection happens on the complete text
   * after streaming finishes, avoiding false positives from mid-stream JSON fragments.
   * When jsonMode is true (mid-task), even thinking blocks are suppressed.
   */
  private async _streamWithToolDetection(
    messages: ChatMessage[],
    jsonMode = false
  ): Promise<{ fullText: string; proseStreamed: boolean }> {
    let inThink = false;
    let thinkBuffer = '';
    let proseStreamed = false;

    const fullText = await this._client!.streamChatWithCallback(messages, (chunk) => {
      if (jsonMode) return; // mid-task: suppress all streaming, just accumulate

      // Stream thinking tokens live so the user can see the model is working
      if (!inThink && chunk.includes('<think>')) inThink = true;
      if (inThink) {
        thinkBuffer += chunk;
        if (chunk.includes('</think>')) {
          inThink = false;
          this.deps.postMessage({ type: 'chunk', text: thinkBuffer });
          proseStreamed = true;
          thinkBuffer = '';
        }
        return;
      }
      // Non-thinking content is buffered — posted all at once after tool-call check
    }, this._abortController?.signal, jsonMode);

    return { fullText, proseStreamed };
  }
}

