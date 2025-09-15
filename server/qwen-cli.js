import { spawn, execSync } from 'child_process';
import { promises as fs } from 'fs';
import { existsSync, readlinkSync, lstatSync } from 'fs';
import path from 'path';
import os from 'os';
import sessionManager from './sessionManager.js';

let activeQwenProcesses = new Map(); // Track active processes by session ID

async function spawnQwen(command, options = {}, ws) {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, resume, toolsSettings, permissionMode, images } = options;
    let capturedSessionId = sessionId; // Track session ID throughout the process
    let sessionCreatedSent = false; // Track if we've already sent session-created event
    
    // Process images if provided
    
    // Use tools settings passed from frontend, or defaults
    const settings = toolsSettings || {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false
    };
    
    // Use tools settings
    
    // Build Qwen CLI command - use exec subcommand
    const args = ['exec'];  // Use exec subcommand
    
    // Store prompt to pass via stdin
    let promptText = null;
    if (command && command.trim()) {
      promptText = command;
    }
    
    // Use cwd (actual project directory) instead of projectPath (Qwen's metadata directory)
    // Clean the path by removing any non-printable characters
    const cleanPath = (cwd || process.cwd()).replace(/[^\x20-\x7E]/g, '').trim();
    const workingDir = cleanPath;
    
    // Check if working directory exists
    if (!existsSync(workingDir)) {
      const errorMessage = `Working directory does not exist: ${workingDir}\n\n` +
        `The project directory has been deleted or moved.\n` +
        `Please select a different project or restore the directory.`;
      
      console.error('[Qwen] Working directory not found:', workingDir);
      
      ws.send(JSON.stringify({
        type: 'qwen-error',
        error: errorMessage,
        errorType: 'directory_not_found'
      }));
      
      reject(new Error(errorMessage));
      return;
    }
    
    // Debug - workingDir
    
    // Handle images by saving them to temporary files and passing paths to Qwen
    const tempImagePaths = [];
    let tempDir = null;
    if (images && images.length > 0) {
      try {
        // Create temp directory in the project directory so Qwen can access it
        tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
        await fs.mkdir(tempDir, { recursive: true });
        
        // Save each image to a temp file
        for (const [index, image] of images.entries()) {
          // Extract base64 data and mime type
          const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
          if (!matches) {
            // console.error('Invalid image data format');
            continue;
          }
          
          const [, mimeType, base64Data] = matches;
          const extension = mimeType.split('/')[1] || 'png';
          const filename = `image_${index}.${extension}`;
          const filepath = path.join(tempDir, filename);
          
          // Write base64 data to file
          await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
          tempImagePaths.push(filepath);
        }
        
        // Include the full image paths in the prompt for Qwen to reference
        // Add image paths as -i flags for Qwen CLI
        if (tempImagePaths.length > 0) {
          for (const imagePath of tempImagePaths) {
            args.push('-i', imagePath);
          }
        }
        
        
      } catch (error) {
        // console.error('Error processing images for Qwen:', error);
      }
    }
    
    // Qwen doesn't support resume functionality
    // Skip resume handling
    
    // Qwen uses different config system (config.toml)
    // Configuration is handled via -c flags or config profiles
    // No need to check for MCP servers as Qwen handles this internally
    
    // Add model for all sessions (both new and resumed)
    const modelToUse = options.model || 'gpt-5';
    args.push('-m', modelToUse);
    
    // Add reasoning effort if provided (for GPT-5)
    if (modelToUse === 'gpt-5') {
      const reasoningEffort = options.reasoningEffort || 'medium';
      args.push('-c', `reasoning_effort="${reasoningEffort}"`);
    }
    
    // Add skip git check flag to avoid "not trusted directory" error
    args.push('--skip-git-repo-check');
    
    // Add danger flag if skipPermissions is enabled
    if (settings.skipPermissions) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    
    // Debug output
    console.log('\n[Qwen CLI]', {
      model: modelToUse,
      reasoningEffort: modelToUse === 'gpt-5' ? (options.reasoningEffort || 'medium') : 'N/A',
      workDir: workingDir,
      hasPrompt: !!promptText,
      sessionId: sessionId || 'new'
    });
    
    // Note: exec subcommand doesn't support -C flag, will use cwd instead
    
    // Try to find qwen in PATH first, then fall back to environment variable
    let qwenPath = process.env.QWEN_PATH || 'qwen';
    
    // Resolve the actual path if it's a symlink or check if it's a .js file
    let actualCommand = qwenPath;
    let actualArgs = args;
    
    try {
      // Check if the path exists and is a symlink
      if (existsSync(qwenPath)) {
        const stats = lstatSync(qwenPath);
        if (stats.isSymbolicLink()) {
          // Resolve the symlink to get the actual .js file
          qwenPath = readlinkSync(qwenPath);
          if (!path.isAbsolute(qwenPath)) {
            // If relative, resolve it relative to the symlink's directory
            const linkDir = path.dirname(process.env.QWEN_PATH || 'qwen');
            qwenPath = path.resolve(linkDir, qwenPath);
          }
        }
      }
      
      // If it's a .js file, use node to execute it
      if (qwenPath.endsWith('.js')) {
        // Verify the file exists and is readable
        if (!existsSync(qwenPath)) {
          throw new Error(`Resolved qwen.js file not found: ${qwenPath}`);
        }
        
        actualCommand = process.execPath; // Use the same node binary that's running this process
        actualArgs = [qwenPath, ...args];
        console.log('[Qwen] Using Node.js to execute:');
        console.log('  Node path:', actualCommand);
        console.log('  Script path:', qwenPath);
        console.log('  Script exists:', existsSync(qwenPath));
        console.log('  Arguments:', args.join(' '));
      } else {
        console.log('[Qwen] Direct execution:', qwenPath, args.join(' '));
      }
    } catch (e) {
      // If we can't resolve, try to execute as-is
      console.log('[Qwen] Could not resolve path, trying direct execution:', qwenPath);
    }
    
    console.log('[Qwen] Final command:', actualCommand, actualArgs.join(' '), '< [prompt via stdin]');
    
    // Set environment variables for non-TTY execution
    const processEnv = {
      ...process.env,
      TERM: 'dumb',  // Disable terminal features
      NO_COLOR: '1',  // Disable color output
      FORCE_COLOR: '0',  // Ensure no color
      CI: 'true'  // Many tools respect CI environment
    };
    
    let qwenProcess;
    
    // Double-check working directory exists before spawning
    if (!existsSync(workingDir)) {
      const errorMessage = `Working directory was deleted during operation: ${workingDir}\n\n` +
        `The project directory no longer exists.\n` +
        `Please select a different project or restore the directory.`;
      
      ws.send(JSON.stringify({
        type: 'qwen-error',
        error: errorMessage,
        errorType: 'directory_not_found'
      }));
      
      reject(new Error(errorMessage));
      return;
    }
    
    // Final spawn configuration
    const spawnOptions = {
      cwd: workingDir,  // Set working directory via cwd
      stdio: ['pipe', 'pipe', 'pipe'],  // Use pipe for stdin to send prompt
      env: processEnv,
      shell: false  // Don't use shell since we're handling the execution directly
    };
    
    console.log('[Qwen] Spawn configuration:', {
      command: actualCommand,
      args: actualArgs,
      cwd: spawnOptions.cwd,
      shell: spawnOptions.shell
    });
    
    try {
      qwenProcess = spawn(actualCommand, actualArgs, spawnOptions);
      
      // Check if process was created successfully
      if (qwenProcess && qwenProcess.pid) {
        console.log('[Qwen] Process spawned successfully with PID:', qwenProcess.pid);
      } else {
        console.error('[Qwen] Process spawned but no PID assigned');
      }
    } catch (spawnError) {
      console.error('[Qwen] Failed to spawn process:', spawnError);
      const errorMessage = `Failed to start Qwen CLI: ${spawnError.message}\n\n` +
        `Please ensure Qwen CLI is installed and accessible.\n` +
        `You can either:\n` +
        `1. Install Qwen CLI globally: npm install -g @qwen-code/qwen-code\n` +
        `2. Set QWEN_PATH environment variable to the full path of the qwen executable\n` +
        `3. Add the qwen executable to your system PATH\n` +
        `Current QWEN_PATH: ${process.env.QWEN_PATH || '(not set)'}`;
      
      ws.send(JSON.stringify({
        type: 'qwen-error',
        error: errorMessage
      }));
      reject(new Error(errorMessage));
      return;
    }
    
    // Attach temp file info to process for cleanup later
    qwenProcess.tempImagePaths = tempImagePaths;
    qwenProcess.tempDir = tempDir;
    
    // Store process reference for potential abort
    const processKey = capturedSessionId || sessionId || Date.now().toString();
    activeQwenProcesses.set(processKey, qwenProcess);
    // Debug - Stored Qwen process with key
    
    // Store sessionId on the process object for debugging
    qwenProcess.sessionId = processKey;
    
    // Send prompt via stdin for exec subcommand
    if (promptText) {
      qwenProcess.stdin.write(promptText);
      qwenProcess.stdin.write('\n');
      qwenProcess.stdin.end();
    } else {
      qwenProcess.stdin.end();
    }
    
    // Add timeout handler
    let hasReceivedOutput = false;
    const timeoutMs = 60000; // 60 seconds for GPT-5 with reasoning
    const timeout = setTimeout(() => {
      if (!hasReceivedOutput) {
        console.error('[Qwen] Timeout - no output received after', timeoutMs, 'ms');
        ws.send(JSON.stringify({
          type: 'qwen-error',
          error: 'Qwen CLI timeout - no response received'
        }));
        qwenProcess.kill('SIGTERM');
      }
    }, timeoutMs);
    
    // Save user message to session when starting
    if (command && capturedSessionId) {
      sessionManager.addMessage(capturedSessionId, 'user', command);
    }
    
    // For new sessions, create a session ID
    if (!sessionId && !sessionCreatedSent && !capturedSessionId) {
      capturedSessionId = `qwen_${Date.now()}`;
      sessionCreatedSent = true;
      
      // Create session in session manager
      sessionManager.createSession(capturedSessionId, cwd || process.cwd());
      
      // Save the user message now that we have a session ID
      if (command) {
        sessionManager.addMessage(capturedSessionId, 'user', command);
      }
      
      // Update process key with captured session ID
      if (processKey !== capturedSessionId) {
        activeQwenProcesses.delete(processKey);
        activeQwenProcesses.set(capturedSessionId, qwenProcess);
      }
      
      ws.send(JSON.stringify({
        type: 'session-created',
        sessionId: capturedSessionId
      }));
    }
    
    // Handle stdout - clean and reliable approach
    let outputBuffer = '';
    let fullResponse = '';
    let seenContent = false;
    let pendingOutput = '';
    let inThinkingBlock = false;
    let thinkingSent = false;
    let headerComplete = false;
    let messageBuffer = '';
    
    qwenProcess.stdout.on('data', (data) => {
      const rawOutput = data.toString('utf8'); // Ensure UTF-8 encoding
      outputBuffer += rawOutput;
      hasReceivedOutput = true;
      clearTimeout(timeout);
      
      // Add to pending output
      pendingOutput += rawOutput;
    });
    
    // Process output periodically with proper buffering
    const outputInterval = setInterval(() => {
      if (!pendingOutput) return;
      
      // Split into lines, preserving incomplete lines
      const lines = pendingOutput.split('\n');
      let keepLastLine = false;
      
      // Check if last chunk ends with newline
      if (!pendingOutput.endsWith('\n') && lines.length > 0) {
        keepLastLine = true;
      }
      
      const linesToProcess = keepLastLine ? lines.slice(0, -1) : lines;
      const remainingLine = keepLastLine ? lines[lines.length - 1] : '';
      
      for (const line of linesToProcess) {
        // Skip header section until we see actual content
        if (!headerComplete) {
          // System headers to skip
          if (line.match(/^\[\d{4}-\d{2}-\d{2}/) || // Timestamps like [2025-08-30]
              line.match(/^Reading prompt from stdin/) ||
              line.includes('OpenAI Qwen v') ||
              line.match(/^-{3,}$/) || // Separator lines
              line.match(/^(workdir|model|provider|approval|sandbox|reasoning):\s*/) ||
              line.includes('User instructions:') ||
              line.includes('Not inside a trusted directory')) {
            continue;
          }
          
          // Skip the echoed prompt
          if (promptText && line.trim() === promptText.trim()) {
            continue;
          }
          
          // Empty line after headers
          if (!line.trim()) {
            continue;
          }
          
          // If we reach here with content, headers are done
          if (line.trim()) {
            headerComplete = true;
          }
        }
        
        // Handle thinking blocks
        if (line.match(/\[.*\]\s*thinking/i)) {
          inThinkingBlock = true;
          if (!thinkingSent) {
            // Send any buffered content before thinking status
            if (messageBuffer.trim()) {
              ws.send(JSON.stringify({
                type: 'qwen-response',
                data: {
                  type: 'message',
                  content: messageBuffer.trim()
                }
              }));
              fullResponse += messageBuffer.trim() + '\n';
              messageBuffer = '';
            }
            
            ws.send(JSON.stringify({
              type: 'qwen-status',
              status: 'thinking'
            }));
            thinkingSent = true;
          }
          continue;
        }
        
        // Exit thinking block when we see 'qwen' marker
        if (inThinkingBlock) {
          if (line.match(/\[.*\]\s*qwen/i)) {
            inThinkingBlock = false;
            continue;
          }
          // Skip all content in thinking block
          continue;
        }
        
        // Skip token usage lines
        if (line.match(/tokens used:\s*\d+/i)) {
          continue;
        }
        
        // Skip timestamps after content started
        if (headerComplete && line.match(/^\[\d{4}-\d{2}-\d{2}/)) {
          continue;
        }
        
        // Add actual content to buffer
        if (headerComplete && !inThinkingBlock) {
          // Skip leading empty lines in message buffer
          if (!messageBuffer && !line.trim()) {
            continue;
          }
          messageBuffer += line + '\n';
        }
      }
      
      // Send buffered content periodically
      if (messageBuffer.length > 100 || // Send if we have enough content
          (!keepLastLine && messageBuffer.trim())) { // Or if we have complete lines
        const contentToSend = messageBuffer.trim();
        if (contentToSend) {
          ws.send(JSON.stringify({
            type: 'qwen-response',
            data: {
              type: 'message',
              content: contentToSend
            }
          }));
          fullResponse += contentToSend + '\n';
          messageBuffer = '';
        }
      }
      
      // Keep incomplete line for next iteration
      pendingOutput = remainingLine;
    }, 100); // 100ms for better batching
    
    // Handle stderr
    qwenProcess.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      // Log stderr only if not a deprecation warning
      if (!errorMsg.includes('DEP0040') && 
          !errorMsg.includes('DeprecationWarning')) {
        console.log('[STDERR]:', errorMsg);
      }
      
      // Filter out non-error messages
      if (errorMsg.includes('[DEP0040]') || 
          errorMsg.includes('DeprecationWarning') ||
          errorMsg.includes('--trace-deprecation') ||
          errorMsg.includes('Reading prompt from stdin')) {
        // Log but don't send to client
        return;
      }
      
      // Only send actual errors to client
      if (errorMsg.trim() && !errorMsg.includes('Reading prompt')) {
        ws.send(JSON.stringify({
          type: 'qwen-error',
          error: errorMsg
        }));
      }
    });
    
    // Handle process completion
    qwenProcess.on('close', async (code) => {
      // console.log(`Qwen CLI process exited with code ${code}`);
      clearTimeout(timeout);
      clearInterval(outputInterval);
      
      // Send any remaining buffered content
      let finalContent = messageBuffer;
      if (pendingOutput) {
        finalContent += pendingOutput;
      }
      
      if (finalContent.trim()) {
        // Clean up final content
        const lines = finalContent.split('\n')
          .filter(line => 
            !line.match(/tokens used:\s*\d+/i) &&
            !line.match(/^\[\d{4}-\d{2}-\d{2}/) &&
            !line.includes('thinking')
          );
        
        const cleanContent = lines.join('\n').trim();
        if (cleanContent) {
          ws.send(JSON.stringify({
            type: 'qwen-response',
            data: {
              type: 'message',
              content: cleanContent
            }
          }));
          fullResponse += cleanContent;
        }
      }
      
      // Clean up process reference
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeQwenProcesses.delete(finalSessionId);
      
      // Save assistant response to session if we have one
      if (finalSessionId && fullResponse) {
        sessionManager.addMessage(finalSessionId, 'assistant', fullResponse);
      }
      
      ws.send(JSON.stringify({
        type: 'qwen-complete',
        exitCode: code,
        isNewSession: !sessionId && !!command // Flag to indicate this was a new session
      }));
      
      // Clean up temporary image files if any
      if (qwenProcess.tempImagePaths && qwenProcess.tempImagePaths.length > 0) {
        for (const imagePath of qwenProcess.tempImagePaths) {
          await fs.unlink(imagePath).catch(err => {
            // console.error(`Failed to delete temp image ${imagePath}:`, err)
          });
        }
        if (qwenProcess.tempDir) {
          await fs.rm(qwenProcess.tempDir, { recursive: true, force: true }).catch(err => {
            // console.error(`Failed to delete temp directory ${qwenProcess.tempDir}:`, err)
          });
        }
      }
      
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Qwen CLI exited with code ${code}`));
      }
    });
    
    // Handle process errors
    qwenProcess.on('error', (error) => {
      console.error('[Qwen] Process error:', error);
      console.error('[Qwen] Error details:', {
        code: error.code,
        message: error.message,
        command: actualCommand,
        args: actualArgs,
        cwd: workingDir,
        qwenPath: qwenPath
      });
      
      let errorMessage = `Qwen process error: ${error.message}`;
      
      // Check if the error is due to missing working directory
      if (error.code === 'ENOENT' && !existsSync(workingDir)) {
        errorMessage = `Working directory not found: ${workingDir}\n\n` +
          `The project directory has been deleted or moved.\n` +
          `This can happen when:\n` +
          `- The directory was deleted while the UI was open\n` +
          `- The directory was moved to a different location\n` +
          `- The directory is on a network drive that's no longer accessible\n\n` +
          `Please select a different project or restore the directory.`;
          
        ws.send(JSON.stringify({
          type: 'qwen-error',
          error: errorMessage,
          errorType: 'directory_not_found'
        }));
        
        // Clean up
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeQwenProcesses.delete(finalSessionId);
        
        // Clean up temp files if they exist
        if (qwenProcess && qwenProcess.tempDir) {
          cleanupTempFiles(qwenProcess);
        }
        
        reject(error);
        return;
      }
      
      // Provide more helpful error message for ENOENT (qwen not found)
      if (error.code === 'ENOENT') {
        errorMessage = `Qwen CLI not found\n\n` +
          `The 'qwen' command could not be found on your system.\n\n` +
          `Please ensure Qwen CLI is installed:\n` +
          `1. Install Qwen CLI: npm install -g @openai/qwen\n` +
          `2. If installed in a custom location, set QWEN_PATH environment variable:\n` +
          `   export QWEN_PATH=/path/to/qwen\n` +
          `3. Or add the qwen executable to your system PATH\n\n` +
          `Current QWEN_PATH: ${process.env.QWEN_PATH || '(not set)'}\n` +
          `Attempted command: ${actualCommand}\n` +
          `Resolved path: ${qwenPath}`;
      }
      
      // Clean up process reference on error
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeQwenProcesses.delete(finalSessionId);
      
      ws.send(JSON.stringify({
        type: 'qwen-error',
        error: errorMessage
      }));
      
      // Clean up temp files if they exist
      if (qwenProcess && qwenProcess.tempDir) {
        cleanupTempFiles(qwenProcess);
      }
      
      reject(error);
    });
    
    // stdin handling is already done above
  });
}

function abortQwenSession(sessionId) {
  // Debug - Attempting to abort Qwen session
  // Debug - Active processes
  
  // Try to find the process by session ID or any key that contains the session ID
  let process = activeQwenProcesses.get(sessionId);
  let processKey = sessionId;
  
  if (!process) {
    // Search for process with matching session ID in keys
    for (const [key, proc] of activeQwenProcesses.entries()) {
      if (key.includes(sessionId) || sessionId.includes(key)) {
        process = proc;
        processKey = key;
        break;
      }
    }
  }
  
  if (process) {
    // Debug - Found process for session
    try {
      // First try SIGTERM
      process.kill('SIGTERM');
      
      // Set a timeout to force kill if process doesn't exit
      setTimeout(() => {
        if (activeQwenProcesses.has(processKey)) {
          // Debug - Process didn't terminate, forcing kill
          try {
            process.kill('SIGKILL');
          } catch (e) {
            // console.error('Error force killing process:', e);
          }
        }
      }, 2000); // Wait 2 seconds before force kill
      
      activeQwenProcesses.delete(processKey);
      return true;
    } catch (error) {
      // console.error('Error killing process:', error);
      activeQwenProcesses.delete(processKey);
      return false;
    }
  }
  
  // Debug - No process found for session
  return false;
}

export {
  spawnQwen,
  abortQwenSession
};