/*
 * File: chat.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createDeepSeekStream, updateSessionParent } from '../services/deepseek.ts';
import { OpenAIRequest, ChoiceDelta, Message } from '../utils/types.ts';
import { robustParseJSON } from '../utils/json.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    
    // Extract the prompt
    let prompt = '';
    const messages = body.messages || [];
    let systemPrompt = '';
    
    // Build non-system messages list
    const nonSystemMsgs: Array<{ role: string; contentStr: string; orig: any }> = [];
    for (const msg of messages) {
      let contentStr = '';
      if (Array.isArray(msg.content)) {
        contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        contentStr = JSON.stringify(msg.content);
      } else {
        contentStr = msg.content || '';
      }

      if (msg.role === 'system') {
        systemPrompt += contentStr + '\n\n';
      } else {
        nonSystemMsgs.push({ role: msg.role, contentStr, orig: msg });
      }
    }

    // Smart windowing: keep first 3 + last 4 messages to avoid exceeding DeepSeek textarea limits (~15k chars)
    const MAX_PROMPT_CHARS = 14000;
    const KEEP_HEAD = 3; // always include (task is usually here)
    const KEEP_TAIL = 4; // always include (page content is usually here)
    let selectedMsgs = nonSystemMsgs;
    if (nonSystemMsgs.length > KEEP_HEAD + KEEP_TAIL) {
      const headMsgs = nonSystemMsgs.slice(0, KEEP_HEAD);
      const tailMsgs = nonSystemMsgs.slice(-KEEP_TAIL);
      const headLen = headMsgs.reduce((s, m) => s + m.contentStr.length, 0);
      const tailLen = tailMsgs.reduce((s, m) => s + m.contentStr.length, 0);
      if (headLen + tailLen > MAX_PROMPT_CHARS) {
        // Still too long — use only last message (page content)
        selectedMsgs = nonSystemMsgs.slice(-1);
      } else {
        selectedMsgs = [...headMsgs, ...tailMsgs];
      }
    }

    for (const { role, contentStr, orig } of selectedMsgs) {
      if (role === 'user') {
        prompt += `User: ${contentStr}\n\n`;
      } else if (role === 'assistant') {
        let assistantContent = contentStr;
        if (orig.reasoning_content) {
          assistantContent = `<think>\n${orig.reasoning_content}\n</think>\n${assistantContent}`;
        }
        if (orig.tool_calls && Array.isArray(orig.tool_calls)) {
          for (const tc of orig.tool_calls) {
            let args = tc.function?.arguments || '{}';
            if (typeof args !== 'string') args = JSON.stringify(args);
            assistantContent += `\n<tool_call>{"name": "${tc.function?.name}", "arguments": ${args}}</tool_call>`;
          }
        }
        prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      } else if (role === 'tool' || role === 'function') {
        prompt += `Tool Response (${orig.name || 'tool'}): ${contentStr}\n\n`;
      }
    }

    // Inject tools instructions
    const bodyAny = body as any;
    if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
      // Better formatting for tools
      const formattedTools = bodyAny.tools.map((t: any) => {
        if (t.type === 'function') {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters
          };
        }
        return t;
      });
      const toolsJson = JSON.stringify(formattedTools, null, 2);
      
      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nRULES:\n1. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n2. Do NOT output any other text after your <tool_call> blocks. Wait for the user to provide the tool response.\n3. The JSON must be valid and accurately follow the tool's parameters.\n\n`;
      
      if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
        const forcedTool = bodyAny.tool_choice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      }
    }

    // Handle response_format: json_schema / json_object
    const responseFormat = (body as any).response_format;
    let needsJson = false;
    if (responseFormat) {
      if (responseFormat.type === 'json_schema' || responseFormat.type === 'json_object') {
        needsJson = true;
        let jsonInstruction = '\n\nYou MUST respond with a valid JSON object and NOTHING else — no markdown fences, no explanation, no extra text. Just the raw JSON.';
        if (responseFormat.type === 'json_schema' && responseFormat.json_schema?.schema) {
          jsonInstruction += `\n\nThe JSON must conform to this schema:\n${JSON.stringify(responseFormat.json_schema.schema, null, 2)}`;
        }
        systemPrompt += jsonInstruction;
      }
    }

    const finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;

    const isThinkingModel = !body.model.includes('no-thinking');
    
    // A session is new if it doesn't have any assistant messages yet.
    // This handles cases where the first request has [System, User] messages.
    const isNewSession = !messages.some(m => m.role === 'assistant');

    console.log(`[chat] model=${body.model} stream=${isStream} msgs=${messages.length} selected=${selectedMsgs.length} promptLen=${finalPrompt.length} needsJson=${needsJson}`);

    // Empty response retry logic
    let stream: ReadableStream;
    let uiSessionId = '';
    let retries = 3;
    while (retries > 0) {
      try {
        // If it's a new session, force parent_message_id to null
        const result = await createDeepSeekStream(finalPrompt, isThinkingModel, isNewSession ? null : undefined);
        stream = result.stream;
        uiSessionId = result.uiSessionId;
        break; // Success
      } catch (err: any) {
        retries--;
        if (retries === 0) throw err;
        // Wait a bit before retrying
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const completionId = 'chatcmpl-' + uuidv4();
    const promptTokens = Math.ceil(finalPrompt.length / 3.5);

    // --- Shared stream parser ---
    // Parses the raw DeepSeek SSE stream and calls onChunk for each emitted piece.
    // onChunk receives: (type: 'reasoning'|'content'|'tool_call'|'done', payload)
    const parseDeepSeekStream = async (
      rawStream: ReadableStream,
      onChunk: (type: string, payload: any) => Promise<void>
    ) => {
      const reader = rawStream.getReader();
      const decoder = new TextDecoder();
      let currentAppendPath = '';
      let contentEmitBuffer = '';
      let insideTool = false;
      let toolCallCount = 0;
      let buf = '';
      const TOOL_START = '<tool_call>';
      const TOOL_END = '</tool_call>';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') { await onChunk('done', null); continue; }

          try {
            const chunk = JSON.parse(dataStr);

            // session tracking
            let dsMessageId: any = null;
            if (chunk.response_message_id) dsMessageId = chunk.response_message_id;
            else if (chunk.v?.response?.message_id) dsMessageId = chunk.v.response.message_id;
            else if (chunk.v?.message_id) dsMessageId = chunk.v.message_id;
            else if (chunk.message_id) dsMessageId = chunk.message_id;
            if (dsMessageId) updateSessionParent(uiSessionId, dsMessageId);

            if (typeof chunk.p === 'string') {
              currentAppendPath = chunk.p;
              if (chunk.p === 'response/accumulated_token_usage' && typeof chunk.v === 'number') {
                await onChunk('usage', chunk.v);
              }
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (typeof chunk.v === 'string') {
              vStr = chunk.v; foundStr = true;
            } else if (chunk.v && typeof chunk.v === 'object') {
              if (chunk.v.response?.fragments?.length > 0) {
                const frag = chunk.v.response.fragments[0];
                if (typeof frag.content === 'string') {
                  vStr = frag.content; foundStr = true;
                  currentAppendPath = frag.type === 'THINK' ? 'response/thinking_content' : 'response/content';
                }
              } else if (Array.isArray(chunk.v) && chunk.v.length > 0) {
                const firstObj = chunk.v[0];
                if (typeof firstObj.content === 'string') {
                  vStr = firstObj.content; foundStr = true;
                  currentAppendPath = firstObj.type === 'THINK' ? 'response/thinking_content' : 'response/content';
                }
              }
            }

            if (currentAppendPath.includes('thinking_content') || currentAppendPath.includes('THINK')) {
              isThinkingChunk = true;
            }

            if (!foundStr || vStr === '' || vStr === 'FINISHED') continue;

            if (isThinkingChunk) {
              await onChunk('reasoning', vStr);
            } else {
              contentEmitBuffer += vStr;
              while (contentEmitBuffer.length > 0) {
                if (!insideTool) {
                  const startIdx = contentEmitBuffer.indexOf(TOOL_START);
                  if (startIdx !== -1) {
                    const textToEmit = contentEmitBuffer.substring(0, startIdx);
                    if (textToEmit && toolCallCount === 0) await onChunk('content', textToEmit);
                    insideTool = true;
                    contentEmitBuffer = contentEmitBuffer.substring(startIdx + TOOL_START.length);
                    continue;
                  } else {
                    let flushIndex = contentEmitBuffer.length;
                    for (let i = 1; i <= TOOL_START.length; i++) {
                      if (contentEmitBuffer.endsWith(TOOL_START.substring(0, i))) {
                        flushIndex = contentEmitBuffer.length - i; break;
                      }
                    }
                    const textToEmit = contentEmitBuffer.substring(0, flushIndex);
                    if (textToEmit && toolCallCount === 0) await onChunk('content', textToEmit);
                    contentEmitBuffer = contentEmitBuffer.substring(flushIndex);
                    break;
                  }
                } else {
                  const endIdx = contentEmitBuffer.indexOf(TOOL_END);
                  if (endIdx !== -1) {
                    const toolJsonStr = contentEmitBuffer.substring(0, endIdx).trim();
                    try {
                      const toolCallObj = robustParseJSON(toolJsonStr);
                      if (!toolCallObj) throw new Error('empty');
                      await onChunk('tool_call', { index: toolCallCount, obj: toolCallObj });
                      toolCallCount++;
                    } catch {
                      if (toolCallCount === 0) await onChunk('content', TOOL_START + toolJsonStr + TOOL_END);
                    }
                    insideTool = false;
                    contentEmitBuffer = contentEmitBuffer.substring(endIdx + TOOL_END.length);
                  } else { break; }
                }
              }
            }
          } catch { /* ignore parse error */ }
        }
      }
      // flush remaining
      if (!insideTool && contentEmitBuffer.length > 0) {
        await onChunk('content', contentEmitBuffer);
      }
    };

    // --- Non-streaming path: collect and return JSON ---
    if (!isStream) {
      let reasoningContent = '';
      let content = '';
      const toolCallsResult: any[] = [];
      let completionTokens = 0;

      await parseDeepSeekStream(stream!, async (type, payload) => {
        if (type === 'reasoning') reasoningContent += payload;
        else if (type === 'content') content += payload;
        else if (type === 'usage') completionTokens = payload;
        else if (type === 'tool_call') {
          const { index, obj } = payload;
          toolCallsResult.push({
            index,
            id: 'call_' + uuidv4(),
            type: 'function',
            function: {
              name: obj.name || '',
              arguments: typeof obj.arguments === 'object' ? JSON.stringify(obj.arguments) : String(obj.arguments || '')
            }
          });
        }
      });

      // Strip <think> tags from content
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      // Extract JSON block if response_format requires it
      if (needsJson && content) {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) content = jsonMatch[0];
      }

      console.log(`[chat] non-stream response: contentLen=${content.length} toolCalls=${toolCallsResult.length} tokens=${completionTokens}`);

      const usage = {
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };

      const message: any = { role: 'assistant', content };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (toolCallsResult.length > 0) message.tool_calls = toolCallsResult;

      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message,
          finish_reason: toolCallsResult.length > 0 ? 'tool_calls' : 'stop',
          logprobs: null
        }],
        usage
      });
    }

    // --- Streaming path ---
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async (streamWriter: any) => {
      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0, delta, logprobs: null, finish_reason: finishReason
      });

      await writeEvent({
        id: completionId, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });

      let completionTokens = 0;
      let emittedToolCallCount = 0;

      await parseDeepSeekStream(stream!, async (type, payload) => {
        if (type === 'reasoning') {
          await writeEvent({
            id: completionId, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: body.model,
            choices: [makeChoice({ reasoning_content: payload })]
          });
        } else if (type === 'content') {
          await writeEvent({
            id: completionId, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: body.model,
            choices: [makeChoice({ content: payload })]
          });
        } else if (type === 'usage') {
          completionTokens = payload;
        } else if (type === 'tool_call') {
          const { index, obj } = payload;
          await writeEvent({
            id: completionId, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: body.model,
            choices: [makeChoice({
              tool_calls: [{
                index,
                id: 'call_' + uuidv4(),
                type: 'function',
                function: {
                  name: obj.name || '',
                  arguments: typeof obj.arguments === 'object' ? JSON.stringify(obj.arguments) : String(obj.arguments || '')
                }
              }]
            })]
          });
          emittedToolCallCount++;
        } else if (type === 'done') {
          await streamWriter.write('data: [DONE]\n\n');
        }
      });

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };

      await writeEvent({
        id: completionId, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [makeChoice({}, emittedToolCallCount > 0 ? 'tool_calls' : 'stop')],
        usage
      });
      await streamWriter.write('data: [DONE]\n\n');

    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    return c.json({ error: { message: err.message } }, 500);
  }
}
