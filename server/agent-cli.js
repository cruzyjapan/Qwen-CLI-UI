import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import sessionManager from './sessionManager.js';

// Track active processes by session ID for abort support
const activeProcesses = new Map();

// Helper to split args respecting simple quotes
function splitArgs(str) {
  if (!str) return [];
  const re = /([^\s'"]+)|'([^']*)'|"([^"]*)"/g;
  const out = [];
  let m;
  while ((m = re.exec(str)) !== null) {
    out.push(m[1] || m[2] || m[3] || '');
  }
  return out;
}

export async function spawnAgent(prompt, options = {}, ws) {
  // Called with prompt and options
  return new Promise(async (resolve, reject) => {
    let { sessionId, cwd, model, images, toolsSettings } = options;
    const workingDir = (cwd || process.cwd()).trim();

    // Create new session if not provided
    if (!sessionId) {
      sessionId = `agent_${Date.now()}`;
      sessionManager.createSession(sessionId, workingDir);

      // Notify client about new session
      ws?.send?.(JSON.stringify({
        type: 'session-created',
        sessionId: sessionId
      }));
    }

    // Save user message to session
    if (prompt && sessionId) {
      sessionManager.addMessage(sessionId, 'user', prompt);
    }

    if (!existsSync(workingDir)) {
      const msg = `Working directory does not exist: ${workingDir}`;
      ws?.send?.(JSON.stringify({ type: 'agent-error', error: msg }));
      return reject(new Error(msg));
    }

    const settings = toolsSettings || { skipPermissions: false };

    // Prepare temp dir and files
    const tempDir = path.join(workingDir, '.tmp', 'agent', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true }).catch(() => {});

    const promptFile = path.join(tempDir, 'prompt.txt');
    const promptText = prompt || '';
    await fs.writeFile(promptFile, promptText, 'utf8').catch(() => {});

    // Save images if provided
    const imagePaths = [];
    if (images && images.length > 0) {
      for (const [index, image] of images.entries()) {
        const matches = image.data?.match?.(/^data:([^;]+);base64,(.+)$/);
        if (!matches) continue;
        const [, mimeType, base64Data] = matches;
        const ext = (mimeType?.split('/')?.[1]) || 'png';
        const imgPath = path.join(tempDir, `image_${index}.${ext}`);
        await fs.writeFile(imgPath, Buffer.from(base64Data, 'base64')).catch(() => {});
        imagePaths.push(imgPath);
      }
    }

    // Build command using env template or generic pieces
    const template = process.env.AGENT_CMD_TEMPLATE || '';
    let command, args;

    if (template) {
      // String template mode executed via sh -lc
      const imagesJoined = imagePaths.join(' ');
      const skipFlag = (toolsSettings?.skipPermissions && process.env.AGENT_SKIP_PERMISSIONS_FLAG)
        ? process.env.AGENT_SKIP_PERMISSIONS_FLAG
        : '';
      const line = template
        .replaceAll('{prompt_file}', JSON.stringify(promptFile).slice(1, -1))
        .replaceAll('{cwd}', JSON.stringify(workingDir).slice(1, -1))
        .replaceAll('{model}', model || '')
        .replaceAll('{images}', imagesJoined)
        .replaceAll('{skip_permissions_flag}', skipFlag);
      command = 'bash';
      args = ['-lc', line];
    } else {
      // Arg array mode for simple cases (defaults mirror Qwen CLI)
      const bin = process.env.AGENT_BIN || process.env.QWEN_PATH || 'qwen';
      command = bin;
      args = [];

      // Optional subcommand (empty for qwen)
      const sub = process.env.AGENT_SUBCOMMAND;
      if (sub) args.push(sub);

      // Add --prompt flag with the prompt text for qwen
      args.push('--prompt', promptText);

      // Model flag
      const modelFlag = process.env.AGENT_MODEL_FLAG || '-m';
      if (model && modelFlag) args.push(modelFlag, model);

      // Permissions bypass flag if requested
      if (settings.skipPermissions && process.env.AGENT_SKIP_PERMISSIONS_FLAG) {
        args.push(process.env.AGENT_SKIP_PERMISSIONS_FLAG);
      }

      // Image flags
      const imgFlag = process.env.AGENT_IMAGE_FLAG; // e.g., -i
      if (imgFlag && imagePaths.length) {
        imagePaths.forEach(p => args.push(imgFlag, p));
      }

      // Extra args (space separated)
      const extra = splitArgs(process.env.AGENT_EXTRA_ARGS || '');
      args.push(...extra);
    }

    const env = {
      ...process.env,
      TERM: 'dumb',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CI: 'true'
    };

    // Spawning command with args in working directory

    const child = spawn(command, args, { cwd: workingDir, env });
    if (sessionId) activeProcesses.set(sessionId, child);

    // Buffer for accumulating output
    let outputBuffer = '';
    let bufferTimer = null;
    let fullResponse = ''; // Accumulate full response for session

    const flushBuffer = () => {
      if (outputBuffer) {
        // Sending output to client
        ws?.send?.(JSON.stringify({ type: 'qwen-output', data: outputBuffer }));
        fullResponse += outputBuffer; // Accumulate for session
        outputBuffer = '';
      }
    };

    const bufferAndSend = (data) => {
      outputBuffer += data;

      // Clear existing timer
      if (bufferTimer) clearTimeout(bufferTimer);

      // If we have a newline, flush immediately
      if (data.includes('\n')) {
        flushBuffer();
      } else {
        // Otherwise wait 100ms for more data
        bufferTimer = setTimeout(flushBuffer, 100);
      }
    };

    // Stream output with buffering
    child.stdout.on('data', (chunk) => {
      // Received stdout
      bufferAndSend(chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      // Received stderr
      bufferAndSend(chunk.toString());
    });

    child.on('close', (code, signal) => {
      // Flush any remaining buffer
      if (bufferTimer) clearTimeout(bufferTimer);
      flushBuffer();

      if (sessionId) {
        activeProcesses.delete(sessionId);
        // Save assistant response to session
        if (fullResponse) {
          sessionManager.addMessage(sessionId, 'assistant', fullResponse);
        }
      }
      // Notify completion in a format the frontend understands
      ws?.send?.(JSON.stringify({ type: 'qwen-complete', exitCode: code }));
      resolve({ code, signal });
    });

    // Handle spawn errors (e.g., binary not found)
    child.on('error', (err) => {
      if (sessionId) activeProcesses.delete(sessionId);
      ws?.send?.(JSON.stringify({ type: 'qwen-error', error: err.message }));
      // Also send a completion event to unblock any pending UI state
      ws?.send?.(JSON.stringify({ type: 'qwen-complete', exitCode: -1 }));
      resolve({ code: -1, signal: null, error: err.message });
    });

    // Close stdin immediately for qwen to prevent it from waiting for input
    if (!process.env.AGENT_CMD_TEMPLATE) {
      try {
        child.stdin.end();
      } catch {}
    }
  });
}

export function abortAgentSession(sessionId) {
  const child = activeProcesses.get(sessionId);
  if (!child) return false;
  try {
    child.kill('SIGTERM');
    activeProcesses.delete(sessionId);
    return true;
  } catch {
    return false;
  }
}
