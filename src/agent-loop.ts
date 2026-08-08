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
import { LocalLLMClient, ChatMessage, ToolDefinition } from './client';
import { McpManager, parseToolCall, buildToolSystemPrompt } from './mcp';
import { BUILTIN_TOOLS, isBuiltinTool, executeBuiltinTool } from './builtin-tools';
import { parseComposerResponse, applyComposerPatches } from './editor';
import { findRelevantContext, resolveMentions, resolveWebSearch, resolveSlashCommand } from './context';
import { RagIndex, ConversationRag } from './rag';
import { DocsIndex } from './docs-index';
import { ChatSession } from './session';
import { estimateHistoryTokens, getNonSystemMessages, isCompactMarker, COMPACT_EXTRACTION_PROMPT, buildExtractionInput } from './utils';

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
  /** Returns the auto-detected context window size from the provider, or null if not yet known. */
  getContextLength?: () => number | null;
  /** Returns the last text editor that had focus before the webview took over, so file context survives typing in the input box. */
  getActiveEditor?: () => vscode.TextEditor | undefined;
  /** Resolves the API key and wire format for the active provider from SecretStorage. */
  resolveProviderConfig?: (url: string, useOllama: boolean) => Promise<{ key: string | undefined; authType: import('./providers').AuthType; providerFormat: import('./providers').ProviderFormat }>;
}

export class AgentLoop {
  private _client?: LocalLLMClient;
  private _abortController?: AbortController;
  private _backups = new Map<string, string | null>();

  constructor(private readonly deps: AgentLoopDeps) {}

  /** Aborts any in-progress stream, sending *Cancelled.* to the webview. */
  abort() { this._abortController?.abort(); }

  /** Aborts silently — no *Cancelled.* message sent. Use when switching sessions programmatically. */
  silentAbort() { this._silent = true; this._abortController?.abort(); }
  private _silent = false;

  /** Returns the file snapshots taken before agent writes this turn (path → original content, null = new file). */
  getBackups(): Map<string, string | null> { return this._backups; }

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
    this._backups.clear();
    this._silent = false;

    // Web search and slash commands take priority over normal message processing
    const webSearchResult = await resolveWebSearch(rawText);
    const text = webSearchResult ?? await resolveSlashCommand(rawText);

    // Direct responses (sentinel \x00 prefix) bypass the model entirely
    if (text.startsWith('\x00')) {
      session.history.push({ role: 'user', content: rawText, images });
      saveState();
      updateUsageDisplay();
      this.deps.postMessage({ type: 'chunk', text: text.slice(1) });
      this.deps.postMessage({ type: 'status', text: 'Ready' });
      return;
    }

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
    const resolved = await this.deps.resolveProviderConfig?.(apiUrl, useOllamaFormat);
    const apiKey = resolved?.key ?? (config.get<string>('apiKey', '') || undefined);
    this._client = new LocalLLMClient(apiUrl, model, useOllamaFormat, apiKey, resolved?.authType, resolved?.providerFormat);

    // Assemble context from RAG, @ mentions, and the active file
    const autoFiles = new Set<string>();
    const autoContext = await findRelevantContext(text, autoFiles);
    const manualFiles = new Set<string>();
    const manualContext = await resolveMentions(text, manualFiles, this.deps.docs);
    const allUsedFiles = new Set([...autoFiles, ...manualFiles]);
    const editor = this.deps.getActiveEditor?.() ?? vscode.window.activeTextEditor;
    let activeFileContext = '';
    if (editor) {
      const name = editor.document.fileName.split(/[\\\/]/).pop() || '';
      allUsedFiles.add(name);
      const content = editor.document.getText();
      const lines = content.split('\n');
      const truncated = lines.length > 300 ? lines.slice(0, 300).join('\n') + '\n[...truncated]' : content;
      activeFileContext = `[Currently open file — use as reference/context: ${name}]\n${truncated}\n`;
    }
    // Only show explicitly @-mentioned files in the UI chips — auto-context is an implementation detail
    this.deps.postMessage({ type: 'filesUsed', files: [...manualFiles].map(name => ({ name, tokens: 0 })) });

    const planInstructions = 'You are in PLAN mode. Be conversational and helpful — not every message needs a formal plan. Match your tone to the message: brief for casual questions, thorough for design and architecture. When the user wants to design, scope, or think through a feature, help them break it down. Do NOT write files, execute commands, or call any tools. When the user is ready to implement, suggest they switch to BUILD mode.';
    const buildInstructions = 'You are in BUILD mode. Use tools to read files, write code, and execute tasks. Prefer action over explanation. IMPORTANT: before modifying or appending to an existing file, always call read_file first to get its current content — never assume you know what is already in the file.';
    const modeInstructions = mode === 'build' ? buildInstructions : planInstructions;

    // Inject or patch system prompt. Only write when content changes — keeping the system
    // message identical between turns lets local runtimes (Ollama, LM Studio, llama.cpp)
    // reuse the KV-cache prefix without any provider-specific API parameter.
    const memory = this.deps.getMemory();
    const memorySection = memory.trim() ? `\n\nUSER MEMORY:\n${memory.trim()}` : '';
    const customSection = session.systemPrompt?.trim() ? `\n\nSESSION INSTRUCTIONS:\n${session.systemPrompt.trim()}` : '';
    const sysIdx = session.history.findIndex(m => m.role === 'system' && !isCompactMarker(m));
    if (sysIdx === -1) {
      session.history.unshift({ role: 'system', content: modeInstructions + memorySection + customSection });
    } else {
      const sys = session.history[sysIdx];
      const stripped = sys.content.replace(/^(You are in (PLAN|BUILD) mode\..*?(?=\n\n|$))/s, '').trimStart();
      const newContent = modeInstructions + (stripped ? '\n\n' + stripped : '');
      if (newContent !== sys.content) {
        session.history[sysIdx] = { ...sys, content: newContent };
      }
    }

    const toolsOn = config.get<boolean>('agentEnabled', true) && (session.agentEnabled ?? false);
    const ragContext = (toolsOn && this.deps.rag?.isIndexed()) ? await this.deps.rag.queryAsync(text) : '';
    // Retrieve relevant earlier turns — gives the model access to compacted history via BM25
    const convRag = new ConversationRag();
    convRag.build(session.history);
    const convContext = convRag.query(text);
    const contextPrompt = `CONTEXT:\n${ragContext ? `CODEBASE:\n${ragContext}\n\n` : ''}${convContext ? `EARLIER CONVERSATION (relevant):\n${convContext}\n\n` : ''}${autoContext}\n${manualContext}\n${activeFileContext}\n\nUSER: ${text}`;
    // Strip any empty-content messages — they cause jinja template errors on some models (e.g. gemma-4)
    let messagesForApi: ChatMessage[] = ([...session.history, { role: 'user' as const, content: contextPrompt, images }])
      // Keep role:'tool' messages even if empty — removing them orphans the preceding tool_calls
      // assistant message, which is a hard validation error for OpenAI and Anthropic.
      .filter(m => m.role === 'tool' || m.content.trim().length > 0);

    // Auto-compact the stored session history when context fills up.
    // Threshold is lower for local providers (VRAM constrained) and even lower when recent
    // turns are large (heavy tool output / file reads accelerate KV-cache overflow).
    const isLocal = useOllamaFormat || apiUrl.includes('127.0.0.1') || apiUrl.includes('localhost');
    const recentMsgs = getNonSystemMessages(session.history).slice(-6);
    const avgRecentTokens = recentMsgs.length
      ? recentMsgs.reduce((s, m) => s + m.content.length / 4, 0) / recentMsgs.length
      : 0;
    const isHeavySession = avgRecentTokens > 600;
    const compactThreshold = isLocal ? (isHeavySession ? 0.55 : 0.65) : 0.82;
    const pricing = config.get<Record<string, any>>('modelPricing') || {};
    const modelKey = Object.keys(pricing).find(k => model.toLowerCase().includes(k.toLowerCase()));
    const p = modelKey ? pricing[modelKey] : { context: 8192 };
    // Use the same context length source as the display so compact fires at the same % the user sees.
    const detectedCtx = this.deps.getContextLength?.() ?? null;
    const limit = (detectedCtx ?? p.context ?? 8192) * compactThreshold;
    const estimatedTokens = JSON.stringify(messagesForApi).length / 4;
    if (estimatedTokens > limit && getNonSystemMessages(session.history).length > 3) {
      this.deps.postMessage({ type: 'compacting' });
      // Extract a structured summary of the messages about to be trimmed so the model
      // can reconstruct context from typed facts rather than losing it entirely.
      const toTrim = getNonSystemMessages(session.history).slice(0, -4);
      let compactSummary = '';
      if (toTrim.length > 0 && this._client) {
        try {
          const convText = buildExtractionInput(toTrim);
          compactSummary = await this._client.chat(
            [{ role: 'system', content: COMPACT_EXTRACTION_PROMPT }, { role: 'user', content: convText }],
            AbortSignal.timeout(20000)
          );
        } catch { /* fall back to plain marker if extraction times out or fails */ }
      }
      const sys = session.history.find(m => m.role === 'system' && !isCompactMarker(m));
      const lastMessages = getNonSystemMessages(session.history).slice(-4);
      const markerContent = compactSummary ? `__compacted__\n\n${compactSummary}` : '__compacted__';
      const marker: ChatMessage = { role: 'system', content: markerContent };
      session.history = sys ? [sys, marker, ...lastMessages] : [marker, ...lastMessages];
      session.tokens.input = estimateHistoryTokens(session.history);
      session.tokens.output = 0;
      messagesForApi = [...session.history, { role: 'user', content: contextPrompt, images }];
      saveState();
      this.deps.postMessage({ type: 'compacted' });
    }
    session.history.push({ role: 'user', content: rawText, images });
    saveState();
    updateUsageDisplay();

    const globalAgentEnabled = config.get<boolean>('agentEnabled', true);
    const agentEnabled = globalAgentEnabled && (session.agentEnabled ?? false);
    await this.deps.mcp.waitForReady(3000); // give MCP servers a moment to handshake
    const mcpTools = this.deps.mcp.getAllTools();
    const allTools = (agentEnabled && mode === 'build') ? [...BUILTIN_TOOLS, ...mcpTools] : [];
    const isCompose = text.trimStart().startsWith('/compose');

    // Simple stream — no tools configured, or plan mode (tools suppressed)
    if (!allTools.length || mode === 'plan') {
      try {
        const { text: fullText } = await this._client.streamChatWithCallback(messagesForApi, (chunk) => {
          this.deps.postMessage({ type: 'chunk', text: chunk });
        }, this._abortController.signal);
        if (isCompose) {
          const patches = parseComposerResponse(fullText);
          if (patches.length > 0) await applyComposerPatches(patches);
        }
        // If the model output a tool call but Tools is off, nudge the user
        if (mode !== 'plan' && parseToolCall(fullText)) {
          const modelName = config.get<string>('model') || 'your model';
          this.deps.postMessage({ type: 'toolsOffNudge', model: modelName });
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          if (!this._silent) { this.deps.postMessage({ type: 'chunk', text: '\n\n*Cancelled.*' }); }
          this._silent = false;
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

      /**
       * Builds the two-message feedback pair to append after a tool call outcome
       * (denial, unknown tool, or successful execution).
       * Native path: assistant message carries tool_calls + feedback as role:'tool'
       * so the conversation stays valid for OpenAI / Anthropic / Ollama native APIs.
       * Heuristic path: plain assistant + user messages (existing behaviour).
       */
      const buildFeedback = (
        tc: { id: string; name: string; args: Record<string, any> } | undefined,
        assistantText: string,
        feedbackContent: string
      ): [ChatMessage, ChatMessage] => {
        if (tc) {
          return [
            { role: 'assistant', content: assistantText, tool_calls: [{ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }] },
            { role: 'tool', content: feedbackContent, tool_call_id: tc.id }
          ];
        }
        return [
          { role: 'assistant', content: assistantText },
          { role: 'user', content: feedbackContent }
        ];
      };
      // Only inject text-based tool instructions when native tool calling hasn't been confirmed for
      // this session. When native works, the provider handles tool descriptions via the tools array.
      if (!session.nativeToolsWorked) {
        const toolSuffix = buildToolSystemPrompt(allTools);
        if (toolMessages[0]?.role === 'system') {
          toolMessages[0] = { ...toolMessages[0], content: toolMessages[0].content + toolSuffix };
        } else {
          toolMessages = [{ role: 'system', content: toolSuffix.trimStart() }, ...toolMessages];
        }
      }

      const MAX_ROUNDS = config.get<number>('agentMaxIterations', 20);
      let consecutiveNoOp = 0;
      let toolCallMade = false;
      let repromptsLeft = 1;
      let trustAll = false;
      let hitMaxRounds = false;

      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (round === MAX_ROUNDS - 1) hitMaxRounds = true;
        if (this._abortController.signal.aborted) break;

        const result = await this._streamWithToolDetection(toolMessages, toolCallMade, allTools as ToolDefinition[]);
        const fullText = result.text;
        // If the provider dropped tools mid-session (e.g. Ollama 500 on malformed tool JSON),
        // reset nativeToolsWorked so heuristic instructions are re-injected next turn.
        if (result.toolsDropped) session.nativeToolsWorked = false;
        // Native tool call (Layer 1/2) takes priority; fall back to heuristic parser (Layer 5)
        const nativeTc = result.toolCall;
        const parsed = nativeTc
          ? { tool: nativeTc.name, args: nativeTc.args, raw: '' }
          : parseToolCall(fullText);

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
          if (fullText.trim()) {
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
          if (consecutiveNoOp >= 2) {
            this.deps.postMessage({ type: 'chunk', text: '\n\n*Agent called an unknown tool repeatedly and could not complete the task. Try rephrasing your request.*' });
            break;
          }
          toolMessages = [...toolMessages, ...buildFeedback(nativeTc, fullText, `Tool "${parsed.tool}" does not exist. Available: ${allTools.map(t => t.name).join(', ')}. Try again or answer without tools.`)];
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
            toolMessages = [...toolMessages, ...buildFeedback(nativeTc, fullText, `The user denied \`${parsed.tool}\`. Do not retry this action. Ask the user what they'd like to do instead, or try a different approach.`)];
            this.deps.postMessage({ type: 'toolDenied', tool: parsed.tool });
            continue;
          }
        }

        this.deps.postMessage({ type: 'clearToolCallChunk', raw: parsed.raw });
        this.deps.postMessage({ type: 'toolCall', tool: parsed.tool });

        let rawResult: string;
        try {
          rawResult = isBuiltinTool(parsed.tool)
            ? await executeBuiltinTool(parsed.tool, parsed.args, this._backups)
            : await this.deps.mcp.callTool(parsed.tool, parsed.args);
        } catch (e: any) {
          rawResult = `Error: ${e.message}`;
        }

        this.deps.appendTaskLog(session.id, parsed.tool, parsed.args, rawResult);
        toolCallMade = true;

        // Update permanent history so follow-up turns have context of what was done
        if (nativeTc) {
          // Native path: use proper role:'tool' feedback so the provider's conversation format stays valid
          session.nativeToolsWorked = true;
          const assistantMsg: ChatMessage = {
            role: 'assistant', content: fullText,
            tool_calls: [{ id: nativeTc.id, type: 'function', function: { name: nativeTc.name, arguments: JSON.stringify(nativeTc.args) } }]
          };
          const toolResultMsg: ChatMessage = { role: 'tool', content: rawResult, tool_call_id: nativeTc.id };
          session.history.push(assistantMsg);
          session.history.push(toolResultMsg);
          toolMessages = [...toolMessages, assistantMsg, toolResultMsg];
        } else {
          // Heuristic path: wrap result in a user message so any model can understand it
          session.history.push({ role: 'assistant', content: fullText });
          session.history.push({ role: 'user', content: `Tool \`${parsed.tool}\` returned:\n\`\`\`\n${rawResult}\n\`\`\`` });
          toolMessages = [...toolMessages,
            { role: 'assistant', content: fullText },
            { role: 'user', content: `Tool \`${parsed.tool}\` returned:\n\`\`\`\n${rawResult}\n\`\`\`` }
          ];
        }
        session.tokens.output += fullText.length / 4;
        session.tokens.input += rawResult.length / 4;
        saveState();
        updateUsageDisplay();
      }
      if (hitMaxRounds) {
        this.deps.postMessage({ type: 'chunk', text: `\n\n*Agent reached the maximum number of tool-call rounds (${MAX_ROUNDS}). Review the results and continue if needed.*` });
      }
    } catch (e: any) {
      // On abort, trim any trailing assistant/tool message pairs that have no following user
      // message — they were committed mid-loop and would cause a validation error next turn.
      if (e?.name === 'AbortError') {
        while (session.history.length > 0) {
          const last = session.history[session.history.length - 1];
          if (last.role === 'tool' || last.role === 'assistant') {
            session.history.pop();
          } else break;
        }
      }
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
    jsonMode = false,
    tools?: ToolDefinition[]
  ): Promise<{ text: string; toolCall?: { id: string; name: string; args: Record<string, any> }; proseStreamed: boolean; toolsDropped?: boolean }> {
    let inThink = false;
    let proseStreamed = false;
    let accumulatedText = '';

    const result = await this._client!.streamChatWithCallback(messages, (chunk) => {
      accumulatedText += chunk;
      if (jsonMode) return; // mid-task: suppress all streaming

      // Stream thinking tokens live so the user can see the model is working
      if (!inThink && accumulatedText.includes('<think>')) inThink = true;
      if (inThink) {
        this.deps.postMessage({ type: 'chunk', text: chunk });
        proseStreamed = true;
        if (accumulatedText.includes('</think>')) inThink = false;
      }
    }, this._abortController?.signal, jsonMode, tools);

    return { text: result.text, toolCall: result.toolCall, proseStreamed, toolsDropped: result.toolsDropped };
  }
}

